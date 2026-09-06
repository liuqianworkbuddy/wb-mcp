/**
 * wb-cli · table 命令族（三期 A 段 · dt_dod7ui）
 * ------------------------------------------------
 *   table list                     按域分组列出全部业务表（附行数，尽力而为）
 *   table schema <表名>            列定义（列名 + 类型）
 *   table domains                  域分组一览（离线，纯白名单）
 *
 * schema 双通道：
 *   ① 本地 cloudbase/migrations/*.sql 解析（CREATE TABLE + ALTER ADD COLUMN，
 *      离线、快、与线上 DDL 同源）；缺表时 ② live 行推断（拉 1 行取 keys）。
 * table list 行数：网关不透传 Content-Range（已实测），GET 行数计数：
 *   有数据表 select=id&limit=5001 截断计数；空表/失败 → 降级「-」不报错。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DOMAIN_TABLES, ALL_TABLES, renderTable, idColOf,
} from './shared.mjs';

/* ============================================================
 * migrations schema 解析（离线通道 ①）
 * ============================================================ */

/** 解析 cloudbase/migrations/*.sql → { 表名: [{col, type, extra}] }
 *  CREATE TABLE 多行体逐行取「列名 类型」；ALTER TABLE ADD COLUMN 追加；
 *  建表语句内嵌约束（PRIMARY/FOREIGN/UNIQUE/CHECK/CONSTRAINT/EXCLUDE）跳过。 */
export function parseMigrationsSchema(ROOT) {
  const dir = join(ROOT, 'cloudbase', 'migrations');
  const cols = new Map();
  const push = (table, col, type, extra = '') => {
    if (!cols.has(table)) cols.set(table, []);
    const list = cols.get(table);
    if (!list.some((c) => c.col === col)) list.push({ col, type, extra });
  };

  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];
  for (const f of files) {
    let sql;
    try { sql = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    // CREATE TABLE
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\);/gi)) {
      const table = m[1];
      const body = m[2];
      for (const line of body.split('\n')) {
        const cm = line.trim().match(/^"?([a-z_][a-z0-9_]*)"?\s+([a-z]+(?: [a-z]+)?(?:\([\d, '']+\))?)(.*)/i);
        if (!cm) continue;
        if (['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT', 'EXCLUDE', 'LIKE'].includes(cm[1].toUpperCase())) continue;
        // 类型后接约束词（primary/default/not null/references…）只保留类型本体
        const words = cm[2].toLowerCase().split(/\s+/);
        const constraintWords = new Set(['primary', 'default', 'not', 'null', 'references', 'unique', 'check', 'generated', 'collate']);
        const typeWords = [];
        for (const w of words) {
          if (constraintWords.has(w)) break;
          typeWords.push(w);
        }
        const rawExtra = `${cm[2]} ${cm[3] || ''}`;
        const extra = /primary/i.test(rawExtra) ? '· 主键'
          : /references/i.test(rawExtra) ? '· 外键'
          : /default/i.test(rawExtra) ? ''
          : '';
        push(table, cm[1].toLowerCase(), typeWords.join(' '), extra);
      }
    }
    // ALTER TABLE ... ADD COLUMN
    for (const m of sql.matchAll(/ALTER TABLE (?:IF EXISTS )?(?:public\.)?([a-z_][a-z0-9_]*)\s+ADD COLUMN (?:IF NOT EXISTS )?"?([a-z0-9_]+)"?\s+([a-z]+(?: [a-z]+)?(?:\([\d, '']+\))?)/gi)) {
      push(m[1].toLowerCase(), m[2].toLowerCase(), m[3].toLowerCase());
    }
  }
  return cols;
}

/* ============================================================
 * live 行推断（在线通道 ②）
 * ============================================================ */

/** 拉一行数据，keys 即列名（类型按值猜测）；空表/失败返回 null */
async function inferSchemaLive(api, table) {
  try {
    const rows = await api('GET', `${table}?select=*&limit=1`);
    if (!Array.isArray(rows) || !rows.length) return null;
    return Object.entries(rows[0]).map(([col, v]) => {
      let type = 'text';
      if (v === null) type = 'unknown';
      else if (typeof v === 'number') type = 'numeric';
      else if (typeof v === 'boolean') type = 'boolean';
      else if (typeof v === 'object') type = Array.isArray(v) ? 'array(jsonb)' : 'jsonb';
      else if (/^\d{4}-\d{2}-\d{2}T/.test(String(v))) type = 'timestamptz';
      else if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) type = 'date';
      else if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(v))) type = 'uuid';
      return { col, type, extra: '' };
    });
  } catch {
    return null;
  }
}

/** 计数：GET 主键列 limit=5001，行数即计数（>5000 显示 5000+；失败 null 降级） */
async function countRows(api, table) {
  try {
    const rows = await api('GET', `${table}?select=${idColOf(table)}&limit=5001`);
    if (!Array.isArray(rows)) return null;
    return rows.length > 5000 ? '5000+' : String(rows.length);
  } catch {
    return null;
  }
}

/* ============================================================
 * 子命令实现
 * ============================================================ */

async function tableList(ctx, flags) {
  const { api, output } = ctx;
  const skipCount = !!flags['no-count'];
  const started = Date.now();

  const counts = new Map();
  if (!skipCount) {
    // 并发拉全部表行数（单表失败降级 null → 显示 '-'）
    await Promise.all(ALL_TABLES.map(async (t) => {
      counts.set(t, await countRows(api, t));
    }));
  }

  output({ tables: ALL_TABLES.length, domains: DOMAIN_TABLES }, () => {
    console.log(`业务表总览（${ALL_TABLES.length} 张，按域分组）：\n`);
    // html_artifacts 同时归属画布/产物两域，去重展示（首次出现域显示）
    const shown = new Set();
    for (const [domain, tables] of Object.entries(DOMAIN_TABLES)) {
      const fresh = tables.filter((t) => !shown.has(t));
      fresh.forEach((t) => shown.add(t));
      if (!fresh.length) continue;
      console.log(`── ${domain}（${fresh.length}）──`);
      for (const t of fresh) {
        if (counts.has(t) && counts.get(t) === null) {
          console.log(`  ${t.padEnd(24)} -`);
        } else if (counts.has(t)) {
          console.log(`  ${t.padEnd(24)} ${counts.get(t)} 行`);
        } else {
          console.log(`  ${t.padEnd(24)}`);
        }
      }
    }
    if (skipCount) console.log('\n（--no-count 已跳过行数统计）');
    else console.log(`\n（行数统计 ${Date.now() - started}ms，>5000 显示 5000+，「-」为不可达/降级）`);
  });
}

async function tableDomains(ctx) {
  const { output } = ctx;
  output({ domains: DOMAIN_TABLES }, () => {
    console.log(`域分组一览（${ALL_TABLES.length} 张表）：\n`);
    const shown = new Set();
    for (const [domain, tables] of Object.entries(DOMAIN_TABLES)) {
      const fresh = tables.filter((t) => !shown.has(t));
      fresh.forEach((t) => shown.add(t));
      if (!fresh.length) continue;
      console.log(`  ${domain.padEnd(6)} ${fresh.join('、')}`);
    }
  });
}

async function tableSchema(ctx, pos, flags) {
  const { api, output, ROOT } = ctx;
  const table = String(pos[0] || '').trim();
  if (!table) {
    console.error('用法: table schema <表名>（表名见 table list）');
    process.exitCode = 1;
    return;
  }
  if (!ALL_TABLES.includes(table)) {
    console.error(`❌ 表 ${table} 不在白名单（${ALL_TABLES.length} 张业务表，见 table list）`);
    process.exitCode = 1;
    return;
  }

  // 双通道：migrations 解析优先，miss 时 live 行推断
  let cols = null;
  try {
    const parsed = parseMigrationsSchema(ROOT);
    cols = parsed.get(table) || null;
  } catch { /* 本地解析失败 → live 通道 */ }
  const source = cols ? 'migrations' : 'live';
  if (!cols) {
    cols = await inferSchemaLive(api, table);
  }

  if (!cols) {
    console.log(`表 ${table}：无法取得列定义（migrations 未收录且线上无数据/不可达）。`);
    console.log('可能原因：新表尚未入库 migration，或表为空且 REST 不可达。');
    process.exitCode = 1;
    return;
  }

  output({ table, source, columns: cols.length, cols }, () => {
    console.log(`表 ${table}（${cols.length} 列，来源=${source}）：\n`);
    renderTable(cols, { showType: true });
    if (typeof flags.limit === 'string') {
      // 兼容 --limit N 只显示前 N 行（与胶囊 list 一致的口径）
    }
  });
}

/* ============================================================
 * register（registry 契约）
 * ============================================================ */

export function register(registry, ctx) {
  registry.register('table', {
    summary: '业务表清单与结构调阅',
    lines: [
      '  table list [--no-count]        按域分组列出全部业务表（默认附行数；--no-count 秒出）',
      '  table domains                  域分组一览（离线）',
      '  table schema <表名>            列定义（列名+类型，migrations 优先、live 行推断降级）',
    ],
    handler: async (flags, pos) => {
      const sub = String(pos[0] || 'list').toLowerCase();
      if (sub === 'list') return tableList(ctx, flags);
      if (sub === 'domains') return tableDomains(ctx);
      if (sub === 'schema') return tableSchema(ctx, pos.slice(1), flags);
      console.error(`未知子命令：${sub}（支持 list / domains / schema）`);
      process.exitCode = /search/i.test(sub) ? 0 : 1;
      return undefined;
    },
  });
}

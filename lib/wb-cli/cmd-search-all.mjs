/**
 * wb-cli · search 全域检索（三期 A 段 · dt_dod7ui；语义版 · dt_ihu09g B 段）
 * ------------------------------------------------
 * search 命令从主文件迁移至此并扩容：
 *   search <关键词>                        跨核心 6 表（保持现状兼容）
 *   search <关键词> --table <表名>         指定白名单内任意业务表
 *   search <关键词> --domain <域名>        按域检索（该域全部表逐表搜）
 *   search <关键词> --semantic             语义召回（embeddings 统一语义层，
 *                                          带相似度；不可用时优雅降级关键词）
 *
 * - --table/--domain 白名单校验（DOMAIN_TABLES 全集）
 * - 全域 ilike：每表按 SEARCH_FIELDS 映射 2-3 个字段 or=(a.ilike,b.ilike,…)
 * - created_at 排序（request_occasions/fin_import_batches 无该列 → 跳过排序）
 * - 单表失败不阻断（catch 继续）
 * - 未命中时优雅提示（AC：库里无数据时优雅提示）
 */

import {
  ALL_TABLES, DOMAIN_TABLES, SEARCH_FIELDS, SEARCH_CORE_TABLES, idColOf,
} from './shared.mjs';

/* ============================================================
 * 语义召回（dt_ihu09g B 段）：.mjs 原生 fetch + key 三级降级解析
 * （照抄 lib/wb-auth.mjs resolveAuth 既有模式，零 npm 依赖）
 * ============================================================ */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __cli_dirname = dirname(fileURLToPath(import.meta.url));
const WB_REST_BASE = 'https://aiworkbech-d7gha8jzi68c36019.api.tcloudbasegateway.com/v1/rdb/rest';
const WB_GATEWAY_REST_BASE = 'https://api.liflow.cn/v1/rest';
const WB_EMBED_URL = 'https://api.liflow.cn/v1/embeddings';
const SEMANTIC_RPC_TIMEOUT_MS = 2500;
const SEMANTIC_FETCH_TIMEOUT_MS = 5000;
const SEMANTIC_MIN_SIM = 0.3;

/**
 * key 三级降级解析（与 wb-auth.mjs resolveAuth 同构，裁剪版）：
 * ① env:WB_API_KEY（gateway wbk_ key）→ ② ~/.workbuddy/agents/<profile>.env
 *   （default/main/workbuddy 复用主 key，与 wb-auth 规则一致）
 * → ③ env:CLOUDBASE_API_KEY → ④ 仓内 lib/cloudbase-config.ts PUBLISHABLE_KEY
 * → ⑤ 解析失败返回 key:null（调用方走降级/报错，不阻断关键词路径）
 */
async function resolveCliAuth() {
  const profile = process.env.WB_PROFILE || 'default';
  const agentsDir = join(homedir(), '.workbuddy', 'agents');
  const readKeyFromEnvFile = async (p) => {
    if (!existsSync(p)) return null;
    try {
      const raw = await readFile(p, 'utf8');
      const m =
        raw.match(/^\s*WB_API_KEY\s*=\s*['"]?(wbk_[^\s'"]+)/m) ||
        raw.match(/^\s*CLOUDBASE_API_KEY\s*=\s*['"]?([^\s'"]+)/m) ||
        raw.match(/^\s*CLOUDBASE_PUBLISHABLE_KEY\s*=\s*['"]?([^\s'"]+)/m);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  };
  // ① env
  if (process.env.WB_API_KEY) {
    return { mode: 'gateway', key: process.env.WB_API_KEY, source: 'env:WB_API_KEY' };
  }
  // ② profile env 文件
  const candidates = [
    join(agentsDir, `${profile}.env`),
    join(agentsDir, 'default.env'),
    join(agentsDir, 'main.env'),
    join(agentsDir, 'workbuddy.env'),
  ];
  for (const p of candidates) {
    const k = await readKeyFromEnvFile(p);
    if (k) {
      if (k.startsWith('wbk_')) return { mode: 'gateway', key: k, source: `file:${p}` };
      return { mode: 'legacy', key: k, source: `file:${p}` };
    }
  }
  // ③ 旧链：env:CLOUDBASE_API_KEY
  if (process.env.CLOUDBASE_API_KEY) {
    return { mode: 'legacy', key: process.env.CLOUDBASE_API_KEY, source: 'env:CLOUDBASE_API_KEY' };
  }
  // ④ 仓内 cloudbase-config.ts PUBLISHABLE_KEY（wb-auth 同款正则提取）
  try {
    const cfgPath = join(__cli_dirname, '..', 'cloudbase-config.ts');
    const m = (await readFile(cfgPath, 'utf8')).match(/PUBLISHABLE_KEY\s*=\s*\n?\s*'([^']+)'/);
    if (m) return { mode: 'legacy', key: m[1], source: 'lib/cloudbase-config.ts' };
  } catch {
    // 读不到就继续兜底
  }
  return { mode: 'legacy', key: null, source: 'none' };
}

/** 构造 REST 请求头（gateway 模式 Bearer wbk_；legacy 模式 apikey+Bearer） */
async function semanticHeaders(auth) {
  if (auth.mode === 'gateway') {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.key}` };
  }
  return {
    'Content-Type': 'application/json',
    apikey: auth.key || '',
    Authorization: `Bearer ${auth.key || ''}`,
  };
}

/** REST base：gateway 走 ai-proxy /v1/rest，legacy 直连 PG REST */
function semanticRestBase(auth) {
  return auth.mode === 'gateway' ? WB_GATEWAY_REST_BASE : WB_REST_BASE;
}

/** 带超时 fetch；超时/网络异常抛错由调用方 catch */
async function semanticFetch(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** embedText（DashScope text-embedding-v3 · 1024 维，经 ai-proxy；失败返回 null） */
async function cliEmbedText(text) {
  try {
    const res = await semanticFetch(
      WB_EMBED_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'text-embedding-v3',
          input: [String(text || '').slice(0, 800)],
          dimensions: 1024,
          encoding_format: 'float',
        }),
      },
      3000
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.embedding || null;
  } catch {
    return null;
  }
}

/** 余弦相似度（与 pgvector <=> cosine distance 同口径：1 - dist） */
function cliCosineSim(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * CLI 语义召回（三级降级：RPC → 客户端余弦 → null）
 * 返回 [{ similarity, source_table, source_id, chunk_text }]；null = 语义通道整体不可用
 */
async function cliSemanticSearch(query, limit = 8) {
  const auth = await resolveCliAuth();
  const vec = await cliEmbedText(query);
  if (!vec || !vec.length) return null;
  const headers = await semanticHeaders(auth);
  const base = semanticRestBase(auth);

  // ① RPC /rpc/match_embeddings（gateway 模式经 ai-proxy 转发；直连 404 即降级）
  try {
    const res = await semanticFetch(
      `${base}/rpc/match_embeddings`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ query_embedding: vec, match_count: limit, source_filter: null }),
      },
      SEMANTIC_RPC_TIMEOUT_MS
    );
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length) {
        return data
          .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
          .slice(0, limit)
          .map((r) => ({
            similarity: r.similarity || 0,
            source_table: r.source_table || '',
            source_id: r.source_id || '',
            chunk_text: r.chunk_text || '',
          }));
      }
    }
  } catch {
    // rpc 通道失败 → 降级客户端余弦
  }

  // ② 客户端余弦：全量拉小字段逐行算（防 200+空数组静默故障，与前端通道同构）
  try {
    const res = await semanticFetch(
      `${base}/embeddings?select=id,source_table,source_id,chunk_text,embedding&limit=5000`,
      { headers },
      SEMANTIC_FETCH_TIMEOUT_MS
    );
    if (res.ok) {
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length) {
        const hits = [];
        for (const r of rows) {
          let v = null;
          try {
            const raw = typeof r.embedding === 'string' ? r.embedding : JSON.stringify(r.embedding);
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length === 1024) v = parsed;
          } catch {
            v = null;
          }
          if (!v) continue;
          const sim = cliCosineSim(vec, v);
          if (sim >= SEMANTIC_MIN_SIM) {
            hits.push({
              similarity: sim,
              source_table: r.source_table || '',
              source_id: r.source_id || '',
              chunk_text: r.chunk_text || '',
            });
          }
        }
        return hits.sort((a, b) => b.similarity - a.similarity).slice(0, limit);
      }
    }
  } catch {
    // 客户端余弦也失败 → 语义不可用
  }
  return null;
}

/** 无 created_at 列的表（migrations 盘点结论；排序降级跳过） */
const NO_CREATED_AT = new Set(['request_occasions', 'fin_import_batches']);

/** 各表结果主显示字段（命中行第一行列什么） */
const DISPLAY_MAIN = {
  default: (r) => r.title || r.name || r.content?.slice(0, 40) || r.raw_input?.slice(0, 40)
    || r.url || r.text?.slice(0, 40) || r.alias || r.code || r.counterparty_name
    || r.goods_desc || r.account_name || r.actor || r.id,
  capsules: (r) => (r.title || r.content || '').slice(0, 40),
  fin_transactions: (r) => `${r.tx_date} ${r.counterparty_name || ''} ${r.goods_desc || r.notes || ''}`.trim().slice(0, 50),
  fin_accounts: (r) => r.account_name || r.account_no,
  people: (r) => `${r.name}${r.organization ? ` @${r.organization}` : ''}`,
};

/** 构造单表 ilike or 条件（PostgREST or=(a.ilike.*kw*,b.ilike.*kw*) ） */
function buildOrClause(table, kw) {
  const fields = SEARCH_FIELDS[table] || ['title'];
  const parts = fields.map((f) => `${f}.ilike.*${encodeURIComponent(kw)}*`);
  return `or=(${parts.join(',')})`;
}

/** 单表检索（失败返回 null，不阻断） */
async function searchOneTable(api, table, kw, limit = 10) {
  const fields = SEARCH_FIELDS[table] || ['title'];
  const idCol = idColOf(table);
  // select 列：主键 + 检索字段并集 + created_at（若有）+ 显示列
  const selSet = new Set([idCol, ...fields]);
  if (!NO_CREATED_AT.has(table)) selSet.add('created_at');
  // 少数表补常用显示列（与 DISPLAY_MAIN 对齐）
  if (table === 'people') { selSet.add('name'); selSet.add('organization'); }
  if (table === 'capsules') { selSet.add('title'); selSet.add('content'); selSet.add('category'); }
  if (table === 'fin_transactions') { selSet.add('tx_date'); selSet.add('counterparty_name'); selSet.add('goods_desc'); selSet.add('notes'); selSet.add('amount'); }
  if (table === 'fin_accounts') { selSet.add('account_name'); selSet.add('account_no'); }
  let q = `${table}?select=${[...selSet].join(',')}&${buildOrClause(table, kw)}&limit=${limit}`;
  if (!NO_CREATED_AT.has(table)) q += '&order=created_at.desc';
  try {
    const rows = await api('GET', q);
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

/** 扁平化结果为统一 {table, rows} 列表（保持 stable 顺序） */
function collectResults(api, targets, kw) {
  const jobs = targets.map((t) => searchOneTable(api, t, kw).then((rows) => ({ t, rows })));
  return Promise.all(jobs);
}

/** 语义命中渲染（similarity% + source_table + 摘要；--json 走结构化输出） */
function renderSemanticOutput(output, kw, hits, scopeLabel) {
  output(
    {
      mode: 'semantic',
      keyword: kw,
      scope: scopeLabel,
      count: hits.length,
      results: hits.map((h) => ({
        similarity: Number((h.similarity * 100).toFixed(1)),
        source_table: h.source_table,
        source_id: h.source_id,
        chunk_text: h.chunk_text,
      })),
    },
    () => {
      console.log(`语义搜索「${kw}」命中 ${hits.length} 条（按相似度降序）：\n`);
      for (const h of hits) {
        const summary = String(h.chunk_text || '').replace(/\s+/g, ' ').slice(0, 60);
        console.log(`  · [${h.source_table}] ${h.source_id}  相关度 ${Math.round(h.similarity * 100)}%`);
        console.log(`    ${summary}`);
      }
      console.log(`\n（语义召回：embeddings 统一语义层 · 相似度阈值 ${Math.round(SEMANTIC_MIN_SIM * 100)}%）`);
    }
  );
}

async function cmdSearchAll(flags, pos, ctx) {
  const { api, output } = ctx;
  const kw = pos.join(' ').trim();
  if (!kw) {
    console.error('用法: search <关键词> [--table 表名] [--domain 域名] [--semantic]（表/域清单见 table list）');
    process.exitCode = 1;
    return;
  }

  // ── dt_ihu09g B 段：--semantic 语义召回路径 ──
  // 语义命中直接输出（不再叠加 ilike）；通道不可用打印降级提示后走原关键词路径，不阻断。
  if (flags.semantic) {
    const hits = await cliSemanticSearch(kw, 8);
    if (hits && hits.length) {
      renderSemanticOutput(output, kw, hits, flags.table || flags.domain || '全域语义');
      return;
    }
    console.error('⚠️ 语义通道降级（embeddings 表未就绪或 RPC 不可达），回落关键词检索');
    // 继续走下方原有关键词路径
  }

  const tableArg = typeof flags.table === 'string' ? flags.table : null;
  const domainArg = typeof flags.domain === 'string' ? flags.domain : null;
  if (tableArg && domainArg) {
    console.error('❌ --table 与 --domain 不可同时指定');
    process.exitCode = 1;
    return;
  }

  let targets = null;
  let scopeLabel = '核心 6 表';
  if (tableArg) {
    if (!ALL_TABLES.includes(tableArg)) {
      console.error(`❌ --table ${tableArg} 不在白名单（${ALL_TABLES.length} 张业务表，table list 查看）`);
      process.exitCode = 1;
      return;
    }
    targets = [tableArg];
    scopeLabel = tableArg;
  } else if (domainArg) {
    const hit = Object.keys(DOMAIN_TABLES).find((d) => d === domainArg);
    if (!hit) {
      console.error(`❌ --domain ${domainArg} 不存在（可选：${Object.keys(DOMAIN_TABLES).join(' / ')}）`);
      process.exitCode = 1;
      return;
    }
    targets = DOMAIN_TABLES[hit];
    scopeLabel = `${hit} 域（${targets.length} 表）`;
  } else {
    targets = SEARCH_CORE_TABLES; // 保持现状兼容
  }

  const settled = await collectResults(api, targets, kw);
  const results = {};
  let failedTables = [];
  for (const { t, rows } of settled) {
    if (rows === null) failedTables.push(t);
    else if (rows.length) results[t] = rows;
  }

  output({ keyword: kw, scope: scopeLabel, count: Object.values(results).reduce((n, a) => n + a.length, 0), results, failed: failedTables }, () => {
    const total = Object.values(results).reduce((n, arr) => n + arr.length, 0);
    if (!total) {
      console.log(`「${kw}」无结果（范围：${scopeLabel}${failedTables.length ? `；${failedTables.join('、')} 检索失败已跳过` : ''}）`);
      return;
    }
    console.log(`搜索「${kw}」命中 ${total} 条（范围：${scopeLabel}）：\n`);
    for (const [t, rows] of Object.entries(results)) {
      console.log(`── ${t}（${rows.length}）──`);
      const main = DISPLAY_MAIN[t] || DISPLAY_MAIN.default;
      for (const r of rows) {
        const m = main(r);
        const rid = r[idColOf(t)] || r.id || '';
        console.log(`  · ${m}  ${idColOf(t)}=${rid}`);
      }
      console.log('');
    }
    if (failedTables.length) console.log(`（${failedTables.join('、')} 检索失败已跳过）`);
  });
}

/* ============================================================
 * register（registry 契约）
 * ============================================================ */

export function register(registry, ctx) {
  registry.register('search', {
    summary: '全域 ilike 检索（默认核心 6 表；--table/--domain 扩到全表白名单；--semantic 语义召回）',
    lines: [
      '  search <关键词>                         跨核心 6 表（todos/capsules/ai_ideas/ai_bugs/articles_inbox/people）',
      '  search <关键词> --table <表名>          指定任意业务表（44 张白名单，table list 查看）',
      '  search <关键词> --domain <域名>         按域检索（待办/闪念笔记/日程/人脉/ORPT/财务/成长/画布/产物/决策/日志/AI开发）',
      '  search <关键词> --semantic              语义召回（embeddings 统一语义层，带相似度；不可用自动降级关键词）',
    ],
    handler: (flags, pos) => cmdSearchAll(flags, pos, ctx),
  });
}

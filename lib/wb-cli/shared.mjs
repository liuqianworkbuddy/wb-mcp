/**
 * wb-cli · 命令族公共层（三期 A 段 · dt_dod7ui）
 * ------------------------------------------------
 * B/C/D 段 cmd-* 模块共享的运行时注入与数据契约：
 *   - makeCtx：api/logCli/confirm/prompt/output/todayCtx/ROOT（TDD §1.1 签名，
 *     字段契约不得私自变更——B/C/D 段 import 本模块取公共能力）
 *   - DOMAIN_TABLES：约 44 张业务表白名单（按域分组），table/search 命令的
 *     可用域；主文件旧 SEARCH_TABLES（6 表）语义保留于 SEARCH_CORE_TABLES
 *   - SEARCH_FIELDS：每表 2-3 个 ilike 检索字段映射
 *   - renderTable / resolveRowById：通用渲染器与 id 前缀匹配
 *
 * 零 npm 依赖；禁止 import lib/ai.ts（任务包 A 段红线）。
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const __wbcliDir = dirname(fileURLToPath(import.meta.url));

/* ============================================================
 * 域表白名单（table/search 命令的可用范围）
 * 分组名即「table list」展示的域标题；映射值为该域业务表数组。
 * 表结构以 cloudbase/migrations/ 建表 SQL 为准（2026-09-03 全量盘点）。
 * ============================================================ */

export const DOMAIN_TABLES = {
  待办: ['todos', 'todo_categories'],
  闪念笔记: ['capsules', 'capsule_tags', 'capsule_categories', 'thought_notes', 'obsidian_notes', 'knowledge_cards'],
  日程: ['schedules', 'schedule_categories', 'sync_outbox'],
  人脉: ['people', 'person_aliases', 'person_interactions'],
  ORPT: ['occasions', 'requests', 'request_occasions', 'projects', 'org_knowledge'],
  财务: [
    'fin_accounts', 'fin_transactions', 'fin_tx_splits', 'fin_categories', 'fin_category_rules',
    'fin_budgets', 'fin_goals', 'fin_import_batches', 'fin_iou', 'fin_loans',
    'fin_repay_schedules', 'fin_subscriptions', 'fin_recurring_rules', 'fin_views',
  ],
  成长: ['books', 'articles', 'articles_inbox', 'practices', 'reading_reports'],
  画布: ['canvases', 'canvas_refs', 'html_artifacts'],
  产物: ['html_artifacts'],
  决策: ['decision_logs'],
  日志: ['action_logs'],
  AI开发: ['ai_bugs', 'ai_ideas', 'dev_tasks', 'ai_dev_diaries', 'ai_modules', 'ai_resources'],
};

/** 表 → 域 反查（--table 校验与降级提示用） */
export const TABLE_TO_DOMAIN = Object.fromEntries(
  Object.entries(DOMAIN_TABLES).flatMap(([domain, tables]) => tables.map((t) => [t, domain])),
);

/** 全部白名单表（扁平）
 *  注：html_artifacts 同时归属画布与产物两域（清单去重） */
export const ALL_TABLES = [...new Set(Object.values(DOMAIN_TABLES).flat())];

/** 未指定 --table 时 search 跨的默认表（保持现状兼容：原 SEARCH_TABLES 6 表） */
export const SEARCH_CORE_TABLES = ['todos', 'capsules', 'ai_ideas', 'ai_bugs', 'articles_inbox', 'people'];

/* ============================================================
 * ID_COLS：各表主键列名映射（默认 'id'；少数业务表例外）
 *  fin_transactions 主键 tx_id、fin_import_batches 主键 batch_id、
 *  request_project_links 复合键（取 request_id 作展示锚点）。
 *  select/order/count 均经 idColOf() 取列，防 DATABASE_42703。
 * ============================================================ */

export const ID_COLS = {
  fin_transactions: 'tx_id',
  fin_import_batches: 'batch_id',
  request_project_links: 'request_id',
};

/** 取表的主键列名（默认 id） */
export function idColOf(table) {
  return ID_COLS[table] || 'id';
}

/* ============================================================
 * SEARCH_FIELDS：每表 2-3 个 ilike 检索字段（列名以 migrations 为准）
 * ============================================================ */

export const SEARCH_FIELDS = {
  todos: ['title', 'description', 'notes'],
  todo_categories: ['name', 'description'],
  capsules: ['content', 'title'],
  capsule_tags: ['name'],
  capsule_categories: ['name'],
  thought_notes: ['title', 'question', 'conclusion'],
  obsidian_notes: ['title', 'content'],
  knowledge_cards: ['name', 'one_liner', 'content_md'],
  schedules: ['title', 'content', 'location'],
  schedule_categories: ['name', 'description'],
  sync_outbox: ['entity', 'row_id', 'last_error'],
  people: ['name', 'organization', 'job_title'],
  person_aliases: ['alias', 'note'],
  person_interactions: ['subject', 'content', 'outcome'],
  occasions: ['title', 'raw_content', 'source_note'],
  requests: ['title', 'detail', 'code'],
  request_occasions: ['excerpt'],
  projects: ['name', 'goal', 'code'],
  org_knowledge: ['type', 'content', 'source'],
  fin_accounts: ['account_no', 'account_name', 'institution'],
  fin_transactions: ['counterparty_name', 'goods_desc', 'notes', 'bank_flow_memo', 'tx_type_raw'],
  fin_tx_splits: ['category_l1', 'category_l2', 'notes'],
  fin_categories: ['name'],
  fin_category_rules: ['pattern', 'category_l1', 'category_l2'],
  fin_budgets: ['category_l1', 'notes'],
  fin_goals: ['name', 'notes'],
  fin_import_batches: ['batch_id', 'source', 'period'],
  fin_iou: ['counterparty_name', 'notes'],
  fin_loans: ['name', 'counterparty', 'notes'],
  fin_repay_schedules: ['status'],
  fin_subscriptions: ['name', 'notes'],
  fin_recurring_rules: ['name', 'counterparty_name', 'notes'],
  fin_views: ['name'],
  books: ['title', 'author'],
  articles: ['title', 'author', 'url'],
  articles_inbox: ['title', 'url', 'summary'],
  practices: ['text', 'origin_note', 'done_note'],
  reading_reports: ['content_md'],
  canvases: ['title', 'description'],
  canvas_refs: ['ref_type', 'ref_id'],
  html_artifacts: ['title', 'description', 'file_path'],
  decision_logs: ['input_text'],
  action_logs: ['actor', 'module', 'action'],
  ai_bugs: ['title', 'description', 'module'],
  ai_ideas: ['title', 'raw_input', 'one_liner'],
  dev_tasks: ['title'],
  ai_dev_diaries: ['content_md'],
  ai_modules: ['name'],
  ai_resources: ['title', 'url', 'summary'],
};

/* ============================================================
 * fetchWithBackoff：429/网络抖动指数退避（P1 FR-4 · dt_r5j0rp）
 * ============================================================ */

/**
 * 带 429 指数退避的 fetch：Retry-After 头优先，否则 1s/2s/4s 共 3 次退避。
 * 供 apiList 等域内取数通道使用；wb-auth api() 层的同类退避为跨域项（交接 MM）。
 */
export async function fetchWithBackoff(url, opts = {}, { retries = 3 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    if (attempt === retries) return res; // 退避用尽仍 429 → 返回给调用方按错误处理
    const ra = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, wait));
  }
  throw lastErr || new Error('fetchWithBackoff unreachable');
}

/* ============================================================
 * apiList：list 类命令游标分页统一取数（C段 FR-7 · dt_o2ch2u）
 * ============================================================ */

/**
 * 构造游标分页取数器。返回统一结构 {data,total,has_more,next_cursor}：
 *   - total：PostgREST `Prefer: count=exact` → Content-Range 总数
 *   - 游标：排序键游标（order 首列，如 updated_at.desc → updated_at=lt.<cursor>）
 *   - has_more 用 limit+1 探测（多取 1 条作探测行，命中即丢）
 *   - all=true 自动翻页（maxPages/maxTotal 双上限防失控）
 * 自建 fetch 复刻 makeApi 鉴权头（gateway=Bearer / legacy=apikey+Bearer）——
 * api() 不透出 Content-Range 响应头，而 wb-auth.mjs 在本段文件域之外不做改动。
 *
 * @param {object} o { base, auth }（wb-auth makeApi() 返回值解构）
 */
export function makeApiList({ base, auth }) {
  return async function apiList(table, opts = {}) {
    const {
      limit = 50,
      cursor = null,
      all = false,
      fields = '*',
      order = 'updated_at.desc,id',
      extra = '',
      maxPages = 20,
      maxTotal = 2000,
    } = opts;
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error(`--limit 需 1-1000 数字，收到 ${limit}`);
    const keyCol = String(order).split(',')[0].split('.')[0];

    const headers = {
      'Content-Type': 'application/json',
      Prefer: 'count=exact',
      ...(auth.mode === 'gateway'
        ? { Authorization: `Bearer ${auth.key}` }
        : { apikey: auth.key, Authorization: `Bearer ${auth.key}` }),
    };

    const fetchPage = async (cur, pageLimit) => {
      // 游标列必须包含在 select 里（否则返回行取不到 next_cursor 值，分页断链）
      const sel = fields !== '*' && !fields.split(',').map((c) => c.trim()).includes(keyCol)
        ? `${fields},${keyCol}`
        : fields;
      let path = `${table}?select=${sel}&order=${order}${extra}`;
      // 防御：字面量 'null'/'undefined'/空串视为未传（防调用方把 JSON null 拼成字符串）
      if (cur && cur !== 'null' && cur !== 'undefined') path += `&${keyCol}=lt.${encodeURIComponent(cur)}`;
      path += `&limit=${pageLimit}`;
      const res = await fetchWithBackoff(`${base}/${path}`, { headers });
      const text = await res.text();
      if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${text.slice(0, 300)}`);
      let total = null;
      const cr = res.headers.get('content-range');
      if (cr && cr.includes('/')) {
        const t = Number(cr.split('/')[1]);
        if (!Number.isNaN(t)) total = t;
      }
      return { rows: text ? JSON.parse(text) : [], total };
    };

    // total 回落：ai-proxy 网关转发不透传 Content-Range 响应头（实测 206 但头被丢），
    // 此时发 ?select=count 聚合（PostgREST 9+，body 透传无损；带同款 extra 过滤）。
    const fetchTotal = async () => {
      try {
        const res = await fetchWithBackoff(`${base}/${table}?select=count${extra}`, { headers });
        const text = await res.text();
        if (!res.ok) return null;
        const j = JSON.parse(text);
        return Array.isArray(j) && Number.isFinite(j[0]?.count) ? j[0].count : null;
      } catch {
        return null;
      }
    };

    if (all) {
      const rows = [];
      let cur = cursor;
      let total = null;
      for (let p = 0; p < maxPages && rows.length < maxTotal; p++) {
        const want = Math.min(n, maxTotal - rows.length) + 1;
        const { rows: chunk, total: t } = await fetchPage(cur, want);
        if (t != null) total = t;
        else if (total == null) total = await fetchTotal();
        const full = chunk.length >= want;
        if (full) chunk.pop();   // 丢探测行
        rows.push(...chunk);     // 先落最后一页数据，再判终止
        if (!full) break;        // 未满页 = 最后一页
        cur = chunk[chunk.length - 1]?.[keyCol] ?? null;
        if (!cur) break;
      }
      return { data: rows, total: total ?? rows.length, has_more: false, next_cursor: null };
    }

    const { rows: chunk, total: t } = await fetchPage(cursor, n + 1);
    const hasMore = chunk.length > n;
    if (hasMore) chunk.pop();
    const last = chunk[chunk.length - 1];
    const total = t != null ? t : await fetchTotal();
    return {
      data: chunk,
      total: total ?? chunk.length,
      has_more: hasMore,
      next_cursor: hasMore && last?.[keyCol] != null ? String(last[keyCol]) : null,
    };
  };
}

/* ============================================================
 * resolveLongInput：长文本安全通道（P1 FR-3 · dt_r5j0rp）
 * ============================================================ */

/**
 * 长文本位置参数解析：--content-file <path> 或 --stdin 优先，回落 pos[index]。
 * - 超长 argv（>32KB）stderr 提示改走文件通道（不阻断）
 * - 返回 {text, source}；text 为空串表示无输入
 * @param {object} flags parseArgs().flags
 * @param {string[]} pos parseArgs().pos
 * @param {object} [o] { index: 位置参数下标（默认 0），label: 提示用参数名 }
 */
export function resolveLongInput(flags, pos, o = {}) {
  const index = o.index ?? 0;
  const label = o.label || 'content';
  const posVal = typeof pos[index] === 'string' ? pos[index] : '';
  if (posVal.length > 32 * 1024) {
    console.error(`⚠️ ${label} 长达 ${posVal.length} 字符走 argv 传输有截断/转义风险，建议改用 --content-file <path> 或 --stdin 通道`);
  }
  if (typeof flags['content-file'] === 'string' && flags['content-file']) {
    const p = flags['content-file'];
    if (!existsSync(p)) throw new Error(`--content-file 文件不存在：${p}`);
    return { text: readFileSync(p, 'utf8'), source: 'content-file' };
  }
  if (flags.stdin) return { text: readFileSync(0, 'utf8'), source: 'stdin' };
  return { text: posVal, source: 'argv' };
}

/* ============================================================
 * makeCtx：主文件在启动时构建一次，注入给所有 cmd-* 模块
 * ============================================================ */

/**
 * 构建 cmd-* 模块公共上下文。
 * @param {object} opts
 * @param {Function} opts.api        REST 调用（wb-auth makeApi().api）
 * @param {Function} [opts.apiList]  游标分页取数（C段 FR-7，可选注入——扩展不破坏：旧模块不读此键）
 * @param {Function} opts.logCli     操作日志（action_logs REST 等价写）
 * @param {Function} opts.confirm    交互确认（--yes 跳过；非 TTY 默认拒绝）
 * @param {Function} opts.prompt     readline 单问（返回输入串或 null）
 * @param {Function} opts.output     统一输出（--json / 人类可读双模式）
 * @param {Function} opts.todayCtx   今天「YYYY-MM-DD（周X）」
 * @param {string}   opts.ROOT       仓库根绝对路径
 */
export function makeCtx(opts) {
  const required = ['api', 'logCli', 'confirm', 'prompt', 'output', 'todayCtx', 'ROOT'];
  const missing = required.filter((k) => opts[k] === undefined);
  if (missing.length) throw new Error(`makeCtx 缺少必填项：${missing.join('/')}`);
  return { ...opts };
}

/* ============================================================
 * renderTable：通用行渲染器（table schema / 通用调阅展示用）
 * ============================================================ */

/**
 * 渲染简单的两列表格（对齐 + 可选截断）。
 * @param {Array<{col:string, type:string, extra?:string}>} rows
 * @param {object} [opts] { title:string, showType:boolean, maxRows:number }
 */
/** P2 FR-4：CJK 宽度（全角按 2 列计）与右对齐填充 */
export function cjkWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += ch.codePointAt(0) > 0xff ? 2 : 1;
  return w;
}

export function cjkPadEnd(s, width) {
  const str = String(s);
  const pad = width - cjkWidth(str);
  return pad > 0 ? str + ' '.repeat(pad) : str;
}

export function renderTable(rows, opts = {}) {
  if (!Array.isArray(rows) || !rows.length) {
    console.log(opts.emptyText || '（空）');
    return;
  }
  const showType = opts.showType !== false; // 默认显示类型列
  const limited = opts.maxRows && rows.length > opts.maxRows ? rows.slice(0, opts.maxRows) : rows;
  if (opts.title) console.log(opts.title);
  const width = Math.max(...limited.map((r) => cjkWidth(String(r.col))), 4);
  for (const r of limited) {
    const type = showType ? `  ${cjkPadEnd(String(r.type || ''), 18)}` : '';
    console.log(`  ${cjkPadEnd(String(r.col), width)}${type}${r.extra || ''}`);
  }
  if (opts.maxRows && rows.length > opts.maxRows) {
    console.log(`  …（共 ${rows.length} 行，仅显示前 ${opts.maxRows} 行）`);
  }
}

/* ============================================================
 * resolveRowById：id 前缀匹配通用实现（shared 供 B/C/D 段复用）
 * ============================================================ */

/**
 * 用 id 前缀取行（全 id 或唯一前缀命中；多命中/零命中抛错）。
 * 与主文件 findByIdPrefix 同口径，供 cmd-* 模块直接使用。
 * @param {Function} api
 * @param {string} table
 * @param {string} idPrefix
 * @param {string} [select='*']
 * @returns {Promise<object>} 命中行
 */
export async function resolveRowById(api, table, idPrefix, select = '*') {
  const p = String(idPrefix).trim();
  if (!p) throw new Error('id 前缀不能为空');
  const idRows = await api('GET', `${table}?select=id&limit=5000`);
  const hits = idRows.filter((r) => r.id === p || String(r.id).startsWith(p));
  if (!hits.length) throw new Error(`${table} 无 id 前缀为 ${p} 的行`);
  if (hits.length > 1) throw new Error(`id 前缀 ${p} 命中 ${hits.length} 行，请加长前缀`);
  const [row] = await api('GET', `${table}?select=${select}&id=eq.${encodeURIComponent(hits[0].id)}`);
  return row;
}

/* ============================================================
 * 动态发现：加载 lib/wb-cli/ 下所有 cmd-*.mjs 并注册
 * ============================================================ */

/**
 * 扫描 lib/wb-cli/ 下 cmd-*.mjs 模块，逐个 import 并调用其 register(registry, ctx)。
 * - 模块缺 register 导出 → 警告跳过（不炸主流程）
 * - 注册失败（重名等） → 抛错给主入口（配置类错误应显式失败）
 * @param {object} registry createRegistry() 实例
 * @param {object} ctx      makeCtx() 产物
 * @returns {Promise<string[]>} 成功注册的命令名列表
 */
export async function loadCmdModules(registry, ctx) {
  const names = [];
  const files = readdirSync(__wbcliDir)
    .filter((f) => /^cmd-[a-z0-9-]+\.mjs$/.test(f))
    .sort();
  for (const f of files) {
    try {
      const mod = await import(`file://${resolve(__wbcliDir, f)}`);
      // 验收适配（2026-09-04 dt_dod7ui S6）：并行段契约有三种形态，统一在 loader 归一——
      //  ① register(registry, ctx) + 元对象（A 段 registry.mjs 契约，D 段遵守）
      //  ② register(reg) 只传 (name, handler) 裸函数（B 段）→ 包一层 meta
      //  ③ 无 register，仅 command/run 导出（C 段）→ 现场适配注册
      if (typeof mod.register === 'function') {
        await mod.register(registry, ctx);
      } else if (typeof mod.command === 'string' && typeof mod.run === 'function') {
        registry.register(mod.command, {
          summary: String(mod.summary || ''),
          lines: Array.isArray(mod.usage) ? mod.usage : (Array.isArray(mod.usageLines) ? mod.usageLines : []),
          handler: (flags, pos, c) => mod.run(flags, pos, c || ctx),
        });
      } else {
        console.error(`ℹ️ [registry] ${f} 无 register/command+run 导出，跳过`);
        continue;
      }
      names.push(f.replace(/^cmd-/, '').replace(/\.mjs$/, ''));
    } catch (e) {
      throw new Error(`wb-cli 厊令模块 ${f} 加载失败：${e.message}`);
    }
  }
  return names;
}

/**
 * wb-cli · search 全域检索（三期 A 段 · dt_dod7ui；语义版 · dt_ihu09g B 段）
 * ------------------------------------------------
 * search 命令从主文件迁移至此并扩容：
 *   search <关键词>                        跨核心 8 表（记录三域拆分后）
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
 * 语义召回（dt_ihu09g B 段 · P0 修复 20260927）：
 * - 通道统一 Lighthouse api.liflow.cn（CloudBase 已整体弃用）
 * - embeddings 端点要求 admin key（openclaw/hermes 档实测 401），
 *   embed 专用解析 workbuddy admin key，仅用于生成查询向量（只读）
 * - 检索链路 RPC 404 → 客户端余弦兜底（千行级规模可行）
 * ============================================================ */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __cli_dirname = dirname(fileURLToPath(import.meta.url));
const WB_GATEWAY_REST_BASE = 'https://api.liflow.cn/v1/rest';
const WB_EMBED_URL = 'https://api.liflow.cn/v1/embeddings';
const SEMANTIC_RPC_TIMEOUT_MS = 2500;
const SEMANTIC_FETCH_TIMEOUT_MS = 5000;
const SEMANTIC_MIN_SIM = 0.3;
const SEMANTIC_RESULT_LIMIT = 20;
export const SEMANTIC_HYBRID_WEIGHTS = { similarity: 0.6, keyword: 0.3, recency: 0.1 };
const AGENTS_DIR = join(homedir(), '.workbuddy', 'agents');

/**
 * REST key 解析（Lighthouse wbk_ 单通道）：
 * ① env:WB_API_KEY → ② ~/.workbuddy/agents/<profile>.env（default/main/workbuddy 复用主 key）
 * 解析失败返回 key:null（调用方走降级/报错，不阻断关键词路径）
 */
async function resolveCliAuth() {
  const profile = process.env.WB_PROFILE || 'default';
  const profileKey = await readWbkKeyFromEnvFile(join(AGENTS_DIR, `${profile}.env`));
  if (profileKey) return { key: profileKey, source: `file:${profile}.env` };
  for (const name of ['default', 'main', 'workbuddy']) {
    const k = await readWbkKeyFromEnvFile(join(AGENTS_DIR, `${name}.env`));
    if (k) return { key: k, source: `file:${name}.env` };
  }
  return { key: null, source: 'none' };
}

async function readWbkKeyFromEnvFile(p) {
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf8');
    const m = raw.match(/^\s*WB_API_KEY\s*=\s*['"]?(wbk_[^\s'"]+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * embeddings 端点专用 key（实测 20260927：admin key 200 / openclaw wbk_ 401，
 * 错误信息 "valid login session or admin key required"）。
 * 仅用于把查询文本转成向量——纯只读用途，不得用于任何写库调用。
 * 顺序：env:WB_API_KEY → workbuddy.env(admin) → 当前 profile env
 */
async function resolveEmbedAuth() {
  if (process.env.WB_API_KEY) {
    return { key: process.env.WB_API_KEY, source: 'env:WB_API_KEY' };
  }
  const adminKey = await readWbkKeyFromEnvFile(join(AGENTS_DIR, 'workbuddy.env'));
  if (adminKey) return { key: adminKey, source: 'file:workbuddy.env' };
  const profile = process.env.WB_PROFILE || 'default';
  const profileKey = await readWbkKeyFromEnvFile(join(AGENTS_DIR, `${profile}.env`));
  if (profileKey) return { key: profileKey, source: `file:${profile}.env` };
  return { key: null, source: 'none' };
}

/** 构造 REST 请求头（Lighthouse ai-proxy Bearer wbk_） */
async function semanticHeaders(auth) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.key || ''}` };
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
  const embedAuth = await resolveEmbedAuth();
  try {
    const res = await semanticFetch(
      WB_EMBED_URL,
      {
        method: 'POST',
        headers: embedAuth.key
          ? { 'Content-Type': 'application/json', Authorization: `Bearer ${embedAuth.key}` }
          : { 'Content-Type': 'application/json' },
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

function textValue(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

export function calculateKeywordScore(query, hit) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 0;
  const metadata = hit.metadata || {};
  const haystack = [
    String(hit.chunk_text || '').toLowerCase(),
    textValue(metadata.title),
    textValue(metadata.source_path),
  ].filter(Boolean).join('\n');
  if (haystack.includes(q)) return 1;
  const tokens = q.split(/\s+/).filter((token) => token.length >= 2);
  if (!tokens.length) return 0;
  const matched = tokens.filter((token) => haystack.includes(token)).length;
  return matched === tokens.length ? 0.8 : (matched / tokens.length) * 0.4;
}

function parseMetadataTime(metadata) {
  if (!metadata) return null;
  for (const key of ['created_at', 'generated_at', 'updated_at']) {
    const time = Date.parse(textValue(metadata[key]).replace(' ', 'T'));
    if (Number.isFinite(time)) return time;
  }
  return null;
}

export function extractSourceTime(hit) {
  const metadataTime = parseMetadataTime(hit.metadata);
  if (metadataTime !== null) return { at: metadataTime, iso: new Date(metadataTime).toISOString() };
  const text = [textValue(hit.metadata?.title), textValue(hit.metadata?.source_path)].join('\n');
  const match = text.match(/(20\d{2}|19\d{2})-(\d{2})-(\d{2})/);
  if (match) {
    const time = Date.parse(`${match[0]}T00:00:00Z`);
    if (Number.isFinite(time)) return { at: time, iso: new Date(time).toISOString().slice(0, 10) };
  }
  return { at: null, iso: null };
}

function calculateRecencyScore(time, now) {
  if (time === null) return 0.5;
  const ageDays = Math.max(0, (now - time) / 86_400_000);
  return Math.exp(-ageDays / 730);
}

export function rankSemanticHits(hits, query, now = Date.now()) {
  return hits.map((hit) => {
    const sourceTime = extractSourceTime(hit);
    const keyword = calculateKeywordScore(query, hit);
    const recency = calculateRecencyScore(sourceTime.at, now);
    const similarity = Math.max(0, Math.min(Number(hit.similarity) || 0, 1));
    const score =
      similarity * SEMANTIC_HYBRID_WEIGHTS.similarity +
      keyword * SEMANTIC_HYBRID_WEIGHTS.keyword +
      recency * SEMANTIC_HYBRID_WEIGHTS.recency;
    return {
      ...hit,
      similarity,
      keyword_score: Number(keyword.toFixed(4)),
      recency_score: Number(recency.toFixed(4)),
      score: Number(score.toFixed(4)),
      source_time: sourceTime.iso,
    };
  }).sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.id).localeCompare(String(b.id)));
}

/**
 * CLI 语义召回（三级降级：RPC → 客户端余弦 → null）
 * 返回 [{ similarity, source_table, source_id, chunk_text }]；null = 语义通道整体不可用
 */
async function cliSemanticSearch(query, limit = 8) {
  const auth = await resolveCliAuth();
  const vec = await cliEmbedText(query);
  if (!vec || !vec.length) return null;
  if (!auth.key) return null;
  const headers = await semanticHeaders(auth);
  const base = WB_GATEWAY_REST_BASE;

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
  diaries: (r) => (r.title || r.plain_text || r.content_md || '').slice(0, 40),
  notes: (r) => (r.title || r.plain_text || r.content_md || '').slice(0, 40),
  fin_transactions: (r) => `${r.tx_date} ${r.counterparty_name || ''} ${r.goods_desc || r.notes || ''}`.trim().slice(0, 50),
  fin_accounts: (r) => r.account_name || r.account_no,
  people: (r) => `${r.name}${r.organization ? ` @${r.organization}` : ''}`,
};

/**
 * 语义命中与关键词命中合并：
 * - `(source_table, source_id)` 去重，同源保留混合分更高者；
 * - 关键词-only 命中 similarity=0，但仍由关键词分与时间分参与排序；
 * - 输出统一带总分与分项分，最多 20 条，避免 CLI 面板失控。
 */
export function mergeSemanticResults(semanticHits, keywordResults, query, now = Date.now()) {
  const best = new Map();
  const add = (hit) => {
    const key = `${hit.source_table}::${hit.source_id}`;
    const old = best.get(key);
    if (!old) {
      best.set(key, hit);
      return;
    }
    // 同源去重时保留更高展示位，但分项分取两者最优并重算总分。
    const base = (hit.score || 0) > (old.score || 0) ? hit : old;
    const similarity = Math.max(old.similarity || 0, hit.similarity || 0);
    const keywordScore = Math.max(old.keyword_score || 0, hit.keyword_score || 0);
    const recencyScore = Math.max(old.recency_score || 0, hit.recency_score || 0);
    best.set(key, {
      ...base,
      similarity,
      keyword_score: keywordScore,
      recency_score: recencyScore,
      score: Number((
        similarity * SEMANTIC_HYBRID_WEIGHTS.similarity +
        keywordScore * SEMANTIC_HYBRID_WEIGHTS.keyword +
        recencyScore * SEMANTIC_HYBRID_WEIGHTS.recency
      ).toFixed(4)),
      source_time: base.source_time || old.source_time || null,
    });
  };

  rankSemanticHits(semanticHits || [], query, now).forEach(add);
  for (const [table, rows] of Object.entries(keywordResults || {})) {
    if (!Array.isArray(rows)) continue;
    const display = DISPLAY_MAIN[table] || DISPLAY_MAIN.default;
    const idCol = idColOf(table);
    const searchFields = SEARCH_FIELDS[table] || ['title'];
    const keywordHits = rows.map((row) => ({
      id: String(row[idCol] || row.id || ''),
      source_table: table,
      source_id: String(row[idCol] || row.id || ''),
      chunk_text: [
        display(row),
        ...searchFields.map((field) => row[field]),
      ].filter((value) => typeof value === 'string' && value).join('\n'),
      metadata: typeof row.title === 'string' ? { title: row.title } : {},
      similarity: 0,
    }));
    rankSemanticHits(keywordHits, query, now).forEach(add);
  }

  return [...best.values()]
    .sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.id).localeCompare(String(b.id)))
    .slice(0, SEMANTIC_RESULT_LIMIT);
}

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
  if (table === 'diaries' || table === 'notes') { selSet.add('title'); selSet.add('plain_text'); selSet.add('content_md'); }
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
      mode: 'semantic-hybrid',
      ranking: 'similarity+keyword+recency',
      degraded: false,
      keyword: kw,
      scope: scopeLabel,
      count: hits.length,
      results: hits.map((h) => ({
        score: Number(((h.score || 0) * 100).toFixed(1)),
        similarity: Number((h.similarity * 100).toFixed(1)),
        keyword_score: Number(((h.keyword_score || 0) * 100).toFixed(1)),
        recency_score: Number(((h.recency_score || 0) * 100).toFixed(1)),
        source_table: h.source_table,
        source_id: h.source_id,
        chunk_text: h.chunk_text,
        source_time: h.source_time || null,
      })),
    },
    () => {
      console.log(`语义混合搜索「${kw}」命中 ${hits.length} 条（按综合分降序）：\n`);
      for (const h of hits) {
        const summary = String(h.chunk_text || '').replace(/\s+/g, ' ').slice(0, 60);
        console.log(
          `  · [${h.source_table}] ${h.source_id}  综合 ${Math.round((h.score || 0) * 100)}% / 相关 ${Math.round(h.similarity * 100)}% / 关键词 ${Math.round((h.keyword_score || 0) * 100)}%`
        );
        console.log(`    ${summary}`);
      }
      console.log(`\n（混合排序：向量 ${SEMANTIC_HYBRID_WEIGHTS.similarity} + 关键词 ${SEMANTIC_HYBRID_WEIGHTS.keyword} + 时间 ${SEMANTIC_HYBRID_WEIGHTS.recency}；向量阈值 ${Math.round(SEMANTIC_MIN_SIM * 100)}%）`);
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

  let semanticHits = null;
  let semanticDegraded = false;
  if (flags.semantic) {
    // null = 通道不可用（降级关键词）；[] = 通道正常但零命中（正常输出）
    semanticHits = await cliSemanticSearch(kw, SEMANTIC_RESULT_LIMIT);
    if (!semanticHits) semanticDegraded = true;
    if (semanticDegraded) console.error('⚠️ 语义通道不可用（向量接口或 embeddings 表异常），回落关键词检索');
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
    targets = SEARCH_CORE_TABLES;
  }

  const settled = await collectResults(api, targets, kw);
  const results = {};
  let failedTables = [];
  for (const { t, rows } of settled) {
    if (rows === null) failedTables.push(t);
    else if (rows.length) results[t] = rows;
  }

  // --semantic：语义向量命中 + ilike 关键词命中合并重排；通道可用时不走纯关键词输出。
  if (semanticHits) {
    const scopedHits = semanticHits.filter((h) => targets.includes(h.source_table));
    renderSemanticOutput(output, kw, mergeSemanticResults(scopedHits, results, kw), scopeLabel);
    return;
  }

  output({
    mode: semanticDegraded ? 'keyword-fallback' : 'keyword',
    degraded: semanticDegraded,
    keyword: kw,
    scope: scopeLabel,
    count: Object.values(results).reduce((n, a) => n + a.length, 0),
    results,
    failed: failedTables,
  }, () => {
    const total = Object.values(results).reduce((n, arr) => n + arr.length, 0);
    if (!total) {
      console.log(`「${kw}」无结果（范围：${scopeLabel}${semanticDegraded ? '；语义已降级关键词' : ''}${failedTables.length ? `；${failedTables.join('、')} 检索失败已跳过` : ''}）`);
      return;
    }
    console.log(`${semanticDegraded ? '[语义降级] ' : ''}搜索「${kw}」命中 ${total} 条（范围：${scopeLabel}）：\n`);
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
    summary: '全域 ilike 检索（默认核心 8 表；--table/--domain 扩到全表白名单；--semantic 语义召回）',
    lines: [
      '  search <关键词>                         跨核心 8 表（todos/capsules/diaries/notes/ai_ideas/ai_bugs/articles_inbox/people）',
      '  search <关键词> --table <表名>          指定任意业务表（44 张白名单，table list 查看）',
      '  search <关键词> --domain <域名>         按域检索（待办/闪念笔记/日程/人脉/ORPT/财务/成长/画布/产物/决策/日志/AI开发）',
      '  search <关键词> --semantic              语义召回（embeddings 统一语义层，带相似度；不可用自动降级关键词）',
    ],
    handler: (flags, pos) => cmdSearchAll(flags, pos, ctx),
  });
}

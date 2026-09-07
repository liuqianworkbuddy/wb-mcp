/**
 * wb-auth —— AI 工作台 CLI 工具统一认证模块（2026-08-31 方案 A）
 * ------------------------------------------------------------
 * 背景：2026-08-28 RLS 收紧（30 张表 anon 全拒）后，所有直连
 *       CloudBase PG REST 的 CLI 工具全线 401。新通道：ai-proxy
 *       /v1/rest/* 鉴权转发（Bearer wbk_ 开头的 API Key），
 *       service_role 密钥只活在云端，永不落盘 agent 侧。
 *
 * Key 读取链（优先级从高到低）：
 *   ① WB_API_KEY 环境变量
 *   ② ~/.workbuddy/agents/<profile>.env 的 WB_API_KEY=wbk_...
 *      （profile 由 --profile 参数或 WB_PROFILE 环境变量指定，默认 workbuddy）
 *   ③ 旧链兜底：CLOUDBASE_API_KEY → ~/.workbuddy/cloudbase.env →
 *      lib/cloudbase-config.ts（anon 已死，仅保迁移期兼容，直连 REST）
 *
 * 权限档位（v5.10.1 起与渠道名解耦）：渠道里显式写 WB_SCOPE=
 *   admin(全权) | readwrite(读写) | readonly(只读)。读取优先级：
 *   环境变量 WB_SCOPE → 渠道 env 文件里的 WB_SCOPE → null（未声明，
 *   由调用方按旧约定兜底）。scope 只是客户端声明（决定注册哪些工具），
 *   真正拦截在服务端（ai-proxy 按 key 的 scope 校验 + RLS）。
 *
 * 零 npm 依赖；Node ≥18。所有 scripts/*.mjs 与 gateway 共用。
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** 仓库根（lib/ → 上一级） */
export const REPO_ROOT = resolve(__dirname, '..');

/** 新通道：ai-proxy 云托管（v1.5+ 的 /v1/rest 鉴权转发） */
export const GATEWAY_BASE =
  process.env.WB_GATEWAY_URL ||
  'https://api.liflow.cn/v1/rest';

/** 旧通道：CloudBase PG REST 直连（迁移期兜底） */
export const DIRECT_BASE =
  'https://aiworkbech-d7gha8jzi68c36019.api.tcloudbasegateway.com/v1/rdb/rest';

/** 内置兜底公钥（anon，RLS 收紧后基本不可用；仅保证极端情况下可连公开表） */
const FALLBACK_KEY =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6IjEwMGE1MGElLTM4MTktNDlmNi04YzBmLWRkZTIzZGY0MmM5ZCJ9.eyJpc3MiOiJodHRwczovL2Fpd29ya2JlY2gtZDdnaGE4anppNjhjMzYwMTkuYXAtc2hhbmdoYWkudGNiLWFwaS50ZW5jZW50Y2xvdWRhcGkuY29tIiwic3ViIjoiYW5vbiIsImF1ZCI6ImFpd29ya2JlY2gtZDdnaGE4anppNjhjMzYwMTkiLCJleHAiOjQwOTA4MTA1MDAsImlhdCI6MTc4NzEyNzMwMCwibm9uY2UiOiJVUG1ZbnIwY1IzQ3dUNEJQYkZmdlhRIiwiYXRfaGFzaCI6IlVQbVlucjBjUjNDd1Q0QlBiRmZ2WFEiLCJuYW1lIjoiQW5vbnltb3VzIiwic2NvcGUiOiJhbm9ueW1vdXMiLCJwcm9qZWN0X2lkIjoiYWl3b3JrYmVjaC1kN2doYThqemk2OGMzNjAxOSIsIm1ldGEiOnsicGxhdGZvcm0iOiJQdWJsaXNoYWJsZUtleSJ9LCJyb2xlIjoiYW5vbiIsImlzX2Fub255bW91cyI6dHJ1ZSwiYXBwX21ldGFkYXRhIjp7InByb3ZpZGVyIjoiYW5vbnltb3VzIiwicHJvdmlkZXJzIjpbImFub255bW91cyJdfSwidXNlcl9tZXRhZGF0YSI6eyJuYW1lIjoiQW5vbnltb3VzIn0sInVzZXJfdHlwZSI6IiIsImNsaWVudF90eXBlIjoiY2xpZW50X3VzZXIiLCJpc19zeXN0ZW1fYWRtaW4iOmZhbHNlfQ.dkHZY-sDfDsTSYH-3hccw_TzWIAHyxuyHZXYcO9YU3_UKZJUsle8qdylq-iuDoOa8U2RTYeYCslu_mGWOmtCZVhKeDN1fPXlq2JMcSgEFZ__0ABKMPmg-QUqgQOreRuwVku2qqvig3gvbvi2z-JHIOTGB9gLGJATb9itF0Uv1wyGGUSfcfBSI50nsB3O0aBOkcLcn2r-ikURxi8UNNP9thsX76DM-kiPlXRWqyzhaGtju2gt-kujHd8V9QwZ02JDPP1ewIishqA_lhHMo8Blqpz1CCDiF--KyFnrZncm8EvZHILaPzFkGXlaQ2LjouuP-wxwBheb1lo9hYBbYZ2Hbw';

/** 从 env 文件文本中提取首个匹配变量（支持 export 前缀与引号） */
function envMatch(txt, names) {
  for (const n of names) {
    const m = txt.match(new RegExp(`^\\s*(?:export\\s+)?${n}\\s*=\\s*['"]?([^\\s'"]+)`, 'mi'));
    if (m) return m[1];
  }
  return null;
}

/** profile 名合法化（防路径穿越）：仅 [a-z0-9-_] */
export function normalizeProfile(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return s || 'workbuddy';
}

/** 权限档位归一化：仅认 admin/readwrite/readonly，其余视为未声明（null） */
const VALID_SCOPES = ['admin', 'readwrite', 'readonly'];
function normalizeScope(v) {
  const s = String(v || '').toLowerCase().trim();
  return VALID_SCOPES.includes(s) ? s : null;
}

/**
 * 解析 API Key（新链优先，旧链兜底）
 * 返回 { mode: 'gateway'|'legacy', key, profile, source }
 *  - gateway：持 wbk_ key，走 ai-proxy /v1/rest
 *  - legacy ：持旧 key（service_key 或已死的 anon），直连 REST
 */
export function resolveAuth(opts = {}) {
  const profile = normalizeProfile(opts.profile || process.env.WB_PROFILE || 'workbuddy');

  // ① 环境变量（scope 同样可用环境变量显式声明）
  const envScope = normalizeScope(process.env.WB_SCOPE);
  if (process.env.WB_API_KEY && process.env.WB_API_KEY.startsWith('wbk_')) {
    return { mode: 'gateway', key: process.env.WB_API_KEY, scope: envScope, profile, source: 'env:WB_API_KEY' };
  }

  // ② profile env 文件 ~/.workbuddy/agents/<profile>.env
  const agentEnv = resolve(homedir(), '.workbuddy/agents', `${profile}.env`);
  if (existsSync(agentEnv)) {
    const txt = readFileSync(agentEnv, 'utf8');
    const k = envMatch(txt, ['WB_API_KEY']);
    if (k && k.startsWith('wbk_')) {
      return {
        mode: 'gateway', key: k,
        scope: envScope ?? normalizeScope(envMatch(txt, ['WB_SCOPE'])),
        profile, source: `file:${agentEnv}`,
      };
    }
  }
  // ②b 默认 workbuddy env（任何 profile 都可复用主 key）
  if (profile !== 'workbuddy') {
    const mainEnv = resolve(homedir(), '.workbuddy/agents/workbuddy.env');
    if (existsSync(mainEnv)) {
      const txt = readFileSync(mainEnv, 'utf8');
      const k = envMatch(txt, ['WB_API_KEY']);
      if (k && k.startsWith('wbk_')) {
        return {
          mode: 'gateway', key: k,
          scope: envScope ?? normalizeScope(envMatch(txt, ['WB_SCOPE'])),
          profile, source: `file:${mainEnv}`,
        };
      }
    }
  }

  // ③ 旧链兜底（MM 等已有 cloudbase.env service_key 的环境仍可用）
  if (process.env.CLOUDBASE_API_KEY) {
    return { mode: 'legacy', key: process.env.CLOUDBASE_API_KEY, scope: null, profile, source: 'env:CLOUDBASE_API_KEY' };
  }
  const envPath = resolve(homedir(), '.workbuddy/cloudbase.env');
  if (existsSync(envPath)) {
    const txt = readFileSync(envPath, 'utf8');
    const api = envMatch(txt, ['CLOUDBASE_API_KEY']);
    if (api) return { mode: 'legacy', key: api, scope: null, profile, source: `file:${envPath}` };
    const pub = envMatch(txt, ['(?:CLOUDBASE_)?PUBLISHABLE_KEY']);
    if (pub) return { mode: 'legacy', key: pub, scope: null, profile, source: `file:${envPath}(publishable)` };
  }
  const cfgPath = join(REPO_ROOT, 'lib', 'cloudbase-config.ts');
  if (existsSync(cfgPath)) {
    const m = readFileSync(cfgPath, 'utf8').match(/PUBLISHABLE_KEY\s*=\s*\n?\s*'([^']+)'/);
    if (m) return { mode: 'legacy', key: m[1], scope: null, profile, source: 'lib/cloudbase-config.ts' };
  }
  return { mode: 'legacy', key: FALLBACK_KEY, scope: null, profile, source: 'builtin-fallback(anon,RLS 后不可用)' };
}

/**
 * 统一 REST 调用（wb-cli / ai-bug-cli 等 api() 的同构封装）。
 * - gateway 模式：POST/GET/PATCH/DELETE → ai-proxy /v1/rest/<path>
 * - legacy  模式：直连 CloudBase PG REST（旧行为原样保留）
 * 报错格式与旧 api() 一致：`${method} ${path} → ${status}: ${text}`
 */
export function makeApi(opts = {}) {
  const auth = resolveAuth(opts);
  const base = auth.mode === 'gateway' ? GATEWAY_BASE : DIRECT_BASE;

  async function api(method, path, body, reqOpts = {}) {
    // reqOpts.headers 可透传附加请求头（如 Prefer: resolution=merge-duplicates），
    // 同名键以后传者为准——修复 fin-import 幂等 upsert 头被吞导致重跑 409 的 bug。
    const headers = {
      'Content-Type': 'application/json',
      ...(body ? { Prefer: 'return=representation' } : {}),
      ...(reqOpts.headers || {}),
    };
    if (auth.mode === 'gateway') {
      headers.Authorization = `Bearer ${auth.key}`;
    } else {
      headers.apikey = auth.key;
      headers.Authorization = `Bearer ${auth.key}`;
    }
    const res = await fetch(`${base}/${path}`, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    try { return text ? JSON.parse(text) : null; } catch { return text; }
  }

  return { auth, base, api };
}

/** 提示文案：legacy 模式下提示配置新 key（只打印一次，不打断） */
export function authHint(auth) {
  if (auth.mode === 'gateway') return null;
  return `[wb-auth] 未找到 WB_API_KEY（走旧通道 ${auth.source}；RLS 收紧后旧 key 可能 401）。` +
    `配置方法：在 AI 工作台 /settings/ 签发 API Key 后写入 ~/.workbuddy/agents/${auth.profile}.env 的 WB_API_KEY=wbk_...`;
}

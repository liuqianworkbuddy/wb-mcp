/**
 * wb-cli · vault 云档只读域（P1 C 段 · dt_iy2eek）
 * ------------------------------------------------
 * 三命令（全部只读，无写动词，天然免 confirm 门）：
 *   vault list [前缀] [--limit 50]           目录树（vault_files 按顶层目录分组计数）
 *   vault search <词> [--from --to]          ILIKE 检索（title+path 双字段 or + mtime 区间）
 *   vault read <path> [--offset 0] [--lines 200]   COS 签名 GET 拉全文（行分页，适配 MCP 8KB 截断）
 *
 * 数据通道：
 *   - list/search → ctx.api（wb-auth gateway，vault_files 索引表【B 段建】）
 *   - read → COS vault-store 桶 obsidian/ 前缀（自实现 STS+DescribeStaticStore+v5 签名 GET 链，
 *     进程内单例缓存；只读参照 scripts/cos-put-one.mjs 的 PUT 链与 A 段 vault-import.mjs，不 import）
 *
 * 契约：export register(registry, ctx)（lib/wb-cli/registry.mjs A 段）；
 *       零 npm 依赖，Node ≥18（fetch/crypto/fs 原生）。
 * 任务包：dt_iy2eek 任务包 C（关联待办 c41c13ca，manual 来源打标须 --user-ok）。
 */

import { createHash, createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const COS_REGION = 'ap-shanghai';
const VAULT_KEY_PREFIX = 'obsidian/'; // COS 桶内前缀（P0 桶规范定稿）

/* ============================================================
 * COS 签名 GET 链（STS 临时凭证 + DescribeStaticStore 桶解析 + v5 GET 签名）
 * 凭证/桶解析进程内单例；到期前 5 分钟预刷新；403 强制刷新重试一次。
 * ============================================================ */

function loadCloudEnv(names) {
  const out = {};
  const envPath = resolve(homedir(), '.workbuddy/cloudbase.env');
  if (existsSync(envPath)) {
    const txt = readFileSync(envPath, 'utf8');
    for (const name of names) {
      const m = txt.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*['"]?([^\\s'"]+)`, 'm'));
      if (m) out[name] = m[1];
    }
  }
  return out;
}

function cloudConfig() {
  const f = loadCloudEnv(['CLOUDBASE_API_KEY', 'CLOUDBASE_ENV_ID']);
  return {
    apiKey: process.env.CLOUDBASE_API_KEY || f.CLOUDBASE_API_KEY,
    envId: process.env.CLOUDBASE_ENV_ID || f.CLOUDBASE_ENV_ID,
  };
}

/** 带超时 fetch（30s，COS 大文件兜底） */
async function fetchT(url, opts = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

/** STS 临时凭证单例状态 */
let _cos = null; // { host, cred:{secretId,secretKey,token}, expireMs }

async function ensureCos(force = false) {
  const now = Date.now();
  if (!force && _cos && _cos.expireMs - now > 5 * 60 * 1000) return _cos;

  const { apiKey, envId } = cloudConfig();
  if (!apiKey || !envId) {
    throw new Error('缺 CLOUDBASE_API_KEY / CLOUDBASE_ENV_ID（env 或 ~/.workbuddy/cloudbase.env）');
  }

  // ① STS 临时凭证
  const credRes = await fetchT(`https://${envId}.${COS_REGION}.tcb-api.tencentcloudapi.com/capi/credential`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ env: envId }),
  });
  if (!credRes.ok) throw new Error(`STS → ${credRes.status}`);
  const credJson = JSON.parse(await credRes.text());
  const d = credJson?.data;
  if (credJson.code !== 0 || !d?.TmpSecretId) {
    throw new Error('STS 失败: ' + JSON.stringify(credJson).slice(0, 150));
  }
  const cred = { secretId: d.TmpSecretId, secretKey: d.TmpSecretKey, token: d.Token };
  const expireSec = Number(d.ExpiredTime || d.ExpireTime || 0);
  const expireMs = expireSec > 0 ? expireSec * 1000 : now + 55 * 60 * 1000;

  // ② DescribeStaticStore 解析 vault-store 桶（TC3 签名；Regoin||Region 拼写坑先例已处理）
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const payload = JSON.stringify({ EnvId: envId });
  const sha256hex = (s) => createHash('sha256').update(s).digest('hex');
  const canonical = `POST\n/\n\ncontent-type:application/json\nhost:tcb.tencentcloudapi.com\n\ncontent-type;host\n${sha256hex(payload)}`;
  const scope = `${date}/tcb/tc3_request`;
  const s2s = `TC3-HMAC-SHA256\n${ts}\n${scope}\n${sha256hex(canonical)}`;
  const kDate = createHmac('sha256', `TC3${cred.secretKey}`).update(date).digest();
  const kSvc = createHmac('sha256', kDate).update('tcb').digest();
  const kSign = createHmac('sha256', kSvc).update('tc3_request').digest();
  const sig = createHmac('sha256', kSign).update(s2s).digest('hex');
  const storeRes = await fetchT('https://tcb.tencentcloudapi.com/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-TC-Action': 'DescribeStaticStore',
      'X-TC-Region': COS_REGION,
      'X-TC-Timestamp': String(ts),
      'X-TC-Version': '2018-06-08',
      'X-TC-Token': cred.token,
      Authorization: `TC3-HMAC-SHA256 Credential=${cred.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${sig}`,
    },
    body: payload,
  });
  const storeJson = JSON.parse(await storeRes.text());
  const stores = storeJson?.Response?.Data || [];
  const bucket = stores.find((s) => s.Bucket && String(s.Bucket).includes('-static-'))
    || stores.find((s) => s.Status === 'online')
    || stores[0];
  if (!bucket?.Bucket) throw new Error('无 vault-store 桶: ' + JSON.stringify(storeJson).slice(0, 200));
  const region = bucket.Regoin || bucket.Region || COS_REGION;

  _cos = { host: `${bucket.Bucket}.cos.${region}.myqcloud.com`, cred, expireMs };
  return _cos;
}

/** RFC3986 大写转义（汉字/emoji 路径签名必须，v5 先例） */
const camEncode = (s) =>
  encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** 构造 v5 签名 GET 请求（返回 { url, auth }）
 * 🔴 签名 UriPathname 必须用原始未编码路径，URL 才用 RFC3986 编码路径
 *    （六变体判别实验实锤：签名enc+URLenc 对中文/emoji 路径必 403 SignatureDoesNotMatch；
 *      纯 ASCII 不受影响 enc==原文，P0 ping 验证盲区。先例：feature/dt-iy2eek-a bb9a3a7）
 */
function buildSignedGet(cos, key) {
  const { cred, host } = cos;
  const start = Math.floor(Date.now() / 1000);
  const keyTime = `${start};${start + 600}`;
  const signKey = createHmac('sha1', cred.secretKey).update(keyTime).digest('hex');
  const signPath = '/' + key;
  const urlPath = '/' + key.split('/').map(camEncode).join('/');
  const params = { 'x-cos-security-token': cred.token };
  const headers = { host };
  const httpParameters = Object.keys(params).sort().map((k) => `${camEncode(k)}=${camEncode(params[k])}`).join('&');
  const headerKeys = Object.keys(headers).sort();
  const httpHeaders = headerKeys.map((k) => `${camEncode(k)}=${camEncode(headers[k])}`).join('&');
  const httpString = `get\n${signPath}\n${httpParameters}\n${httpHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${createHash('sha1').update(httpString).digest('hex')}\n`;
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex');
  const auth = [
    'q-sign-algorithm=sha1',
    `q-ak=${cred.secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    'q-header-list=host',
    'q-url-param-list=x-cos-security-token',
    `q-signature=${signature}`,
  ].join('&');
  return { url: `https://${host}${urlPath}?${httpParameters}`, auth };
}

/**
 * COS 拉全文（UTF-8 解码，BOM 剥离）。403 时强制刷新凭证重试一次。
 * @param {string} key COS 对象 key（obsidian/<vault相对路径>）
 * @returns {Promise<string>} 全文文本
 */
async function cosGetText(key) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let cos;
    try {
      cos = await ensureCos(attempt > 0);
    } catch (e) {
      throw new Error(`COS 凭证链失败：${String(e.message || e).slice(0, 160)}`);
    }
    const { url, auth } = buildSignedGet(cos, key);
    const res = await fetchT(url, { headers: { Authorization: auth } });
    if (res.status === 403 && attempt === 0) { lastErr = new Error('COS 403（凭证过期，刷新重试）'); continue; }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`COS GET ${key} → ${res.status}: ${t.slice(0, 150)}`);
    }
    const buf = await res.arrayBuffer();
    return new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/^\uFEFF/, '');
  }
  throw lastErr || new Error('COS GET 失败');
}

/* ============================================================
 * 展示辅助
 * ============================================================ */

const fmtBytes = (n) => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v}B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`;
  return `${(v / 1024 / 1024).toFixed(2)}MB`;
};

const fmtDate = (v) => {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 16);
  return d.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
};

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : (t || '（无标题）');
};

/** vault_files.path → COS key（容错：兼容带/不带 obsidian/ 前缀） */
function toCosKey(path) {
  let p = String(path || '').trim().replace(/^\/+/, '');
  if (p.startsWith(VAULT_KEY_PREFIX)) return p;
  return VAULT_KEY_PREFIX + p;
}

/** 索引层归一 path（读桶与查索引共用：去 obsidian/ 前缀、拒 .. 穿越） */
function normalizeVaultPath(raw) {
  let p = String(raw || '').trim().replace(/^\/+/, '');
  if (p.startsWith(VAULT_KEY_PREFIX)) p = p.slice(VAULT_KEY_PREFIX.length);
  if (!p) throw new Error('path 不能为空');
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new Error(`非法 path（禁止相对段）：${p}`);
  }
  return p;
}

/** 索引表未就绪/为空的友好提示（B 段建表、A 段导入的依赖显式化） */
const TABLE_HINT = 'vault_files 索引表未就绪（依赖：B 段建表迁移 + A 段全量导入）。表探测：GET vault_files?select=id&limit=1 返回 200 即就绪。';

/* ============================================================
 * 命令实现
 * ============================================================ */

/** vault list：索引分组目录树 */
async function vaultList(flags, pos, ctx) {
  const prefixRaw = String(pos[0] || '').trim().replace(/^\/+/, '');
  const limit = Math.max(1, Math.min(200, parseInt(String(flags.limit ?? '50'), 10) || 50));

  // 翻页拉全量（REST 通道单页上限 1000 行，2760 篇需 3 页；参照 A 段 loadIndexMap 同款循环）
  const PAGE = 1000;
  let base = 'vault_files?select=path,title';
  if (prefixRaw) base += `&path=ilike.${encodeURIComponent(prefixRaw)}*`;
  let rows = [];
  try {
    for (let offset = 0; ; offset += PAGE) {
      const page = await ctx.api('GET', `${base}&order=path.asc&limit=${PAGE}&offset=${offset}`);
      if (!Array.isArray(page)) throw new Error('非数组返回');
      rows = rows.concat(page);
      if (page.length < PAGE) break;
    }
  } catch (e) {
    console.error(`❌ ${TABLE_HINT}\n   ${String(e.message || e).slice(0, 160)}`);
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(rows) || !rows.length) {
    console.log(prefixRaw ? `（前缀「${prefixRaw}」下无文件${rows ? '' : '，或索引为空'}）` : '（索引为空——A 段全量导入未跑）');
    return;
  }

  // 分组：prefix 下钻一层（prefix 命中目录则取其下一级，否则取顶层）
  const groups = new Map(); // dir -> { count, sample }
  let rootFiles = 0;
  let rootSample = '';
  for (const r of rows) {
    let rel = String(r.path || '');
    if (prefixRaw && rel.startsWith(prefixRaw)) rel = rel.slice(prefixRaw.length);
    rel = rel.replace(/^\//, '');
    const seg = rel.split('/');
    if (seg.length <= 1) {
      rootFiles++;
      if (!rootSample) rootSample = r.title || seg[0];
      continue;
    }
    const dir = seg[0];
    if (!groups.has(dir)) groups.set(dir, { count: 0, sample: r.title || seg[seg.length - 1] || '' });
    groups.get(dir).count++;
  }

  const dirs = [...groups.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, limit);

  ctx.output({
    prefix: prefixRaw || null,
    totalFiles: rows.length,
    totalDirs: groups.size + (rootFiles ? 1 : 0),
    dirs: dirs.map(([dir, v]) => ({ dir, count: v.count, sample: clip(v.sample, 40) })),
    rootFiles,
    truncated: groups.size > limit,
  }, () => {
    console.log(`vault 云档${prefixRaw ? ` · 前缀「${prefixRaw}」` : ''} · 共 ${rows.length} 篇 / ${groups.size + (rootFiles ? 1 : 0)} 组：\n`);
    for (const [dir, v] of dirs) {
      console.log(`📁 ${dir} · ${v.count} 篇 · 例: ${clip(v.sample, 40)}`);
    }
    if (rootFiles) console.log(`📄 （本层文件）· ${rootFiles} 篇 · 例: ${clip(rootSample, 40)}`);
    if (groups.size > limit) console.log(`  …（共 ${groups.size} 组，仅显示前 ${limit} 组，--limit 调整）`);
  });
}

/** vault search：ILIKE + mtime 区间 */
async function vaultSearch(flags, pos, ctx) {
  const kw = pos.join(' ').trim();
  if (!kw) {
    console.error('用法: vault search <词> [--from YYYY-MM-DD] [--to YYYY-MM-DD]');
    process.exitCode = 1;
    return;
  }
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const from = typeof flags.from === 'string' ? flags.from : null;
  const to = typeof flags.to === 'string' ? flags.to : null;
  if (from && !dateRe.test(from)) { console.error('❌ --from 须为 YYYY-MM-DD'); process.exitCode = 1; return; }
  if (to && !dateRe.test(to)) { console.error('❌ --to 须为 YYYY-MM-DD'); process.exitCode = 1; return; }

  // kw 中的 ,() 会破坏 PostgREST or=() 语法，剔除
  const kwSafe = kw.replace(/[,()]/g, ' ').trim();
  if (!kwSafe) { console.error('❌ 关键词仅含非法字符（, 或括号）'); process.exitCode = 1; return; }

  const orClause = `or=(title.ilike.*${encodeURIComponent(kwSafe)}*,path.ilike.*${encodeURIComponent(kwSafe)}*)`;
  let q = `vault_files?select=path,title,size,mtime&${orClause}`;
  if (from) q += `&mtime=gte.${from}`;
  if (to) q += `&mtime=lte.${to}`;
  q += '&order=mtime.desc.nullslast&limit=30';

  let rows;
  try {
    rows = await ctx.api('GET', q);
  } catch (e) {
    console.error(`❌ ${TABLE_HINT}\n   ${String(e.message || e).slice(0, 160)}`);
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(rows) || !rows.length) {
    console.log(`（「${kw}」无命中${from || to ? '（含日期过滤）' : ''}——可换关键词或 vault list 浏览目录）`);
    return;
  }

  ctx.output({
    keyword: kw,
    from, to,
    count: rows.length,
    hits: rows.map((r) => ({
      path: r.path,
      title: clip(r.title, 60),
      size: r.size,
      mtime: r.mtime,
    })),
  }, () => {
    console.log(`「${kw}」命中 ${rows.length} 条（mtime 降序，上限 30）：\n`);
    for (const r of rows) {
      console.log(`📄 ${r.path}`);
      console.log(`   ${clip(r.title, 60)} · ${fmtBytes(r.size)} · ${fmtDate(r.mtime)}`);
    }
  });
}

/** vault read：COS 拉全文按行分页 */
async function vaultRead(flags, pos, ctx) {
  const rawPath = pos.slice(1).join(' ').trim();
  if (!rawPath) {
    console.error('用法: vault read <path> [--offset 0] [--lines 200]（path 经 vault search 获取）');
    process.exitCode = 1;
    return;
  }
  let path;
  try {
    path = normalizeVaultPath(rawPath);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
    return;
  }
  const offset = Math.max(0, parseInt(String(flags.offset ?? '0'), 10) || 0);
  const lines = Math.max(1, Math.min(1000, parseInt(String(flags.lines ?? '200'), 10) || 200));

  // 索引层 meta（表未就绪不阻断，直接读桶）
  let meta = null;
  try {
    const rows = await ctx.api('GET', `vault_files?select=path,title,size,mtime&path=eq.${encodeURIComponent(path)}&limit=1`);
    if (Array.isArray(rows) && rows.length) meta = rows[0];
  } catch { /* B 段未建表时降级直读桶 */ }

  let text;
  try {
    text = await cosGetText(toCosKey(path));
  } catch (e) {
    console.error(`❌ ${String(e.message || e).slice(0, 200)}${meta ? '' : '\n   （索引未登记此文件——A 段导入完成后可用 vault search 定位）'}`);
    process.exitCode = 1;
    return;
  }

  const all = text.split('\n');
  const total = all.length;
  const from = Math.min(offset, Math.max(total - 1, 0));
  const to = Math.min(from + lines, total);
  const slice = all.slice(from, to);
  const nextOffset = to < total ? to : null;
  const nextPageCmd = `vault read "${path}" --offset ${to} --lines ${lines}`;

  ctx.output({
    path,
    title: meta?.title || null,
    size: meta?.size ?? text.length,
    mtime: meta?.mtime || null,
    totalLines: total,
    fromLine: from + 1,
    toLine: to,
    nextOffset,
    nextPageCmd,
    content: slice.map((l, i) => `${from + i + 1} | ${l}`).join('\n'),
  }, () => {
    if (meta) {
      console.log(`📄 ${meta.title || path}`);
      console.log(`   ${fmtBytes(meta.size)} · mtime ${fmtDate(meta.mtime)} · COS key ${toCosKey(path)}\n`);
    } else {
      console.log(`📄 ${path}（索引未登记，直读桶）\n`);
    }
    for (let i = 0; i < slice.length; i++) {
      console.log(`${String(from + i + 1).padStart(5)} | ${slice[i]}`);
    }
    console.log(`\n—— 共 ${total} 行，已显示 ${from + 1}–${to} 行` +
      (nextOffset !== null ? `；下一页: ${nextPageCmd}` : '（到末尾）'));
  });
}

/* ============================================================
 * 注册（registry 契约）
 * ============================================================ */

/** @param {import('./shared.mjs').Ctx} ctx */
export function register(reg, ctx) {
  reg.register('vault', {
    summary: 'vault 云档只读：list 目录树 / search 关键词 / read 全文（COS vault-store）',
    lines: [
      '  vault list [前缀] [--limit 50]              目录树（索引分组计数）',
      '  vault search <词> [--from --to 日期]        ILIKE 检索（title+path，mtime 区间）',
      '  vault read <path> [--offset 0] [--lines 200]  COS 拉全文（行分页，适配 8KB 截断）',
    ],
    handler: (flags, pos) => cmdVault(flags, pos, ctx),
  });
}

async function cmdVault(flags, pos, ctx) {
  const sub = pos[0] || 'list';
  if (sub === 'list' || pos.length === 0) return vaultList(flags, pos.slice(1), ctx);
  if (sub === 'search') return vaultSearch(flags, pos.slice(1), ctx);
  if (sub === 'read') return vaultRead(flags, pos, ctx);
  console.error(`未知子命令：${sub}（支持 list / search / read）`);
  process.exitCode = 1;
}

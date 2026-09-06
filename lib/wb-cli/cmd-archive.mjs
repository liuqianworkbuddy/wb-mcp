/**
 * wb-cli · archive 记忆档案只读域（P4 C 段 · dt_mkq335）
 * ------------------------------------------------
 * 四命令（只读消费，无档案写动词；生成只经 A 段脚本 gen 透传）：
 *   archive list [--limit 50]           vault_files 前缀 archive/ 清单（path/size/mtime）
 *   archive show <名> [--head N]        COS 签名 GET 拉 md 全文（--head N 截断行数）
 *   archive gen [--since YYYY-MM-DD]    spawn A 段 scripts/profile-gen.mjs（透传参数+退出码）
 *   archive detect [--days 30] [--json] 近 N 天 capsules+decision_logs × 档案节选 → 矛盾/关联清单
 *
 * 数据通道：
 *   - list → ctx.api（wb-auth gateway，vault_files 索引表）
 *   - show → COS vault-store 桶 archive/ 前缀。签名链自实现：STS + DescribeStaticStore +
 *     v5 签名 GET，进程内单例 + 403 刷新重试——照抄 vault P1 先例（cmd-vault.mjs），
 *     🔴 不 import cmd-vault 内部函数（并行纪律：规避段间文件耦合）
 *   - gen → spawn node scripts/profile-gen.mjs，退出码原样透传；脚本缺失提示 A 段未合并
 *   - detect → dashscope compatible-mode（qwen-flash，cmd-fin aiExtractFin 同款调用），
 *     Key 降级链同 cmd-fin 先例（env → ~/.workbuddy/bailian.env → cloudbase.env）；
 *     无 Key / LLM 失败 → 打印素材摘要降级，退出码 0
 *
 * 契约：export register(registry, ctx)（lib/wb-cli/registry.mjs 三期 A 段）；
 *       零 npm 依赖，Node ≥18（fetch/crypto/fs 原生）。
 * 任务包：P4 任务包 C「CLI/MCP 档案命令（出口即入口）」（关联 dt_mkq335 / ai_bugs 73204b28）。
 */

import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __archiveDirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__archiveDirname, '..', '..');
const PROFILE_GEN_SCRIPT = resolve(REPO_ROOT, 'scripts', 'profile-gen.mjs');

const COS_REGION = 'ap-shanghai';
const VAULT_KEY_PREFIX = 'obsidian/'; // COS 桶内统一前缀（P0 桶规范；vault_files.path 不含此前缀）
const ARCHIVE_PATH_PREFIX = 'archive/'; // vault_files.path / COS key 内的档案前缀

/* ============================================================
 * COS 签名 GET 链（STS 临时凭证 + DescribeStaticStore 桶解析 + v5 GET 签名）
 * 自实现副本（vault P1 先例）：凭证/桶解析进程内单例；到期前 5 分钟预刷新；
 * 403 强制刷新重试一次。签名 UriPathname 用原始未编码路径、URL 用 RFC3986 编码
 * （六变体判别实验实锤，中文/emoji 路径 403 坑先例 feature/dt-iy2eek-a）。
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
 * @param {string} key COS 对象 key（obsidian/archive/...）
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
  return t.length > n ? t.slice(0, n) + '…' : (t || '');
};

/** vault_files.path → COS key（容错：兼容带/不带 obsidian/ 前缀；archive 前缀校验收口） */
function toCosKey(path) {
  let p = String(path || '').trim().replace(/^\/+/, '');
  if (p.startsWith(VAULT_KEY_PREFIX)) return p;
  return VAULT_KEY_PREFIX + p;
}

/** show 参数归一：名/path → vault_files.path（archive/ 相对路径）
 *  索引解析次序：① 带 archive/ 前缀精确命中 ② archive/ 内 ilike 模糊唯一命中
 *  ③ 全库模糊唯一命中（容错：用户手滑给了非 archive 路径，如 vault 已知文件）
 *  都未命中 → 原样补 archive/ 前缀（保持语义，COS 404 由桶侧裁决） */
function normalizeArchivePath(raw) {
  let p = String(raw || '').trim().replace(/^\/+/, '');
  p = p.replace(new RegExp('^' + VAULT_KEY_PREFIX.replace('/', '\\/')), ''); // 剥 obsidian/
  if (!p) throw new Error('名称不能为空');
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw new Error(`非法 path（禁止相对段）：${p}`);
  }
  return p; // 前缀补全延迟到索引解析后（见 archiveShow）
}

/** 索引表未就绪/为空的友好提示 */
const TABLE_HINT = 'vault_files 索引表查询失败（检查 wb-auth 通道与表就绪状态）。';

/* ============================================================
 * dashscope LLM（cmd-fin aiExtractFin 同款调用 + Key 降级链先例）
 * ============================================================ */

const BAILIAN_MODEL = 'qwen-flash';
const BAILIAN_TIMEOUT_MS = 60000;

/** BAILIAN_API_KEY 降级链：env → ~/.workbuddy/bailian.env → ~/.workbuddy/cloudbase.env */
function getBailianKeyLocal() {
  if (process.env.BAILIAN_API_KEY) return process.env.BAILIAN_API_KEY;
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  const paths = [resolve(homedir(), '.workbuddy/bailian.env'), resolve(homedir(), '.workbuddy/cloudbase.env')];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^\s*(?:export\s+)?(?:BAILIAN_API_KEY|DASHSCOPE_API_KEY)\s*=\s*['"]?([^\s'"]+)/m);
    if (m) return m[1];
  }
  return null;
}

/**
 * dashscope compatible-mode chat（cmd-fin aiExtractFin 同款）。
 * @returns {Promise<string|null>} 文本；不可用返回 null（调用方降级）
 */
async function dashscopeChat(prompt, key, { temperature = 0.2, jsonMode = false } = {}) {
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BAILIAN_TIMEOUT_MS);
  try {
    const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: BAILIAN_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    return content.replace(/^```(?:json|text|plain)?\s*|\s*```$/g, '').trim();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
 * 命令实现
 * ============================================================ */

/** archive list：vault_files 前缀 archive/ 清单（path/size/mtime 表格） */
async function archiveList(flags, ctx) {
  const limit = Math.max(1, Math.min(200, parseInt(String(flags.limit ?? '50'), 10) || 50));
  const like = ARCHIVE_PATH_PREFIX + '%';

  let rows;
  try {
    rows = await ctx.api('GET', `vault_files?select=path,title,size,mtime&path=ilike.${encodeURIComponent(like)}&order=mtime.desc.nullslast&limit=${limit}`);
  } catch (e) {
    console.error(`❌ ${TABLE_HINT}\n   ${String(e.message || e).slice(0, 160)}`);
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(rows) || !rows.length) {
    ctx.output({
      prefix: ARCHIVE_PATH_PREFIX,
      count: 0,
      files: [],
      hint: '档案区为空。生成方式：wb-cli archive gen（依赖 A 段 scripts/profile-gen.mjs，未合并时提示降级）。',
    }, () => {
      console.log('（vault 桶 archive/ 前缀下暂无档案）');
      console.log('\n生成方式：wb-cli archive gen');
      console.log('（依赖 A 段 scripts/profile-gen.mjs——该段未合并/未执行时此处保持为空）');
    });
    return;
  }

  ctx.output({
    prefix: ARCHIVE_PATH_PREFIX,
    count: rows.length,
    files: rows.map((r) => ({ path: r.path, title: r.title || null, size: r.size, mtime: r.mtime })),
  }, () => {
    console.log(`记忆档案（archive/ 前缀）· 命中 ${rows.length} 个（mtime 降序，上限 ${limit}）：\n`);
    for (const r of rows) {
      console.log(`🗄️ ${r.path}`);
      console.log(`   ${clip(r.title || r.path.split('/').pop(), 60)} · ${fmtBytes(r.size)} · ${fmtDate(r.mtime)}`);
    }
    console.log('\n读取：wb-cli archive show <名> [--head N]');
  });
}

/** archive show <名>：COS 签名链读桶输出 md 全文（--head N 行截断） */
async function archiveShow(flags, pos, ctx) {
  const rawName = pos.join(' ').trim();
  if (!rawName) {
    console.error('用法: archive show <名|path> [--head N]（名经 archive list 获取，支持 archive/profile/顾铭眼中的刘总 或 顾铭 前缀）');
    process.exitCode = 1;
    return;
  }

  // ① 索引解析：按 path 精确 / archive 前缀内 ilike 模糊 / 全库模糊兜底，取唯一命中
  //   （都未命中 → 补 archive/ 前缀，COS 404 由桶侧裁决）
  let path = null;
  let meta = null;
  try {
    const cand = normalizeArchivePath(rawName);
    const tryQuery = async (p) => {
      const exact = await ctx.api('GET', `vault_files?select=path,title,size,mtime&path=eq.${encodeURIComponent(p)}&limit=1`).catch(() => []);
      if (Array.isArray(exact) && exact.length) return exact[0];
      const fuzzy = await ctx.api('GET', `vault_files?select=path,title,size,mtime&path=ilike.${encodeURIComponent('%' + p + '%')}&order=mtime.desc.nullslast&limit=10`).catch(() => []);
      if (!Array.isArray(fuzzy) || !fuzzy.length) return null;
      if (fuzzy.length === 1) return fuzzy[0];
      const narrowed = fuzzy.filter((r) => String(r.path || '').startsWith(ARCHIVE_PATH_PREFIX));
      const pool = narrowed.length === 1 ? narrowed : null;
      if (pool) return pool[0];
      const uniq = (narrowed.length ? narrowed : fuzzy);
      if (uniq.length > 1) {
        console.error(`❌ 「${rawName}」命中 ${uniq.length} 个档案，请用更精确名称：`);
        for (const r of uniq.slice(0, 10)) console.error(`   ${r.path}`);
        process.exitCode = 1;
        return undefined; // 显式多义终止
      }
      return null;
    };
    // 三级候选：原名 → 补 archive/ 前缀 → 都没有
    let hit = await tryQuery(cand);
    if (hit === null && !cand.startsWith(ARCHIVE_PATH_PREFIX)) {
      hit = await tryQuery(ARCHIVE_PATH_PREFIX + cand);
    }
    if (hit === undefined) return; // 多义已报错退出
    if (hit) meta = hit;
    path = meta?.path || (cand.startsWith(ARCHIVE_PATH_PREFIX) ? cand : ARCHIVE_PATH_PREFIX + cand);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exitCode = 1;
    return;
  }

  // ② COS 拉全文（签名链自实现）
  let text;
  try {
    text = await cosGetText(toCosKey(path));
  } catch (e) {
    console.error(`❌ ${String(e.message || e).slice(0, 200)}${meta ? '' : '\n   （索引未登记此档案——A 段生成并入桶后可用 archive list 定位）'}`);
    process.exitCode = 1;
    return;
  }

  // ③ --head N 行截断
  const all = text.split('\n');
  const total = all.length;
  const head = flags.head != null ? Math.max(1, Math.min(100000, parseInt(String(flags.head), 10) || 0)) : null;
  const slice = head != null ? all.slice(0, head) : all;

  ctx.output({
    path,
    title: meta?.title || null,
    size: meta?.size ?? text.length,
    mtime: meta?.mtime || null,
    totalLines: total,
    shownLines: slice.length,
    truncated: head != null && head < total,
    content: text.slice(0, head != null ? all.slice(0, head).join('\n').length : undefined),
  }, () => {
    if (meta) {
      console.log(`🗄️ ${meta.title || path}`);
      console.log(`   ${fmtBytes(meta.size)} · mtime ${fmtDate(meta.mtime)} · COS key ${toCosKey(path)}\n`);
    } else {
      console.log(`🗄️ ${path}（索引未登记，直读桶）\n`);
    }
    console.log(slice.join('\n'));
    if (head != null && head < total) {
      console.log(`\n—— 共 ${total} 行，已显示前 ${slice.length} 行（--head ${head}）；看全文去掉 --head，或 archive show "${path}" --head ${Math.min(total, head * 2)}`);
    }
  });
}

/** archive gen [--since]：spawn A 段生成脚本，透传参数与退出码 */
async function archiveGen(flags, ctx) {
  if (!existsSync(PROFILE_GEN_SCRIPT)) {
    console.error(`ℹ️ 生成脚本不存在：scripts/profile-gen.mjs`);
    console.error('   该脚本属 P4 任务包 A「档案生成管道」，可能尚未合并到本分支。');
    console.error('   提示：A 段合并后执行 wb-cli archive gen（支持 --since YYYY-MM-DD 增量）。');
    process.exitCode = 1;
    return;
  }
  const args = [PROFILE_GEN_SCRIPT];
  if (typeof flags.since === 'string' && flags.since) args.push('--since', String(flags.since));
  for (const extra of (Array.isArray(flags._passthrough) ? flags._passthrough : [])) args.push(String(extra));

  console.error(`▶ spawn：node scripts/profile-gen.mjs${args.length > 1 ? ' ' + args.slice(1).join(' ') : ''}`);
  const code = await new Promise((resolveCode) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: 'inherit' });
    child.on('error', (e) => { console.error(`❌ spawn 失败：${e.message}`); resolveCode(1); });
    child.on('close', (c) => resolveCode(c ?? 1));
  });
  process.exitCode = code; // 退出码透传（任务包 FR3）
}

/** archive detect：近 N 天 capsules+decision_logs × 档案节选 → 矛盾/关联清单 */
async function archiveDetect(flags, ctx) {
  const days = Math.max(1, Math.min(365, parseInt(String(flags.days ?? '30'), 10) || 30));
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

  // ① 素材：近 N 天闪念（原话逐字，铁律）+ 决策记录
  let capsules = [];
  let decisions = [];
  try {
    const [cs, ds] = await Promise.all([
      ctx.api('GET', `capsules?select=id,title,content,category,tags,created_at&created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.desc&limit=120`),
      ctx.api('GET', `decision_logs?select=id,input_text,decision,created_at&created_at=gte.${encodeURIComponent(sinceIso)}&order=created_at.desc&limit=120`),
    ]);
    capsules = Array.isArray(cs) ? cs : [];
    decisions = Array.isArray(ds) ? ds : [];
  } catch (e) {
    console.error(`❌ 素材拉取失败：${String(e.message || e).slice(0, 160)}`);
    process.exitCode = 1;
    return;
  }

  // ② 档案节选：archive/ 下首个档案（具名档案优先），每篇截前 4000 字符
  let archiveExcerpts = [];
  try {
    const files = await ctx.api('GET', `vault_files?select=path,title&path=ilike.${encodeURIComponent(ARCHIVE_PATH_PREFIX + '%')}&order=mtime.desc.nullslast&limit=5`);
    const sorted = (Array.isArray(files) ? files : []).sort((a, b) => {
      const an = String(a.path || '').includes('profile') ? 0 : 1;
      const bn = String(b.path || '').includes('profile') ? 0 : 1;
      return an - bn;
    });
    for (const f of sorted.slice(0, 3)) {
      try {
        const text = await cosGetText(toCosKey(f.path));
        archiveExcerpts.push({ path: f.path, excerpt: text.slice(0, 4000) });
      } catch { /* 单篇读取失败跳过，不阻断 */ }
    }
  } catch { /* 档案区为空/索引不可用 → 节选为空，继续 */ }

  const dateOf = (v) => String(v || '').slice(0, 10);
  const capLines = capsules.map((c) => `[闪念 ${dateOf(c.created_at)}] ${clip(c.content || c.title, 160)}`);
  const decLines = decisions.map((d) => `[决策 ${dateOf(d.created_at)}] ${clip(d.input_text || d.decision, 160)}`);

  // ③ 降级输出：素材摘要（无 Key / LLM 不可用 / 无档案时恒可用）
  const fallbackOutput = (reason) => {
    ctx.output({
      days,
      since: sinceIso.slice(0, 10),
      mode: '素材摘要（降级）',
      reason,
      capsuleCount: capsules.length,
      decisionCount: decisions.length,
      archives: archiveExcerpts.map((a) => a.path),
      capsules: capLines.slice(0, 20),
      decisions: decLines.slice(0, 20),
    }, () => {
      console.log(`📋 跨时间检测素材摘要（${reason}）`);
      console.log(`   窗口：近 ${days} 天（${sinceIso.slice(0, 10)} 起）· 闪念 ${capsules.length} 条 · 决策 ${decisions.length} 条 · 档案节选 ${archiveExcerpts.length} 篇\n`);
      if (capLines.length) {
        console.log('—— 近期闪念（前 20）——');
        for (const l of capLines.slice(0, 20)) console.log(`  ${l}`);
      }
      if (decLines.length) {
        console.log('\n—— 近期决策（前 20）——');
        for (const l of decLines.slice(0, 20)) console.log(`  ${l}`);
      }
      if (archiveExcerpts.length) {
        console.log('\n—— 档案节选来源 ——');
        for (const a of archiveExcerpts) console.log(`  ${a.path}（前 4000 字符已参与对比）`);
      }
      if (!capsules.length && !decisions.length) {
        console.log('\n（该窗口内无闪念与决策记录——扩大 --days 或补充素材后再试）');
      }
      console.log('\nℹ️ 以上为素材摘要降级输出；配置 BAILIAN_API_KEY 后重跑可获取 AI 矛盾/关联分析。');
    });
  };

  if (!capsules.length && !decisions.length) {
    fallbackOutput('窗口内无素材');
    return;
  }

  // ④ LLM 分析（Key 降级链同 cmd-fin 先例）
  const key = ctx.bailianKey || getBailianKeyLocal();
  if (!key) {
    fallbackOutput('无 BAILIAN/DASHSCOPE Key');
    return;
  }

  const archiveBlock = archiveExcerpts.length
    ? archiveExcerpts.map((a) => `【档案节选 · ${a.path}】\n${a.excerpt}`).join('\n\n')
    : '（档案区暂空——仅基于近 N 天素材与历史对照的有限分析）';

  const prompt = `你是「记忆档案」跨时间检测器。下面材料分两部分：【近期记录】是刘总近 ${days} 天的闪念原话与决策记录（逐字保留，不得改写）；【历史档案】是此前的记忆档案节选。

请只做归纳对比，不创作、不臆测。逐条输出：
1. 矛盾（contradictions）：近期表态/决策与历史档案论断相抵触之处
2. 关联（echoes）：近期内容与历史档案同主题、同脉络的呼应/延续之处

每条必须同时引用双方原文片段并带日期，格式：
- [矛盾/关联] <一句话结论>
  近期："<原文片段>"（闪念/决策 YYYY-MM-DD）
  历史："<原文片段>"（档案节选）
没有发现就输出「（无）」。不要输出任何无关解释。

【近期记录】
${[...capLines, ...decLines].join('\n')}

【历史档案】
${archiveBlock}`;

  const text = await dashscopeChat(prompt, key, { temperature: 0.2 });
  if (!text) {
    fallbackOutput('LLM 调用失败/超时');
    return;
  }

  ctx.output({
    days,
    since: sinceIso.slice(0, 10),
    mode: 'AI 矛盾/关联分析',
    capsuleCount: capsules.length,
    decisionCount: decisions.length,
    archives: archiveExcerpts.map((a) => a.path),
    analysis: text,
  }, () => {
    console.log(`🔍 跨时间检测（近 ${days} 天：闪念 ${capsules.length} 条 + 决策 ${decisions.length} 条 × 档案节选 ${archiveExcerpts.length} 篇）\n`);
    console.log(text);
  });
}

/* ============================================================
 * 注册（registry 契约，cmd-vault 同款模式）
 * ============================================================ */

/** @param {import('./shared.mjs').Ctx} ctx */
export function register(reg, ctx) {
  reg.register('archive', {
    summary: 'archive 记忆档案只读：list 清单 / show 全文 / gen 生成（A 段脚本透传）/ detect 跨时间矛盾关联',
    lines: [
      '  archive list [--limit 50]                   档案清单（vault_files archive/ 前缀）',
      '  archive show <名|path> [--head N]           COS 拉档案 md 全文（--head 截断行数）',
      '  archive gen [--since YYYY-MM-DD]            spawn A 段 profile-gen.mjs（透传退出码）',
      '  archive detect [--days 30] [--json]         近 N 天闪念+决策 × 档案 → 矛盾/关联清单',
    ],
    handler: (flags, pos) => cmdArchive(flags, pos, ctx),
  });
}

async function cmdArchive(flags, pos, ctx) {
  const sub = pos[0] || 'list';
  if (sub === 'list' || pos.length === 0) return archiveList(flags, ctx);
  if (sub === 'show') return archiveShow(flags, pos.slice(1), ctx);
  if (sub === 'gen') return archiveGen(flags, ctx);
  if (sub === 'detect') return archiveDetect(flags, ctx);
  console.error(`未知子命令：${sub}（支持 list / show / gen / detect）`);
  process.exitCode = 1;
}

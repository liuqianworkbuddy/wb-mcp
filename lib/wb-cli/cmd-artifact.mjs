/**
 * wb-cli · 产物域命令（2026-09-29）
 * ------------------------------------------------------------
 * artifact list：读取 html_artifacts 登记表。
 * artifact upload：校验完整 HTML 后上传 orpt-files/artifacts，
 * 并在 html_artifacts 登记 file_path 与递增版本。
 */

import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { makeApi } from '../wb-auth.mjs';

const MAX_BYTES = 20 * 1024 * 1024;
const STORAGE_BUCKET = 'orpt-files';

function apiOrigin(base) {
  return String(base || '').replace(/\/v1\/rest$/, '').replace(/\/+$/, '');
}

function normalizeSpace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeTitleEntities(value) {
  return normalizeSpace(value)
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
}

export function inspectHtmlDocument(buf, filePath) {
  const text = buf.toString('utf8');
  const problems = [];
  if (!/^\s*<!doctype\s+html\s*>/i.test(text)) problems.push('缺少 <!doctype html>');
  if (!/<html\b[^>]*\slang\s*=\s*["']zh-CN["'][^>]*>/i.test(text)) problems.push('缺少 html lang="zh-CN"');
  if (!/<meta\b[^>]*charset\s*=\s*["']?utf-8["']?[^>]*>/i.test(text)) problems.push('缺少 meta charset="utf-8"');
  const title = decodeTitleEntities((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(text) || [])[1]);
  if (!title) problems.push('缺少非空 title');
  return {
    ok: problems.length === 0,
    problems,
    title,
    fallbackTitle: basename(filePath).replace(/\.html?$/i, ''),
  };
}

function makeVersionKey(filePath) {
  const stem = basename(filePath, extname(filePath));
  const key = normalizeSpace(stem)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-');
  return (key || 'artifact').slice(0, 120);
}

function makeStorageKey(filePath) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const ext = extname(filePath).toLowerCase() || '.html';
  return `artifacts/${day}/${Date.now()}-${randomBytes(6).toString('hex')}${ext}`;
}

async function writeGuard(ctx, label, flags) {
  (flags.json ? console.error : console.log)(`将执行 · ${label}`);
  if (flags.yes) return true;
  if (process.stdin.isTTY) {
    const ok = await ctx.confirm('确认执行？');
    if (!ok) {
      console.log('已取消（加 --yes 跳过确认）');
      return false;
    }
    return true;
  }
  console.error('非 TTY 环境写操作需 --yes');
  process.exitCode = 2;
  return false;
}

async function errorMessage(res) {
  const text = await res.text().catch(() => '');
  try {
    const data = JSON.parse(text);
    return data.message || data.error || text.slice(0, 200) || `HTTP ${res.status}`;
  } catch {
    return text.slice(0, 200) || `HTTP ${res.status}`;
  }
}

export function register(registry, ctx) {
  registry.register('artifact', {
    summary: 'HTML 产物域（列表 / 上传登记）',
    lines: [
      '  artifact list                            HTML 产物登记表（html_artifacts）',
      '  artifact upload <html路径> [选项] [--yes] 上传完整 HTML 到 orpt-files 并登记版本',
    ],
    handler: (flags, pos) => cmdArtifact(flags, pos, ctx),
    domain: 'query',
    write: true,
    confirmNeed: true,
    params: [
      { name: 'path', type: 'string', required: true, positional: true, desc: '本机 HTML 文件路径（upload 用）' },
      { name: 'title', type: 'string', desc: '产物标题（缺省取 HTML title）' },
      { name: 'description', type: 'string', desc: '产物说明（登记中同时保留公网 URL）' },
    ],
    resultFields: ['url', 'bucket', 'key', 'version', 'artifact'],
  });

  async function cmdArtifact(flags, pos) {
    const sub = pos[0] || 'list';
    if (sub === 'list') return listArtifacts();
    if (sub !== 'upload') throw new Error('用法：artifact list | artifact upload <本机html路径> [--title 标题] [--description 说明]');
    return uploadArtifact(flags, pos.slice(1));
  }

  async function listArtifacts() {
    const rows = await ctx.api('GET', 'html_artifacts?select=id,title,file_path,version,created_at&order=created_at.desc&limit=100');
    ctx.output({ count: rows.length, artifacts: rows }, () => {
      if (!rows.length) {
        console.log('（产物域为空）');
        return;
      }
      console.log(`HTML 产物共 ${rows.length} 份（按时间倒序）：\n`);
      for (const a of rows) {
        console.log(`v${a.version || 1} ${a.title}`);
        console.log(`   id=${a.id}  ${a.file_path || ''}  ${String(a.created_at || '').slice(0, 10)}`);
      }
    });
  }

  async function uploadArtifact(flags, pos) {
    const rawPath = pos[0];
    if (!rawPath) throw new Error('缺少 HTML 路径。用法：artifact upload <本机html路径> [--title 标题] [--description 说明]');
    const filePath = resolve(rawPath);
    const st = statSync(filePath);
    if (!st.isFile()) throw new Error(`不是普通文件：${filePath}`);
    if (!/\.html?$/i.test(filePath)) throw new Error('仅支持 .html / .htm 文件');
    if (st.size > MAX_BYTES) throw new Error(`HTML 产物超出 20MB 上限：${st.size} 字节`);

    const buf = readFileSync(filePath);
    const doc = inspectHtmlDocument(buf, filePath);
    if (!doc.ok) throw new Error(`HTML 文档不完整：${doc.problems.join('；')}`);
    const title = normalizeSpace(flags.title) || doc.title || doc.fallbackTitle;
    if (!title) throw new Error('产物标题不能为空');
    if (title.length > 200) throw new Error('产物标题不能超过 200 字');
    const userDescription = normalizeSpace(flags.description);
    if (userDescription.length > 1000) throw new Error('产物说明不能超过 1000 字');
    if (!(await writeGuard(ctx, `上传 HTML 产物「${title}」（${filePath}，${buf.length} 字节）`, flags))) return;

    const { auth, base } = makeApi({ profile: process.env.WB_PROFILE });
    if (auth.mode !== 'gateway') {
      throw new Error('产物上传需要 WB_API_KEY（wbk_ 前缀）。请在 ~/.workbuddy/agents/<profile>.env 配置后重试');
    }

    const key = makeStorageKey(filePath);
    const uploadUrl = `${apiOrigin(base)}/v1/storage/upload?bucket=${STORAGE_BUCKET}&key=${encodeURIComponent(key)}`;
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        Authorization: `Bearer ${auth.key}`,
      },
      body: new Uint8Array(buf),
      signal: AbortSignal.timeout(55000),
    });
    if (!res.ok) throw new Error(await errorMessage(res));

    const uploaded = await res.json().catch(() => null);
    if (!uploaded || uploaded.ok === false || !uploaded.url) throw new Error('存储上传成功但返回数据异常');

    const versionKey = makeVersionKey(filePath);
    const existing = await ctx.api(
      'GET',
      `html_artifacts?select=id,version&version_key=eq.${encodeURIComponent(versionKey)}&order=version.desc&limit=1`,
    );
    const version = (existing[0]?.version || 0) + 1;
    const description = `${userDescription ? `${userDescription}\n` : ''}URL: ${uploaded.url}`;

    const [artifact] = await ctx.api('POST', 'html_artifacts?select=*', {
      version_key: versionKey,
      title,
      version,
      file_path: key,
      file_size: buf.length,
      description,
      source: 'wb-cli',
    });
    if (!artifact) throw new Error('产物登记成功但返回数据异常');

    await ctx.logCli('cli_add', 'ai', artifact.id, {
      title,
      content: `HTML 产物上传：${uploaded.url}`,
      type: 'artifact_upload',
      table: 'html_artifacts',
    });

    const result = {
      url: uploaded.url,
      bucket: STORAGE_BUCKET,
      key,
      size: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
      version,
      artifact,
    };
    ctx.output(result, () => {
      console.log('HTML 产物上传成功');
      console.log(`  标题：${title}`);
      console.log(`  URL：${result.url}`);
      console.log(`  对象：${STORAGE_BUCKET}/${key}`);
      console.log(`  登记：id=${artifact.id} version=${version}`);
    });
  }
}

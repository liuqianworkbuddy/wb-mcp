/**
 * wb-cli · 图床命令（2026-09-26）
 * ------------------------------------------------------------
 * image upload <path>：读本地位图，经 ai-proxy /v1/storage/upload
 * 写入 media-images/image-bed，返回公网 URL 和 Markdown 片段。
 */

import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { makeApi } from '../wb-auth.mjs';

const MAX_BYTES = 100 * 1024 * 1024;

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

export function detectImageKind(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return null;
}

function safeAlt(name) {
  return String(name || '图片').replace(/[[\]]/g, '').slice(0, 40) || '图片';
}

function makeKey(contentType) {
  const ext = EXT_BY_MIME[contentType];
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `image-bed/${day}/${Date.now()}-${randomBytes(6).toString('hex')}${ext ? `.${ext}` : ''}`;
}

function apiOrigin(base) {
  return String(base || '').replace(/\/v1\/rest$/, '').replace(/\/+$/, '');
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
  registry.register('image', {
    summary: '图床上传（本地图片到 media-images，返回公网 URL）',
    lines: ['  image upload <图片路径> [--json]      上传 PNG/JPG/GIF/WebP/BMP/AVIF，返回 URL 与 Markdown'],
    handler: cmdImage,
    domain: 'image',
    write: true,
    confirmNeed: true,
    params: [{ name: 'path', type: 'string', required: true, positional: true, desc: '本机图片文件路径' }],
    resultFields: ['url', 'markdown', 'bucket', 'key', 'size', 'contentType'],
  });

  async function cmdImage(flags, pos) {
    if (pos[0] !== 'upload') {
      throw new Error('用法：image upload <图片路径> [--json]');
    }
    const rawPath = pos[1];
    if (!rawPath) throw new Error('缺少图片路径。用法：image upload <图片路径>');

    const st = statSync(rawPath);
    if (!st.isFile()) throw new Error(`不是普通文件：${rawPath}`);
    if (st.size > MAX_BYTES) throw new Error(`图片超出 100MB 上限：${st.size} 字节`);

    const buf = readFileSync(rawPath);
    const contentType = detectImageKind(buf);
    if (!contentType) {
      throw new Error('仅支持 PNG、JPG、GIF、WebP、BMP、AVIF 位图；SVG 暂不开放公网图床');
    }

    const { auth, base } = makeApi({ profile: process.env.WB_PROFILE });
    if (auth.mode !== 'gateway') {
      throw new Error('图床上传需要 WB_API_KEY（wbk_ 前缀）。请在 ~/.workbuddy/agents/<profile>.env 配置后重试');
    }

    const key = makeKey(contentType);
    const url = `${apiOrigin(base)}/v1/storage/upload?bucket=media-images&key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        Authorization: `Bearer ${auth.key}`,
      },
      body: new Uint8Array(buf),
      signal: AbortSignal.timeout(115000),
    });
    if (!res.ok) throw new Error(await errorMessage(res));

    const data = await res.json().catch(() => null);
    if (!data || data.ok === false || !data.url) throw new Error('存储上传成功但返回数据异常');
    const name = basename(rawPath);
    const result = {
      url: data.url,
      markdown: `![${safeAlt(name)}](${data.url})`,
      bucket: 'media-images',
      key,
      size: buf.length,
      contentType,
      sha256: createHash('sha256').update(buf).digest('hex'),
      storage: data.storage || 'local',
    };

    ctx.output(result, () => {
      console.log('图床上传成功');
      console.log(`  文件：${name}（${buf.length} 字节）`);
      console.log(`  URL：${result.url}`);
      console.log(`  Markdown：${result.markdown}`);
      console.log(`  对象：media-images/${key}`);
    });
  }
}

#!/usr/bin/env node
/**
 * wb-mcp · HTTP 入口（远程化 Phase 0 · 20261019）
 * ------------------------------------------------
 * Streamable HTTP transport（stateless）版 wb-mcp：业务逻辑零改动，
 * 与 stdio 版共用 lib/wb-mcp/server.mjs 的 buildServer()。
 *
 * 设计依据：《wb-mcp 远程化方案 v1.0（2026-10-13）》+ Codex 评审补充
 *   - stateless 会话：每请求新建 transport + server，无会话粘滞，
 *     容器可水平重启；串行队列仍在进程内（dev_tasks 打勾竞态防线保留）
 *   - 双层鉴权：本服务 Bearer token（WB_MCP_HTTP_TOKEN）为内层；
 *     生产外层由 api.liflow.cn ai-proxy verifyApiKey 把关（Phase 1 接入）
 *   - 仅监听 loopback 时允许无 token（本地开发）；对外监听强制要求 token
 *
 * 启动：
 *   node scripts/wb-mcp-http.mjs                          # 127.0.0.1:3100
 *   WB_MCP_HTTP_PORT=3100 WB_MCP_HTTP_TOKEN=xxx node …    # 带 token
 *   WB_MCP_HTTP_HOST=0.0.0.0 …（必须同时设 TOKEN，否则拒绝启动）
 *
 * 环境变量：
 *   WB_PROFILE            同 stdio 版（workbuddy|openclaw|hermes）
 *   WB_MCP_HTTP_HOST      监听地址，默认 127.0.0.1
 *   WB_MCP_HTTP_PORT      监听端口，默认 3100
 *   WB_MCP_HTTP_TOKEN     Bearer token；loopback 下可省，外联必填
 *   WB_MAX_OUT            单次返回上限（与 stdio 版同）
 *
 * 接入方式（MCP 客户端 URL 型配置）：
 *   url: https://api.liflow.cn/v1/mcp（Phase 1 上线后）
 *   headers: Authorization: Bearer <wbk_ key 或服务 token>
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from '../lib/wb-mcp/server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function readVersion() {
  try {
    const src = readFileSync(resolve(ROOT, 'lib', 'version.ts'), 'utf8');
    const m = src.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
  } catch { /* fallthrough */ }
  return '0.0.0';
}

const VERSION = readVersion();
const PROFILE = process.env.WB_PROFILE || 'workbuddy';
const READONLY = PROFILE === 'hermes';
const HOST = process.env.WB_MCP_HTTP_HOST || '127.0.0.1';
const PORT = Number(process.env.WB_MCP_HTTP_PORT || 3100);
const TOKEN = process.env.WB_MCP_HTTP_TOKEN || '';
const IS_LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';

const log = {
  info: (m) => console.log(`[wb-mcp-http] ${m}`),
  error: (m) => console.error(`[wb-mcp-http][ERROR] ${m}`),
};

// 对外监听（非 loopback）必须带 token——防裸奔上线
if (!IS_LOOPBACK && !TOKEN) {
  log.error(`WB_MCP_HTTP_HOST=${HOST} 为对外监听，必须同时设置 WB_MCP_HTTP_TOKEN`);
  process.exit(1);
}

/** 读取并解析 JSON body（上限 10MB，防滥用） */
function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) {
        reject(new Error('REQUEST_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolveBody(text ? JSON.parse(text) : undefined);
      } catch {
        reject(new Error('BAD_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function unauthorized(res) {
  sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'missing or invalid Bearer token' });
}

/**
 * P3 修复（20261019）：鉴权升级为 api_keys 体系 ——
 * ① Authorization 头解析出 token；
 * ② WB_MCP_HTTP_TOKEN 直通（服务器 admin 通道，兼容 Phase 1 单 key）；
 * ③ 其余 token 调 ai-proxy /v1/keys/whoami 验证（网页签发的域级 key 全支持，
 *    60s 缓存减网关压力；吊销最多延迟 60s 生效，数据层仍即时拒绝）。
 * 返回 {ok, key}；key 下传 buildServer → wb-cli，权限跟随调用者。
 */
const WHOAMI_CACHE = new Map(); // token → { ok, agent, ts }
const WHOAMI_TTL_MS = 60_000;

async function checkAuth(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : '';
  if (!token) return { ok: false };
  if (TOKEN && token === TOKEN) return { ok: true, key: token, agent: 'server-admin' };
  const now = Date.now();
  const hit = WHOAMI_CACHE.get(token);
  if (hit && now - hit.ts < WHOAMI_TTL_MS) return hit.ok ? { ok: true, key: token, agent: hit.agent } : { ok: false };
  try {
    const r = await fetch('https://api.liflow.cn/v1/keys/whoami', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    const ok = r.status === 200;
    let agent = null;
    if (ok) { try { agent = (await r.json()).agent; } catch { /* ignore */ } }
    if (WHOAMI_CACHE.size > 500) WHOAMI_CACHE.clear();
    WHOAMI_CACHE.set(token, { ok, agent, ts: now });
    return ok ? { ok: true, key: token, agent } : { ok: false };
  } catch {
    return { ok: false };
  }
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  // 健康检查（不鉴权，供容器/nginx 探活）
  if (req.method === 'GET' && url === '/health') {
    sendJson(res, 200, { ok: true, server: 'wb-mcp-http', version: VERSION, profile: PROFILE, mode: 'stateless' });
    return;
  }

  if (url !== '/mcp' && url !== '/') {
    sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'use POST /mcp' });
    return;
  }

  // stateless 模式：无服务端发起消息，GET SSE / DELETE 会话均不支持
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'stateless mode: POST only' });
    return;
  }

  const auth = await checkAuth(req);
  if (!auth.ok) {
    unauthorized(res);
    return;
  }

  let parsedBody;
  try {
    parsedBody = await readJsonBody(req);
  } catch (e) {
    sendJson(res, 400, { ok: false, code: e.message || 'BAD_JSON', message: e.message });
    return;
  }

  // stateless：每请求一套 transport + server，连接随响应关闭而清理
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    // Phase 2：远程模式标志 + WB_VIA=mcp（wb-auth 注入 X-WB-Via，网关审计记 module=mcp）
    process.env.WB_VIA = 'mcp';
    const mcpServer = await buildServer({ version: VERSION, readonly: READONLY, logger: log, remoteMode: true, clientKey: auth.key });
    res.on('close', () => {
      Promise.allSettled([transport.close(), mcpServer.close()]).catch(() => {});
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (e) {
    log.error(`handleRequest 异常：${e.message}`);
    if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'INTERNAL', message: e.message });
    else res.end();
    try { await transport.close(); } catch { /* 已关闭 */ }
  }
});

server.listen(PORT, HOST, () => {
  log.info(`wb-mcp ${VERSION} · HTTP transport 就绪 · http://${HOST}:${PORT}/mcp`);
  log.info(`profile=${PROFILE}${READONLY ? '（readonly）' : ''} · stateless · token=${TOKEN ? 'on' : 'off（仅 loopback 开发）'}`);
});

server.on('error', (e) => {
  log.error(`监听失败：${e.message}`);
  process.exit(1);
});

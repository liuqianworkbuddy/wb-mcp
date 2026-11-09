#!/usr/bin/env node
/**
 * probe-http · wb-mcp HTTP transport 冒烟（远程化 Phase 0）
 * ------------------------------------------------
 * 对已启动的 wb-mcp-http 实例做四步验收：health → initialize →
 * tools/list（校验 serverInfo 与工具数）→ wb_query 只读调用。
 * 退出码 0 = 全过；任一步失败非零退出（CI/部署后验收可复用）。
 *
 * 用法：
 *   node scripts/probe-http.mjs [baseURL]
 *   # 默认 http://127.0.0.1:3100；带 token 环境变量 WB_MCP_HTTP_TOKEN
 */

const BASE = (process.argv[2] || process.env.WB_MCP_HTTP_BASE || 'http://127.0.0.1:3100').replace(/\/$/, '');
const TOKEN = process.env.WB_MCP_HTTP_TOKEN || '';

function headers() {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

async function mcp(id, method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  // SSE 帧剥壳：取 data: 行
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  const obj = JSON.parse(dataLine ? dataLine.slice(6) : text);
  if (obj.error) throw new Error(`MCP error: ${JSON.stringify(obj.error).slice(0, 200)}`);
  return obj;
}

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null);
if (health?.ok) {
  console.log(`✅ health OK · ${health.server} ${health.version} · profile=${health.profile}`);
} else {
  // 公网网关通常只放行 /mcp（health 仅内网探活）——降级为警告，以 initialize 为准
  console.log(`⚠ health 不可达（${BASE}/health，公网属预期）——继续以 initialize 验收`);
}

const init = await mcp(1, 'initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'probe-http', version: '1.0' },
}).catch((e) => fail(`initialize 失败：${e.message}`));
if (init.result.serverInfo.name !== 'wb-mcp') fail('serverInfo.name 非 wb-mcp');
console.log(`✅ initialize OK · serverInfo=${init.result.serverInfo.name} ${init.result.serverInfo.version}`);

const list = await mcp(2, 'tools/list').catch((e) => fail(`tools/list 失败：${e.message}`));
const names = list.result.tools.map((t) => t.name);
if (!names.includes('wb_query')) fail('工具列表缺少 wb_query');
console.log(`✅ tools/list OK · ${names.length} 个工具（含 wb_query）`);

const call = await mcp(3, 'tools/call', {
  name: 'wb_query',
  arguments: { command: 'search 通道冒烟测试 --table todos --limit 1 --json' },
}).catch((e) => fail(`只读调用失败：${e.message}`));
const txt = call.result?.content?.[0]?.text || '';
if (!txt.includes('"success"')) fail('只读调用返回异常');
console.log('✅ wb_query 只读调用 OK');
console.log('\n全部通过——HTTP transport 冒烟四步全绿');

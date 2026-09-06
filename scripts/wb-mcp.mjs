#!/usr/bin/env node
/**
 * wb-mcp · 入口（dt_xbobex）
 * ------------------------------------------------
 * 把 wb-cli 命令族暴露为标准 MCP server（stdio transport）。
 * 供 Codex / DeepSeek CLI / Claude Code / WorkBuddy 等 MCP 客户端直连。
 *
 * 启动：
 *   node scripts/wb-mcp.mjs                    # 默认 workbuddy profile（admin key）
 *   WB_PROFILE=hermes node scripts/wb-mcp.mjs  # readonly（只注册 wb_query）
 *
 * 环境变量：
 *   WB_PROFILE=workbuddy|openclaw|hermes   key 档位（hermes=readonly 双保险）
 *
 * 接入指南：docs/wb-mcp-接入指南.md
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startServer } from '../lib/wb-mcp/server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// APP_VERSION 从 lib/version.ts 提取（避免 import ts 文件）
function readVersion() {
  try {
    const src = readFileSync(resolve(ROOT, 'lib/version.ts'), 'utf8');
    const m = src.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
  } catch { /* fallthrough */ }
  return '0.0.0';
}

const PROFILE = process.env.WB_PROFILE || 'workbuddy';
const READONLY = PROFILE === 'hermes';

// 🔴 MCP stdio 协议流专用 stdout——任何 console.log 都会污染协议帧，
// 全部诊断信息走 stderr。
const log = {
  info: (m) => process.stderr.write(`[wb-mcp] ${m}\n`),
  error: (m) => process.stderr.write(`[wb-mcp][ERROR] ${m}\n`),
};

async function main() {
  const version = readVersion();
  log.info(`启动 ${version} · profile=${PROFILE}${READONLY ? '（readonly，仅 wb_query）' : ''}`);
  await startServer({ version, readonly: READONLY, logger: log });
  log.info('stdio transport 就绪，等待客户端连接');
}

main().catch((e) => {
  log.error(`启动失败：${e.stack || e.message || e}`);
  process.exit(1);
});

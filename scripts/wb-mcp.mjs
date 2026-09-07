#!/usr/bin/env node
/**
 * wb-mcp · 入口（dt_xbobex）
 * ------------------------------------------------
 * 把 wb-cli 命令族暴露为标准 MCP server（stdio transport）。
 * 供 Codex / DeepSeek CLI / Claude Code / WorkBuddy 等 MCP 客户端直连。
 *
 * 启动：
 *   node scripts/wb-mcp.mjs                    # 默认 workbuddy 渠道
 *   WB_PROFILE=hermes node scripts/wb-mcp.mjs  # 只读（旧约定兼容：渠道名 hermes=readonly）
 *
 * 环境变量：
 *   WB_PROFILE=<渠道名>     仅决定读哪个渠道文件 ~/.workbuddy/agents/<渠道名>.env
 *   WB_SCOPE=admin|readwrite|readonly   权限档位（显式声明优先于渠道名旧约定）
 *
 * 接入指南：README.md（授权需在 liflow.cn/settings 自助签发 wbk_ key）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startServer } from '../lib/wb-mcp/server.mjs';
import { resolveAuth } from '../lib/wb-auth.mjs';

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
// 权限档位由渠道里显式声明的 WB_SCOPE 决定（admin/readwrite/readonly），
// 渠道名不再隐含权限；未声明时兼容旧约定（渠道名 hermes = 只读）。
// scope 只影响本地注册哪些工具，越权拦截在服务端（key scope 校验 + RLS）。
const SCOPE = resolveAuth().scope;
const READONLY = SCOPE ? SCOPE === 'readonly' : PROFILE === 'hermes';

// 🔴 MCP stdio 协议流专用 stdout——任何 console.log 都会污染协议帧，
// 全部诊断信息走 stderr。
const log = {
  info: (m) => process.stderr.write(`[wb-mcp] ${m}\n`),
  error: (m) => process.stderr.write(`[wb-mcp][ERROR] ${m}\n`),
};

async function main() {
  const version = readVersion();
  log.info(`启动 ${version} · profile=${PROFILE}${SCOPE ? ` · scope=${SCOPE}` : ' · scope=未声明'}${READONLY ? '（readonly，仅 wb_query）' : ''}`);
  await startServer({ version, readonly: READONLY, logger: log });
  log.info('stdio transport 就绪，等待客户端连接');
}

main().catch((e) => {
  log.error(`启动失败：${e.stack || e.message || e}`);
  process.exit(1);
});

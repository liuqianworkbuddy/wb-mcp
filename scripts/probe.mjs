#!/usr/bin/env node
/** 独立仓库握手 probe：initialize 请求应答 serverInfo.name === 'wb-mcp' */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const entry = resolve(ROOT, 'scripts', 'wb-mcp.mjs');

const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const timer = setTimeout(() => { console.error('❌ 握手超时'); child.kill('SIGKILL'); process.exit(1); }, 15000);
child.stdout.on('data', (d) => {
  buf += d.toString();
  // newline-delimited JSON：逐行解析，找 id=1 的 initialize 应答
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.id === 1 && obj.result && obj.result.serverInfo) {
        const info = obj.result.serverInfo;
        if (info.name === 'wb-mcp') {
          console.log('✅ 握手成功 serverInfo:', JSON.stringify(info));
          clearTimeout(timer);
          child.kill('SIGKILL');
          process.exit(0);
        }
      }
    } catch { /* 半行/非 JSON 行继续 */ }
  }
});
const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0.0.0' } } });
child.stdin.write(msg + '\n');

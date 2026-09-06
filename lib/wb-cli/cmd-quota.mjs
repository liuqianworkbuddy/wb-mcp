/**
 * wb-cli · quota 配额自查（dt_r5j0rp C段 · FR-4）
 * ------------------------------------------------
 * 本地滑动窗口计数（~/.workbuddy/quota-window.json，最近 60s/1h 请求数）
 * + 探测网关配额端点（不可查则标注）。wb-auth 层 429 退避为跨域项，登记交接 MM。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

const WINDOW_FILE = (() => {
  try { return `${(process.env.WB_HOME || `${homedir()}/.workbuddy`).replace(/[\\/]+$/, '')}/quota-window.json`; } catch { return '.quota-window.json'; }
})();

/** 记一次 API 调用（供限流窗口统计；写失败静默） */
export function bumpQuotaWindow() {
  try {
    const arr = loadWindow();
    arr.push(Date.now());
    writeFileSync(WINDOW_FILE, JSON.stringify(arr.slice(-5000)));
  } catch { /* ignore */ }
}

function loadWindow() {
  try {
    if (!existsSync(WINDOW_FILE)) return [];
    mkdirSync(dirname(WINDOW_FILE), { recursive: true });
    return JSON.parse(readFileSync(WINDOW_FILE, 'utf8')).filter((ts) => Date.now() - ts < 3600 * 1000);
  } catch { return []; }
}

export function register(registry, ctx) {
  registry.register('quota', {
    summary: '配额自查：本地滑动窗口计数（60s/1h）+ 网关配额端点探测',
    lines: ['  quota [--json]                     配额自查（本地滑动窗口 + 网关端点探测）'],
    handler: cmdQuota,
    domain: 'query',
    write: false,
    confirmNeed: false,
    params: [{ name: 'json', type: 'boolean', required: false, desc: '机器可读输出（经 envelope）' }],
    resultFields: ['window_60s', 'window_1h', 'gateway_quota'],
  });

  async function cmdQuota(flags) {
    const arr = loadWindow();
    const now = Date.now();
    const w60 = arr.filter((ts) => now - ts < 60 * 1000).length;
    const w1h = arr.length;
    // 网关配额端点探测（ai-proxy 未实现则 404——如实标注，不做假数据）
    let gateway = '网关未暴露配额端点（如需直读余量找 MM 端在 ai-proxy 加 /v1/quota）';
    try {
      const res = await fetch(`${(process.env.WB_GATEWAY_URL || 'https://api.liflow.cn/v1/rest').replace(/\/v1\/rest$/, '')}/v1/quota`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) gateway = await res.text();
    } catch { gateway = '网关不可达（无法探测配额端点）'; }
    const result = { window_60s: w60, window_1h: w1h, gateway_quota: gateway, hint: '限频触 429 时 apiList 自动指数退避 1s/2s/4s（Retry-After 优先）' };
    ctx.output(result, () => {
      console.log(`wb-cli quota · 本地滑动窗口计数`);
      console.log(`  最近 60s：${w60} 次 API 调用`);
      console.log(`  最近 1h ：${w1h} 次 API 调用`);
      console.log(`  网关余量：${gateway}`);
      console.log(`  说明：${result.hint}`);
    });
  }
}

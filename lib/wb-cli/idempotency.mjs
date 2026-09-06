/**
 * wb-cli · 幂等键防重复创建（dt_r5j0rp B段 · FR-2）
 * ------------------------------------------------
 * add 族命令接受 --idempotency-key <key>：首次执行成功后把结果记入本地账本
 * （~/.workbuddy/idempotency.json），同 key 24h 内重复提交直接返回首次结果
 * （deduped:true），不再落库——MCP/网络重试场景防重复。
 * 账本选本地文件而非 action_logs：离线可用、零网络依赖、语义清晰（审计归审计）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

const LEDGER = (() => {
  try { return joinSafe(process.env.WB_HOME || `${homedir()}/.workbuddy`, 'idempotency.json'); } catch { return '.idempotency.json'; }
})();
const TTL_MS = 24 * 3600 * 1000;

function joinSafe(a, b) { return a.replace(/[\\/]+$/, '') + '/' + b; }

function load() {
  try {
    if (!existsSync(LEDGER)) return {};
    const j = JSON.parse(readFileSync(LEDGER, 'utf8'));
    const now = Date.now();
    for (const k of Object.keys(j)) if (now - (j[k]?.ts || 0) > TTL_MS) delete j[k]; // 惰性清理
    return j;
  } catch { return {}; }
}

function save(map) {
  try {
    mkdirSync(dirname(LEDGER), { recursive: true });
    writeFileSync(LEDGER, JSON.stringify(map, null, 2));
  } catch { /* 账本写失败不阻断主流程 */ }
}

/** 查账本：命中返回首次结果（deduped:true），未命中返回 null */
export function idempotencyLookup(key) {
  if (!key) return null;
  const hit = load()[key];
  return hit ? { ...hit.result, deduped: true } : null;
}

/** 记录首次结果（执行成功后调用） */
export function idempotencySave(key, result) {
  if (!key) return;
  const map = load();
  map[key] = { result, ts: Date.now() };
  save(map);
}

/**
 * wb-mcp · 串行执行队列（dt_xbobex）
 * ------------------------------------------------
 * 所有 tools/call 进全局串行队列：同一时刻仅一个调用在执行。
 * 根治 2026-09-04 实锤事故——dev_tasks stages 整块 JSON 读改写，
 * 并行打勾互踩（后写覆盖先写的条目状态）。
 *
 * Promise 链尾插法：run(fn) 把任务排到链尾依次执行。
 * 带 30s 超时防挂死（超时后任务标记失败但队列继续）。
 */

/** @type {Promise<void>} 队列尾（链尾插的核心） */
let tail = Promise.resolve();

/** @type {number} 当前排队数（监控用） */
let pending = 0;

/**
 * 把异步任务排进串行队列执行。
 * @param {() => Promise<unknown>} fn 任务体
 * @param {number} [timeoutMs=30000] 单任务超时
 * @returns {Promise<unknown>} fn 的返回值；超时抛 Error
 */
export function runQueued(fn, timeoutMs = 30000) {
  pending++;
  const exec = tail.then(async () => {
    // 用 Promise.race 实现超时：超时不中断底层执行（无法安全中断 spawn），
    // 但调用方立即收到错误，队列继续下一任务（底层结果被丢弃）。
    let timer = null;
    try {
      return await Promise.race([
        fn(),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`wb-mcp 串行队列超时（${timeoutMs}ms）`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
  // tail 只承接 settle（不短路：前一任务失败不影响后续任务入队执行）
  tail = exec.then(() => undefined, () => undefined);
  tail.finally(() => { pending--; }).catch(() => {});
  return exec;
}

/** 当前排队数（含执行中） */
export function queueDepth() {
  return pending;
}

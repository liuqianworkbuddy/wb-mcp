/**
 * wb-cli · 统一输出契约层（dt_o2ch2u A段 · FR-2 envelope）
 * ------------------------------------------------
 * --json 机器可读输出统一为 {success, data, error} envelope：
 *   成功 → { success:true, data, request_id }
 *   失败 → { success:false, error:{ code, message, reason, retryable, request_id } }
 * 退出码分级：0 成功 / 2 业务失败 / 3 网络失败。
 * 诊断文案一律走 console.error（stderr），stdout 只留数据——
 * wb-mcp execWbCli 分流后正文恒为合法 JSON（FR-3 消费方）。
 */

export const EXIT = { OK: 0, BIZ: 2, NET: 3 };

/** request_id 进程级一次（同一次 CLI 调用的成功/失败信封同源，便于日志对账） */
const REQ_ID = `req_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 6)}`;

export function requestId() {
  return REQ_ID;
}

/** 成功信封；data 自身已是 {success:bool} 形态时原样透传（防双重嵌套，兼容存量命令） */
export function envelopeOk(data) {
  if (data && typeof data === 'object' && typeof data.success === 'boolean') return data;
  return { success: true, data, request_id: REQ_ID };
}

/**
 * 失败信封。code 取值约定：
 *   NETWORK（网关不通/5xx/超时）/ AUTH（401/403）/ NOT_FOUND /
 *   VALIDATION（参数不合法）/ DENIED（写守卫拒绝）/ ERROR（未分类兜底）
 */
export function envelopeErr(err) {
  return {
    success: false,
    error: {
      code: err?.code || 'ERROR',
      message: String(err?.message || err || '未知错误'),
      reason: err?.reason || '',
      retryable: !!err?.retryable,
      request_id: REQ_ID,
    },
  };
}

/**
 * 错误分类：net（网络层，exit 3）/ biz（业务层，exit 2）。
 * 依据 wb-auth api() 报错格式 `GET path → 500: text` 与 fetch 层 TypeError 特征。
 */
export function classifyError(e) {
  const msg = String(e?.message || e || '');
  const m = msg.match(/→\s*(\d{3}):\s/);
  if (m) {
    const status = Number(m[1]);
    if (status >= 500 || status === 408 || status === 429) return { kind: 'net', status };
    if (status === 401 || status === 403) return { kind: 'biz', status, code: 'AUTH' };
    return { kind: 'biz', status };
  }
  const cause = e?.cause?.code || '';
  if (
    e?.name === 'TypeError' && /fetch/i.test(msg)
    || ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT'].includes(cause)
    || /fetch failed|network|ECONN/i.test(msg)
  ) return { kind: 'net' };
  return { kind: 'biz' };
}

/** 给任意 Error 补信封字段（退出码路径用） */
export function withCode(e, code, { reason = '', retryable = false } = {}) {
  if (e && typeof e === 'object') {
    e.code = e.code || code;
    e.reason = e.reason || reason;
    e.retryable = e.retryable ?? retryable;
  }
  return e;
}

/**
 * --lang en 最小双语（P2 FR-4 · dt_4er4pw）：核心 label 映射，缺失回落中文。
 * 主文件按 FLAGS.lang 调 setLang；渲染处用 t(key) 取词。
 */
let LANG = process.env.WB_LANG || 'zh';
export const LABELS_EN = {
  '待办': 'todo', '闪念': 'capsule', '笔记': 'note', '日程': 'schedule', '开发待办': 'dev-bug',
  '成功': 'success', '失败': 'failed', '无输出': '(no output)', '确认写入': 'confirm write',
};
export function setLang(l) { if (l === 'en' || l === 'zh') LANG = l; }
export function getLang() { return LANG; }
export function t(key) {
  if (LANG !== 'en') return key;
  return LABELS_EN[key] ? LABELS_EN[key] : (key + ' [zh]');
}

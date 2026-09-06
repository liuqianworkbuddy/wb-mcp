/**
 * wb-cli · ID 入口校验器（dt_4er4pw P2 · FR-1）
 * ------------------------------------------------
 * 表主键是 uuid；对接外部数值 ID（雪花 ID 等）超 JS Number.MAX_SAFE_INTEGER
 * 会静默失真——契约保证 ids_as_strings：外部数值 ID 强制字符串通道，
 * 超安全整数拒绝并给明确错误。
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** uuid 全格式校验 */
export function isValidUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v.trim());
}

/**
 * id 入口校验：全 uuid 或 ≥4 位前缀串。非法抛 INVALID_ID（调用方 catch 或顶层信封）。
 */
export function assertId(v, { allowPrefix = true, label = 'id' } = {}) {
  const s = String(v ?? '').trim();
  if (isValidUuid(s)) return s;
  if (allowPrefix && /^[0-9a-zA-Z_-]{4,64}$/.test(s)) return s;
  throw Object.assign(
    new Error(`${label} 格式非法：「${s.slice(0, 40)}」（期望 uuid 或 ≥4 位 id 前缀）`),
    { code: 'INVALID_ID' },
  );
}

/**
 * 外部数值 ID 强制字符串通道：雪花 ID 等超 MAX_SAFE_INTEGER 的数值直接拒绝
 * （JS Number 已静默失真），安全整数转字符串返回。
 */
export function coerceExternalId(v, { label = '外部数值 ID' } = {}) {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) {
      throw Object.assign(
        new Error(`${label} 超 JS 安全整数上限（${v}），数值已失真——请以字符串（双引号）传入`),
        { code: 'ID_PRECISION_LOSS' },
      );
    }
    return String(v);
  }
  return String(v ?? '');
}

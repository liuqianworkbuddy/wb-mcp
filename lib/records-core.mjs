/**
 * 记录三域纯函数内核（dt_yutubs）
 * ------------------------------------------------------------
 * 只放无 IO、无浏览器依赖的规则，供 node:test 与 lib/records.ts 共用。
 * 权威口径：
 *   capsules = 纯文本闪念
 *   diaries  = 轻量 Markdown 日记
 *   notes    = 富 Markdown 笔记
 */

export const RECORD_TYPES = ['capsule', 'diary', 'note'];

/**
 * 遗留例外：得到大脑导入记录，曾被笔记编辑链路标记 is_refined=true。
 * 刘总已确认本轮不迁移、不修改；只能通过显式 allowlist 兼容展示。
 */
export const LEGACY_NOTE_EXCEPTION_IDS = new Set([
  '2d2031ef-cc5c-4ea9-a619-49494039b878',
]);

export const RECORD_ASSET_REF_PREFIX = 'asset://record-assets/';

function collapseBlankLines(text) {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripInlineMarkdown(line) {
  return line
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2');
}

/**
 * Markdown -> 搜索/AI 纯文本。
 * 目标是保留自然语言内容，不追求 Markdown 语义完整还原：
 * - 代码围栏只去围栏，保留代码文本；
 * - 图片/链接保留可读文本；
 * - 标题、列表、引用、表格语法去掉；
 * - content_md 原文不改写。
 */
export function markdownToPlainText(markdown) {
  const src = String(markdown || '').replace(/\r\n?/g, '\n');
  const out = [];
  let inFence = false;

  for (const rawLine of src.split('\n')) {
    const line = rawLine;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (/^\s*(<!--|-->)/.test(line)) continue;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('');
      continue;
    }
    if (/^\s*\|?[\s:|-]+\|\s*$/.test(line)) continue;

    let next = line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '')
      .replace(/^\s*[-+*]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '');

    if (next.includes('|')) next = next.split('|').map((s) => s.trim()).join(' ');
    out.push(stripInlineMarkdown(next));
  }

  return collapseBlankLines(out.join('\n'));
}

function shanghaiParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`无效时间：${String(value)}`);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: Number(get('hour')) % 24,
  };
}

/**
 * 日记归属日：
 * 1. 按 Asia/Shanghai 计算自然日；
 * 2. 00:00:00-04:59:59 归前一天；
 * 3. 输出 YYYY-MM-DD。
 */
export function calcEntryDate(value) {
  const p = shanghaiParts(value);
  const noonUtc = Date.parse(`${p.year}-${p.month}-${p.day}T12:00:00Z`);
  const adjusted = p.hour < 5 ? noonUtc - 86_400_000 : noonUtc;
  if (Number.isNaN(noonUtc) || Number.isNaN(adjusted)) throw new Error(`日记归属日计算失败：${String(value)}`);
  return new Date(adjusted).toISOString().slice(0, 10);
}

export function extractRecordAssetRefs(markdown) {
  const text = String(markdown || '');
  const ids = [];
  for (const match of text.matchAll(/\((?:asset:\/\/record-assets\/)([0-9a-f-]{36})\)/gi)) {
    const id = match[1].toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function recordAssetMarkdown(assetId, alt = '') {
  const id = String(assetId || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new Error(`无效资产 ID：${id}`);
  }
  const label = String(alt || '').replace(/[[\]]/g, '').trim() || '附件';
  return `![${label}](${RECORD_ASSET_REF_PREFIX}${id})`;
}

export function isLegacyNoteException(id) {
  return LEGACY_NOTE_EXCEPTION_IDS.has(String(id || '').toLowerCase());
}

/** capsules 历史行迁移计划；只做判定，不做任何 IO。 */
export function planCapsuleMigration(row) {
  const id = String(row?.id || '').toLowerCase();
  const category = String(row?.category || '');
  if (isLegacyNoteException(id)) {
    return {
      action: 'keep',
      record_type: 'capsule',
      reason: 'legacy_note_exception',
    };
  }
  if (category === '日记') {
    return { action: 'migrate', record_type: 'diary', reason: 'category_diary' };
  }
  if (category === '笔记' && row?.is_refined === true) {
    return { action: 'migrate', record_type: 'note', reason: 'category_note_refined' };
  }
  return { action: 'keep', record_type: 'capsule', reason: 'capsule' };
}

export function toUnifiedRecord(row, recordType) {
  if (!RECORD_TYPES.includes(recordType)) throw new Error(`未知记录类型：${recordType}`);
  const source = row || {};
  const text = recordType === 'capsule'
    ? String(source.content || '')
    : String(source.content_md || source.plain_text || '');
  return {
    record_type: recordType,
    id: String(source.id || ''),
    title: String(source.title || ''),
    text,
    plain_text: recordType === 'capsule' ? text : String(source.plain_text || markdownToPlainText(text)),
    category: String(source.category || ''),
    tags: Array.isArray(source.tags) ? source.tags.map(String) : [],
    source: String(source.source || ''),
    source_evidence: source.source_evidence ?? null,
    created_at: String(source.created_at || ''),
    updated_at: source.updated_at ? String(source.updated_at) : null,
  };
}

/**
 * 记录三域公平合并：
 * 1. 每个域内部已按时间倒序传入；
 * 2. 先按各域第 1 条、第 2 条……轮转取样，避免高频闪念淹没日记/笔记；
 * 3. 某一域数据不足时，额度自动让给仍有数据的域；
 * 4. 最终结果再按时间倒序展示。
 */
export function mergeRecordGroupsByDomain(groups = [], limit = 10) {
  const max = Math.max(1, Math.min(Number(limit) || 10, 30));
  const queues = (Array.isArray(groups) ? groups : [])
    .filter(Array.isArray)
    .map((rows) => [...rows].sort((a, b) => (
      String(b?.created_at || '').localeCompare(String(a?.created_at || ''))
    )));
  const selected = [];

  for (let rank = 0; selected.length < max; rank += 1) {
    let added = false;
    for (const queue of queues) {
      if (selected.length >= max) break;
      const row = queue[rank];
      if (row !== undefined) {
        selected.push(row);
        added = true;
      }
    }
    if (!added) break;
  }

  return selected.sort((a, b) => (
    String(b?.created_at || '').localeCompare(String(a?.created_at || ''))
  ));
}

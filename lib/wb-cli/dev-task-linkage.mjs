/**
 * wb-cli · dev-task wrap 关联待办联动（2026-09-29）
 * ------------------------------------------------
 * S8 wrap done 后把 source_bug_ids 中尚未 fixed 的 ai_bugs 补写 fixed。
 * 跨表无事务，因此返回分层结果并保证重复执行幂等。
 */

function normalizeBugIds(sourceBugIds) {
  const raw = Array.isArray(sourceBugIds) ? sourceBugIds : String(sourceBugIds || '').split(',');
  return raw.map((v) => String(v || '').trim()).filter(Boolean);
}

export async function linkWrappedBugs({ api, sourceBugIds, now = new Date().toISOString() }) {
  const ids = normalizeBugIds(sourceBugIds);
  const result = { fixed: [], alreadyFixed: [], missing: [], failed: [] };
  if (!ids.length) return result;

  let rows = [];
  try {
    rows = await api(
      'GET',
      `ai_bugs?select=id,title,status&order=created_at.asc&limit=1000&id=in.(${ids.map((id) => encodeURIComponent(id)).join(',')})`,
    );
  } catch (error) {
    result.failed.push({ id: ids.join(','), error: String(error.message || error).slice(0, 200) });
    return result;
  }

  const byId = new Map(rows.map((row) => [String(row.id), row]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      result.missing.push({ id, reason: 'ai_bugs 中不存在' });
      continue;
    }
    if (row.status === 'fixed') {
      result.alreadyFixed.push({ id: row.id, title: row.title });
      continue;
    }
    try {
      const [updated] = await api(
        'PATCH',
        `ai_bugs?id=eq.${encodeURIComponent(row.id)}&select=id,title,status,fixed_at`,
        { status: 'fixed', fixed_at: now },
      );
      result.fixed.push({ id: row.id, title: updated?.title || row.title });
    } catch (error) {
      result.failed.push({ id: row.id, title: row.title, error: String(error.message || error).slice(0, 200) });
    }
  }
  return result;
}

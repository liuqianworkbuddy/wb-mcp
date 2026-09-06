/**
 * wb-cli · orpt 事项域查询命令族（三期 D 段 · dt_dod7ui）
 * ------------------------------------------------
 * 只读查询：requests 事项池 / occasions 时机 / projects 项目，均按 code 排序。
 *
 * 列名口径（2026-09-04 实测）：
 *   - 三表实际表名是 requests / occasions / projects（无 orpt_ 前缀），
 *     orpt_category 列是域标记（值如 orpt）
 *   - requests.code 形如 R-2026-001；projects.code 形如 P-2026-001
 *   - status 值：pool|converted|direct_done|closed|dropped（requests）
 *     projects.status 实测值 active
 */

/** @param {import('./shared.mjs').Ctx} ctx */
export function register(reg, ctx) {
  reg.register('orpt', {
    summary: 'ORPT 事项域查询（事项池/时机/项目）',
    lines: [
      '  orpt request list [--status pool|converted|direct_done|closed|dropped]   事项池（R-YYYY-NNN）',
      '  orpt occasion list                                                       时机列表',
      '  orpt project list [--active]                                             项目（P-YYYY-NNN）',
    ],
    handler: (flags, pos) => cmdOrpt(flags, pos, ctx),
  });
}

const REQ_STATUS = { pool: '池中', converted: '转项目', direct_done: '直办', closed: '关闭', dropped: '放弃', suspended: '挂起' };

async function cmdOrpt(flags, pos, ctx) {
  const sub = pos[0] || '';
  if (!sub) {
    console.error('用法: orpt <request|occasion|project> list [过滤]');
    process.exitCode = 1;
    return;
  }
  if (sub === 'request' || sub === 'requests') {
    const second = pos[1] || 'list';
    if (second !== 'list') { console.error(`未知子命令：${second}（仅支持 list）`); process.exitCode = 1; return; }
    let q = 'requests?select=id,code,title,status,priority,deadline,owner,created_at&order=code.asc&limit=500';
    if (typeof flags.status === 'string') q += `&status=eq.${encodeURIComponent(flags.status)}`;
    const rows = await ctx.api('GET', q);
    ctx.output({ count: rows.length, requests: rows }, () => {
      if (!rows.length) {
        console.log(typeof flags.status === 'string' ? `（状态 ${flags.status} 无事项）` : '（事项池为空）');
        return;
      }
      console.log(`事项池共 ${rows.length} 条（按编号）：\n`);
      for (const r of rows) {
        const st = REQ_STATUS[r.status] || r.status;
        const dl = r.deadline && !String(r.deadline).startsWith('9999') ? `  截止=${String(r.deadline).slice(0, 10)}` : '';
        console.log(`🔹 [${r.code}] ${r.title}`);
        console.log(`   状态=${st}  优先级=${r.priority || '-'}${r.owner ? `  责任人=${r.owner}` : ''}${dl}`);
      }
    });
    return;
  }
  if (sub === 'occasion' || sub === 'occasions') {
    const second = pos[1] || 'list';
    if (second !== 'list') { console.error(`未知子命令：${second}（仅支持 list）`); process.exitCode = 1; return; }
    const rows = await ctx.api('GET', 'occasions?select=id,occ_date,occ_type,title,status,source_note&order=occ_date.desc&limit=200');
    ctx.output({ count: rows.length, occasions: rows }, () => {
      if (!rows.length) { console.log('（时机列表为空）'); return; }
      console.log(`时机共 ${rows.length} 条（按日期倒序）：\n`);
      for (const o of rows) {
        console.log(`⏰ ${String(o.occ_date || '').slice(0, 10)} [${o.occ_type || '-'}] ${o.title}`);
        if (o.source_note) console.log(`   ${String(o.source_note).slice(0, 60)}`);
      }
    });
    return;
  }
  if (sub === 'project' || sub === 'projects') {
    const second = pos[1] || 'list';
    if (second !== 'list') { console.error(`未知子命令：${second}（仅支持 list）`); process.exitCode = 1; return; }
    let q = 'projects?select=id,code,name,goal,status,owner,planned_start,planned_end&order=code.asc&limit=200';
    if (flags.active) q += `&status=eq.active`;
    const rows = await ctx.api('GET', q);
    ctx.output({ count: rows.length, projects: rows }, () => {
      if (!rows.length) { console.log(flags.active ? '（无进行中项目）' : '（项目列表为空）'); return; }
      console.log(`项目共 ${rows.length} 个（按编号）：\n`);
      for (const p of rows) {
        const s = p.planned_start ? String(p.planned_start).slice(0, 10) : '';
        const e = p.planned_end ? String(p.planned_end).slice(0, 10) : '';
        const span = s || e ? `  周期=${s || '…'}~${e || '…'}` : '';
        console.log(`🎯 [${p.code}] ${p.name}（${p.status}）`);
        console.log(`   目标：${String(p.goal || '-').slice(0, 50)}${p.owner ? `  责任人=${p.owner}` : ''}${span}`);
      }
    });
    return;
  }
  console.error(`未知子命令：${sub}（支持 request / occasion / project）`);
  process.exitCode = 1;
}

/**
 * wb-cli · people 人脉域查询命令族（三期 D 段 · dt_dod7ui）
 * ------------------------------------------------
 * 只读查询：people list（按 name 排序，--cat 分类过滤）+ people show（详情+近 5 条互动）。
 *
 * 列名口径（2026-09-04 实测）：
 *   - people 用 organization（无 company 列）、职务是 job_title（非 title）
 *   - category 值形如「工作-下级/工作-平级/工作-上级」
 *   - intimacy 1-5 亲密度数值
 *   - person_interactions 时间列是 happened_at（无 interacted_at）
 *
 * 接口契约（A 段 shared.mjs，TDD §1.1）：
 *   import { resolveRowById } from './shared.mjs'
 *   resolveRowById(api, table, idPrefix, select) → Promise<row>（零/多命中抛错）
 */

import { resolveRowById } from './shared.mjs';

/** @param {import('./shared.mjs').Ctx} ctx */
export function register(reg, ctx) {
  reg.register('people', {
    summary: '人脉域查询（人物卡+互动记录）',
    lines: [
      '  people list [--cat 分类] [--limit N]   人物列表（name 排序，分类如 工作-下级）',
      '  people show <id前缀>                   人物详情 + 近 5 条互动',
    ],
    handler: (flags, pos) => cmdPeople(flags, pos, ctx),
  });
}

const INTIMACY = { 1: '①', 2: '②', 3: '③', 4: '④', 5: '⑤' };

async function cmdPeople(flags, pos, ctx) {
  const sub = pos[0] || 'list';
  if (sub === 'list' || (pos.length === 0)) {
    let q = 'people?select=id,name,organization,job_title,category,intimacy,last_contact_at&order=name.asc';
    if (typeof flags.cat === 'string') q += `&category=eq.${encodeURIComponent(flags.cat)}`;
    const limit = Math.max(1, Math.min(500, parseInt(String(flags.limit ?? '50'), 10) || 50));
    const rows = await ctx.api('GET', `${q}&limit=${limit}`);
    ctx.output({ count: rows.length, people: rows }, () => {
      if (!rows.length) {
        console.log(typeof flags.cat === 'string' ? `（分类「${flags.cat}」无人脉）` : '（人脉库为空）');
        return;
      }
      const cat = typeof flags.cat === 'string' ? `（分类=${flags.cat}）` : '';
      console.log(`人脉共 ${rows.length} 人${cat}：\n`);
      for (const p of rows) {
        const int = INTIMACY[p.intimacy] || '';
        console.log(`👤 ${p.name} ${int}${p.organization ? `  ${p.organization}` : ''}${p.job_title ? ` ${p.job_title}` : ''}`);
        console.log(`   id=${p.id}  分类=${p.category}  亲密度=${p.intimacy || '-'}${p.last_contact_at ? `  末次联络=${String(p.last_contact_at).slice(0, 10)}` : ''}`);
      }
    });
    return;
  }
  if (sub === 'show') {
    const idp = pos[1];
    if (!idp) { console.error('用法: people show <id前缀>'); process.exitCode = 1; return; }
    let row;
    try {
      row = await resolveRowById(ctx.api, 'people', idp);
    } catch (e) {
      console.error(`❌ ${String(e.message || e).slice(0, 160)}`);
      process.exitCode = 1;
      return;
    }
    const inter = await ctx.api('GET', `person_interactions?select=id,happened_at,type,subject,content,outcome&person_id=eq.${encodeURIComponent(row.id)}&order=happened_at.desc&limit=5`).catch(() => []);
    ctx.output({ person: row, interactions: inter }, () => {
      console.log(`👤 ${row.name}${row.job_title ? ` · ${row.job_title}` : ''}${row.organization ? ` @ ${row.organization}` : ''}`);
      console.log(`   id=${row.id}`);
      if (row.department) console.log(`   部门：${row.department}`);
      if (row.category) console.log(`   分类：${row.category}  亲密度：${INTIMACY[row.intimacy] || row.intimacy || '-'}/5`);
      if (row.work_scope) console.log(`   分管：${row.work_scope}`);
      if (row.report_to) console.log(`   汇报给：${row.report_to}`);
      if (row.met_at) console.log(`   认识于：${String(row.met_at).slice(0, 10)}${row.meet_context ? `（${row.meet_context}）` : ''}`);
      if (row.phones?.length) console.log(`   电话：${row.phones.map((p) => (p && typeof p === 'object' ? (p.number || p.value || JSON.stringify(p)) : String(p))).join(' / ')}`);
      if (row.wechat) console.log(`   微信：${typeof row.wechat === 'object' ? JSON.stringify(row.wechat) : row.wechat}`);
      if (row.tags?.length) console.log(`   标签：${row.tags.join('、')}`);
      if (row.relationship_notes) console.log(`   关系纪要：${row.relationship_notes}`);
      if (row.ai_summary) console.log(`   AI 摘要：${row.ai_summary}`);
      console.log(`\n   近 ${inter.length} 条互动：`);
      if (!inter.length) console.log('   （暂无互动记录）');
      for (const it of inter) {
        console.log(`   · ${String(it.happened_at || '').slice(0, 10)} [${it.type || '-'}] ${it.subject || ''}`);
        if (it.content) console.log(`     ${(String(it.content)).slice(0, 70)}${String(it.content).length > 70 ? '…' : ''}`);
      }
    });
    return;
  }
  console.error(`未知子命令：${sub}（支持 list / show）`);
  process.exitCode = 1;
}


/**
 * wb-cli · growth 成长域查询命令族（三期 D 段 · dt_dod7ui）
 * ------------------------------------------------
 * 只读查询：知识卡/文章/划线/阅读报告/练习/思考笔记 六类。
 * （books 已有顶层 book list 命令，不在此重复。）
 *
 * 列名口径（2026-09-04 实测）：
 *   - knowledge_cards 主列是 name（非 title）、一句话摘要 one_liner
 *   - articles 摘要 summary、金句 golden_quote、收藏时间 collected_at
 *   - annotations 正文 selected_text / note_text、无 title
 *   - reading_reports 正文 content_md、周期 period_type/period_start
 *   - practices 正文 text、状态 status
 *   - thought_notes 有 title/question
 *
 * 契约（A 段 shared.mjs，TDD §1.1）：列表渲染经 shared.renderTable
 * （rows 映射为 {col: 主列, type: 第二列, extra: 摘要}）；ctx 为 makeCtx 产物。
 */
import { renderTable } from './shared.mjs';

/** @param {import('./shared.mjs').Ctx} ctx */
export function register(reg, ctx) {
  reg.register('growth', {
    summary: '成长域查询（知识卡/文章/划线/报告/练习/思考）',
    lines: [
      '  growth knowledge list [--limit N]    知识卡（knowledge_cards）',
      '  growth article list [--limit N]      文章收藏（articles）',
      '  growth annotation list [--limit N]   划线批注（annotations）',
      '  growth report list [--limit N]       阅读报告（reading_reports）',
      '  growth practice list [--limit N]     练习（practices）',
      '  growth thinking list [--limit N]     思考笔记（thought_notes）',
    ],
    handler: (flags, pos) => cmdGrowth(flags, pos, ctx),
  });
}

/**
 * 六类资源配置。
 * map(row) → { col: 主列, type: 第二列, extra: 摘要行 }，对齐 shared.renderTable 形状。
 */
const RESOURCES = {
  knowledge: {
    table: 'knowledge_cards', label: '知识卡', empty: '（无知识卡）',
    query: 'knowledge_cards?select=id,name,one_liner,tags,created_at&order=created_at.desc',
    map: (r) => ({
      col: r.name || '(未命名)',
      type: String(r.created_at || '').slice(0, 10),
      extra: [r.one_liner, Array.isArray(r.tags) && r.tags.length ? `#${r.tags.join(' #')}` : ''].filter(Boolean).join('  '),
    }),
  },
  article: {
    table: 'articles', label: '文章', empty: '（无文章收藏）',
    query: 'articles?select=id,title,author,status,rating,collected_at&order=collected_at.desc',
    map: (r) => ({
      col: r.title || '(无标题)',
      type: String(r.collected_at || r.created_at || '').slice(0, 10),
      extra: [r.author, r.status, r.rating ? `评分${r.rating}` : ''].filter(Boolean).join('  '),
    }),
  },
  annotation: {
    table: 'annotations', label: '划线批注', empty: '（无划线批注）',
    query: 'annotations?select=id,target_type,kind,selected_text,note_text,created_at&order=created_at.desc',
    map: (r) => ({
      col: String(r.selected_text || '').replace(/\s+/g, ' ').slice(0, 38),
      type: String(r.created_at || '').slice(0, 10),
      extra: [r.kind, r.note_text ? `批注：${String(r.note_text).slice(0, 24)}` : ''].filter(Boolean).join('  '),
    }),
  },
  report: {
    table: 'reading_reports', label: '阅读报告', empty: '（无阅读报告）',
    query: 'reading_reports?select=id,period_type,period_start,content_md,created_at&order=created_at.desc',
    map: (r) => ({
      col: `${r.period_type || ''} ${String(r.period_start || '').slice(0, 10)}`.trim() || '(未标注周期)',
      type: String(r.created_at || '').slice(0, 10),
      extra: String(r.content_md || '').replace(/\s+/g, ' ').slice(0, 50),
    }),
  },
  practice: {
    table: 'practices', label: '练习', empty: '（无练习）',
    query: 'practices?select=id,text,status,done_note,created_at&order=created_at.desc',
    map: (r) => ({
      col: String(r.text || '').replace(/\s+/g, ' ').slice(0, 38),
      type: r.status || '',
      extra: String(r.created_at || '').slice(0, 10),
    }),
  },
  thinking: {
    table: 'thought_notes', label: '思考笔记', empty: '（无思考笔记）',
    query: 'thought_notes?select=id,title,question,methods_used,created_at&order=created_at.desc',
    map: (r) => ({
      col: r.title || '(无标题)',
      type: String(r.created_at || '').slice(0, 10),
      extra: [r.question, Array.isArray(r.methods_used) ? r.methods_used.map((m) => (typeof m === 'object' && m ? (m.name || m.title || '') : String(m || ''))).filter(Boolean).join('、') : ''].filter(Boolean).join('  ').slice(0, 50),
    }),
  },
};

async function cmdGrowth(flags, pos, ctx) {
  const sub = pos[0] || '';
  if (!sub) {
    console.error('用法: growth <knowledge|article|annotation|report|practice|thinking> list [--limit N]');
    process.exitCode = 1;
    return;
  }
  const resKey = sub === 'list' ? pos[1] : sub; // 允许 growth knowledge 或 growth knowledge list
  const res = RESOURCES[resKey];
  if (!res) {
    console.error(`未知资源：${resKey || '(空)'}（支持：${Object.keys(RESOURCES).join(' | ')}）`);
    process.exitCode = 1;
    return;
  }
  const second = sub === 'list' ? pos[2] : pos[1];
  if (second && second !== 'list') {
    console.error(`未知子命令：${second}（仅支持 list）`);
    process.exitCode = 1;
    return;
  }
  const limit = Math.max(1, Math.min(200, parseInt(String(flags.limit ?? '20'), 10) || 20));
  const rows = await ctx.api('GET', `${res.query}&limit=${limit}`);
  ctx.output({ resource: resKey, count: rows.length, rows }, () =>
    renderTable(rows.map(res.map), {
      title: `${res.label}（最近 ${rows.length} 条${rows.length ? '' : ''}）`,
      emptyText: res.empty,
    }));
}

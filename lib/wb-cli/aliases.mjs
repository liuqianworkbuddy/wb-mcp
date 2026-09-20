/**
 * wb-cli · 类型别名表 + fill 模板（纯数据，无 IO）
 */

/**
 * --type 强制指定别名 → 内部类型。
 * 别名大小写不敏感。
 */
export const TYPE_ALIASES = {
  todo: 'todo',
  待办: 'todo',
  task: 'todo',
  schedule: 'schedule',
  日程: 'schedule',
  sched: 'schedule',
  calendar: 'schedule',
  capsule: 'capsule',
  闪念: 'capsule',
  thought: 'capsule',
  diary: 'diary',
  日记: 'diary',
  note: 'note',
  笔记: 'note',
  article: 'article',
  文章: 'article',
  收藏: 'article',
  link: 'article',
  idea: 'idea',
  点子: 'idea',
  bug: 'bug',
  dev: 'bug',
  开发待办: 'bug',
  opt: 'bug',
  book: 'book',
  电子书: 'book',
  ebook: 'book',
};

/** 解析 --type 别名 → 内部类型；非法返回 null */
export function resolveTypeAlias(alias) {
  if (!alias) return null;
  return TYPE_ALIASES[String(alias).trim().toLowerCase()] || null;
}

/**
 * fill 预置模板定义。
 * 每个模板：desc 说明 + build(ctx) 生成提示词文本。
 * ctx: { todayStr, todos, schedules, ideas, bugs, capsules }（由主程序查询填充）
 */
export const FILL_TEMPLATES = {
  日报: {
    desc: '聚合近期待办完成情况 + 今日日程，生成日报提示词',
    build(ctx) {
      const lines = [];
      lines.push(`# 日报素材提示词（${ctx.todayStr} 生成）`);
      lines.push('');
      lines.push('你是刘潜的工作助理。请根据以下素材，起草一份今天的工作日报：结构为「今日完成 / 进行中 / 明日计划 / 需协调事项」，语言精炼，用要点式。');
      lines.push('');
      lines.push('## 近期完成的待办（todos status=completed，最近 20 条）');
      if (!ctx.completedTodos.length) lines.push('（无）');
      ctx.completedTodos.forEach((t) => lines.push(`- [${String(t.completed_at || '').slice(0, 10)}] ${t.title}（分类：${t.category}）`));
      lines.push('');
      lines.push('## 进行中的待办（pending，最近 30 条）');
      if (!ctx.pendingTodos.length) lines.push('（无）');
      ctx.pendingTodos.forEach((t) => lines.push(`- ${t.title}（分类：${t.category}${t.end_at || t.todo_date ? `，日期：${String(t.end_at || t.todo_date).slice(0, 10)}` : ''}）`));
      lines.push('');
      lines.push('## 今日与明日日程（schedules）');
      if (!ctx.schedules.length) lines.push('（无）');
      ctx.schedules.forEach((s) => lines.push(`- ${s.title}  ${String(s.start_at || '').slice(0, 16)} ~ ${String(s.end_at || '').slice(0, 16)}${s.location ? ` @${s.location}` : ''}`));
      return lines.join('\n');
    },
  },
  周报素材: {
    desc: '聚合本周待办/日程/开发进展，生成周报素材提示词',
    build(ctx) {
      const lines = [];
      lines.push(`# 周报素材提示词（${ctx.todayStr} 生成）`);
      lines.push('');
      lines.push('你是刘潜的工作助理。请根据以下本周素材，起草周报：结构为「本周主要成果 / 数据与进展 / 问题与风险 / 下周计划」，要点式。');
      lines.push('');
      lines.push('## 本周完成待办');
      if (!ctx.completedTodos.length) lines.push('（无）');
      ctx.completedTodos.forEach((t) => lines.push(`- ${t.title}（${t.category}）`));
      lines.push('');
      lines.push('## 在办待办');
      if (!ctx.pendingTodos.length) lines.push('（无）');
      ctx.pendingTodos.slice(0, 40).forEach((t) => lines.push(`- ${t.title}（${t.category}）`));
      lines.push('');
      lines.push('## 本周日程');
      if (!ctx.schedules.length) lines.push('（无）');
      ctx.schedules.forEach((s) => lines.push(`- ${s.title}  ${String(s.start_at || '').slice(0, 16)}`));
      lines.push('');
      lines.push('## 开发待办进展（ai_bugs 未完成）');
      if (!ctx.openBugs.length) lines.push('（无）');
      ctx.openBugs.forEach((b) => lines.push(`- [${b.kind === 'opt' ? '优化' : 'bug'}] ${b.title}（${b.module || '未分模块'}，${b.status}）`));
      return lines.join('\n');
    },
  },
  点子复盘: {
    desc: '聚合待评估 AI 点子，生成复盘提示词',
    build(ctx) {
      const lines = [];
      lines.push(`# 点子复盘提示词（${ctx.todayStr} 生成）`);
      lines.push('');
      lines.push('你是刘潜的产品顾问。请对以下待评估的 AI 点子逐条复盘：判断价值/可行性/落地路径，输出「值得推进（附下一步）」「暂缓（附理由）」「放弃」三档结论。');
      lines.push('');
      lines.push('## 待评估点子（ai_ideas status=待评估）');
      if (!ctx.pendingIdeas.length) lines.push('（无）');
      ctx.pendingIdeas.forEach((i, idx) => {
        lines.push(`${idx + 1}. ${i.title || i.raw_input.slice(0, 30)}`);
        if (i.one_liner) lines.push(`   概述：${i.one_liner}`);
        lines.push(`   原文：${i.raw_input}`);
      });
      return lines.join('\n');
    },
  },
};

/** 模板名别名（支持中英文快速输入） */
export const FILL_ALIASES = {
  日报: '日报',
  daily: '日报',
  周报素材: '周报素材',
  周报: '周报素材',
  weekly: '周报素材',
  点子复盘: '点子复盘',
  复盘: '点子复盘',
  ideas: '点子复盘',
};

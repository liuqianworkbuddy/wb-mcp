/**
 * wb-cli · AI 判类 prompt 模块（纯数据，无 IO）
 * ------------------------------------------------
 * 10 类型定义 + few-shot 示例，供 scripts/wb-cli.mjs 组装判类请求。
 * 模型：百炼 qwen-flash + json_object；失败由主程序降级本地关键词判类。
 */

/** 10 类型枚举（与 alias 表、字段映射一一对应） */
export const WB_TYPES = [
  'todo', // 待办
  'schedule', // 日程
  'capsule', // 闪念
  'diary', // 日记
  'note', // 笔记
  'article', // 公众号收藏/链接
  'idea', // AI 点子
  'bug', // 开发待办
  'book', // 电子书
  'other', // 人脉/其他（不落强判表）
];

/** 类型中文名（输出/回显用） */
export const TYPE_LABEL = {
  todo: '待办',
  schedule: '日程',
  capsule: '闪念',
  diary: '日记',
  note: '笔记',
  article: '公众号收藏',
  idea: 'AI 点子',
  bug: '开发待办',
  book: '电子书',
  other: '其他',
};

/** 类型 → 落库表名 */
export const TYPE_TABLE = {
  todo: 'todos',
  schedule: 'schedules',
  capsule: 'capsules',
  diary: 'diaries',
  note: 'notes',
  article: 'articles_inbox',
  idea: 'ai_ideas（+镜像 todos）',
  bug: 'ai_bugs（+镜像 todos）',
  book: 'books（力争直传 growth-library 桶）',
  other: 'capsules（兜底闪念）',
};

/** 类型定义正文（prompt 用） */
export const TYPE_DEFS = `类型定义（type 只能取以下 10 个之一）：
- todo 待办：有明确要做的事（买/交/办/写/提交/还/送/寄/整理/检查/汇报...），或有截止时间的一般任务
- schedule 日程：确定时间点的安排（会议/约见/家长会/体检/出差/聚会/面试...），常带"明天X点/周X/上午下午"
- capsule 闪念：想法/观点/感悟，无明确行动（"闪念：...""突然想到...""我觉得..."）
- diary 日记：记录今天经历/心情/反思/复盘（"记个日记""今天...心情..."）
- note 笔记：明确说"记笔记/保存笔记/整理笔记"，或可长期复用的资料、方法步骤、会议要点、读书笔记、Markdown 长文
- article 公众号收藏/链接：内容含 http(s) 链接，或明确说"这篇文章/这个链接收一下"
- idea AI 点子：关于产品/功能/项目的创意想法（"这个想法不错：...""给XX加个...""有个点子..."）
- bug 开发待办：AI 工作台自身的 bug 或优化需求（"修复：...""bug：...""优化：...""看板拖拽闪烁"等，常带模块/严重度）
- book 电子书：电子书文件录入（通常配合 --file 或文本含本地电子书路径）
- other 人脉/其他：人物介绍等无法安全归入上述类型的内容（宁可不猜错表）`;

/** few-shot 示例（判类 prompt 内嵌；只给 type/reason/关键字段，输出格式见 OUTPUT_SHAPE） */
export const FEW_SHOTS = [
  {
    input: '刘总在周一晨会上布置：周五前把三季度经营分析修订版提交给财务部，重点补齐毛利率偏差。',
    output: {
      type: 'todo',
      reason: '有截止时间和提交对象的工作任务，来源明确',
      title: '提交三季度经营分析修订版',
      due: '<最近下一个周五>',
      priority: 'high',
      category: '工作',
      task_source: '周一晨会刘总布置',
    },
  },
  {
    input: '后天下午3点在北京办公室和张三评审年度预算，大概两个小时，请提前打印材料。',
    output: {
      type: 'schedule',
      reason: '确定时间、地点和参与人的会议安排',
      title: '评审年度预算',
      start_at: '<后天>T15:00:00+08:00',
      end_at: '<后天>T17:00:00+08:00',
      location: '北京办公室',
    },
  },
  {
    input: '明天上午10点提醒我与周晨凯对Q3数据',
    output: {
      type: 'schedule',
      reason: '确定时间点（明天上午10点）的约见安排',
      title: '与周晨凯对Q3数据',
      start_at: '<明天>T10:00:00+08:00',
      end_at: '<明天>T11:00:00+08:00',
      location: '',
    },
  },
  {
    input: '这个想法不错：给工作台加个热力图年报',
    output: {
      type: 'idea',
      reason: '对工作台的功能创意',
      title: '给工作台加个热力图年报',
      one_liner: '为工作台增加热力图形式的年度回顾',
    },
  },
  {
    input: '我现在需要你帮我做这么一个开发：就是我的AI工作台的SideMenu是保持加载好了的，每次点击某个菜单项，只加载右侧的内容，而不重复加载sidemenu，这样会让网站访问变得快。',
    output: {
      type: 'bug',
      reason: '工作台性能优化需求，开发对象和目标明确',
      title: '侧边栏常驻并按需加载右栏',
      kind: 'opt',
      module: 'UI',
      severity: 'medium',
    },
  },
  {
    input: '我觉得现在录入链路最大的问题不是缺功能，而是每次都要人工确认字段，AI应该先给可信结构。',
    output: {
      type: 'capsule',
      reason: '对录入链路的观点判断，无明确执行动作',
      title: '录入链路需自动可信结构化',
    },
  },
  {
    input: 'https://mp.weixin.qq.com/s/xxxx 这篇公众号文章值得收',
    output: {
      type: 'article',
      reason: '含公众号链接，明确要收藏',
      url: 'https://mp.weixin.qq.com/s/xxxx',
      title: '这篇公众号文章值得收',
    },
  },
  {
    input: '周五前提交半年度述职报告给省公司',
    output: {
      type: 'todo',
      reason: '有截止时间的明确任务',
      title: '提交半年度述职报告给省公司',
      due: '<最近下一个周五>',
      priority: 'high',
      category: '工作',
      task_source: '',
    },
  },
];

/** 输出 JSON 形状说明（prompt 用） */
export const OUTPUT_SHAPE = `{"type":"todo|schedule|capsule|diary|note|article|idea|bug|book|other","reason":"一句话判断理由","title":"必填精炼标题：6-20个中文字符，概括核心对象+问题/动作/结果；不得照抄输入开头或截断原句","due":"todo专用：YYYY-MM-DD 或空","priority":"todo专用：high|medium|low，默认 medium","category":"todo专用：待办分类，从给定分类列表选，默认 工作","task_source":"todo专用：任务来源（如 沈总布置/财务部通知），无则空","start_at":"schedule专用：ISO8601 带时区，口语时间以今天为基准换算，或空","end_at":"schedule专用：ISO8601 带时区；有持续时长按时长推算，无则 start_at+1小时","location":"schedule专用：地点，无则空","url":"article专用：文本中第一个 http(s) 链接，无则空","one_liner":"idea专用：一句话概述，或空","kind":"bug专用：bug|opt，默认 bug","module":"bug专用：中文板块名（ORPT/待办/日程/闪念/UI/人脉/Omni输入/沉浸式/教育/文章收录/知识库/用量监控/开发日记/Hub导航/画布/安全/开发待办管理...），或空","severity":"bug专用：high|medium|low，默认 medium"}`;

/** 标题提炼硬规则（Prompt 用；也用于单测防回退） */
export const TITLE_RULES = `标题提炼硬规则：
- 先读完全文再命名，概括全部内容的核心事项；禁止取输入前 N 字、禁止保留原文口语开头
- 输出中文书面短语，优先名词短语或动宾结构；不带句号、引号、请求语和 markdown
- 保留能定位事项的专有名词/模块名/对象名，删掉"我现在需要你帮我做这么一个开发：就是"等请求语境
- todo 用「动作+对象(+接收方)」；schedule 用「事项/人物+动作」；bug/idea 用「对象+缺陷或优化」；capsule 用「观点核心」
- 截止时间、开始时间、地点、来源、严重度写入结构化字段，通常不进 title
- 输入本身已是 ≤20 字精炼短语时，仅去口语和标点后原样返回`;

function isValidDateDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00+08:00`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isValidISORough(s) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s)) return false;
  return !Number.isNaN(Date.parse(s));
}

function cleanAiTitle(title) {
  let cleaned = String(title || '')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 3; i += 1) {
    cleaned = cleaned
      .replace(/^[`'\"“”「」『』【】]+/, '')
      .replace(/[`'\"“”「」『』【】]+$/, '')
      .replace(/[。.!！?？，,;；:：]+$/, '')
      .trim();
  }
  return cleaned.slice(0, 30);
}

/**
 * 归一化 AI 结构化结果：锁定合法 type、清理标题、剔除非法关键字段。
 * 供调用方在 LLM 返回后立即执行，避免坏标题/坏日期继续流入表映射。
 */
export function normalizeClassifyDecision(parsed, raw, forcedType = null) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const type = forcedType || parsed.type;
  if (!WB_TYPES.includes(type)) return null;

  const out = { ...parsed, type, _raw: raw };
  out.title = cleanAiTitle(out.title);
  if (!out.title) return null; // 空 title 视为提取失败，调用方走本地降级
  out.reason = String(out.reason || '').trim().slice(0, 200);

  if (typeof out.due === 'string' && out.due && !isValidDateDay(out.due)) out.due = '';
  if (typeof out.start_at === 'string' && out.start_at && !isValidISORough(out.start_at)) out.start_at = '';
  if (typeof out.end_at === 'string' && out.end_at && !isValidISORough(out.end_at)) out.end_at = '';
  if (!out.start_at && out.end_at) out.end_at = ''; // start 不可信时，end 不单独落库
  if (out.start_at && out.end_at && Date.parse(out.end_at) < Date.parse(out.start_at)) out.end_at = '';
  if (!['high', 'medium', 'low'].includes(out.priority)) delete out.priority;
  if (!['bug', 'opt'].includes(out.kind)) delete out.kind;
  if (!['high', 'medium', 'low'].includes(out.severity)) delete out.severity;
  if (typeof out.url === 'string' && out.url) {
    try { new URL(out.url); } catch { out.url = ''; }
  }
  return out;
}

/**
 * 组装完整判类 prompt
 * @param {string} raw 用户原始输入
 * @param {string} todayStr 今天日期（YYYY-MM-DD 周X）
 * @param {string[]} catNames todo_categories 现有分类名列表
 * @returns {string} 完整 prompt
 */
export function buildClassifyPrompt(raw, todayStr, catNames, forcedType = null) {
  const cats = catNames && catNames.length ? catNames.join('|') : '工作|生活|个人|家庭|财务';
  const shots = FEW_SHOTS.map(
    (s, i) => `示例${i + 1}：【${s.input}】→ ${JSON.stringify(s.output)}`
  ).join('\n');
  const forcedRule = forcedType
    ? `\n类型约束：调用方已强制 type=${forcedType}。你不得改 type，只在该类型语义下提炼 title 和关键字段。\n`
    : '';
  return `你是刘潜的个人 AI 工作台终端录入助手（wb-cli）。把任意终端提交的一段文本判类并结构化，只输出合法 JSON（不要 markdown 代码块标记）：

${OUTPUT_SHAPE}

${TYPE_DEFS}

${TITLE_RULES}
${forcedRule}

判类细则：
- 链接强信号 → article；"闪念/突然想到/我觉得" → capsule；"记个日记/今天…"日记体 → diary；"记笔记/保存笔记/整理笔记"或资料沉淀长文 → note
- 工作台自身开发需求 → bug（优化诉求也是 bug 类，kind=opt）；产品功能创意 → idea
- 有确定时间点的安排选 schedule 而非 todo；有截止日期但非时间点会议类，选 todo 并填 due
- 人脉介绍（姓名+单位/职务/联系方式）→ other（本期不强判，由兜底闪念收录）
- 拿不准就在 todo/capsule 中选；宁可不猜错表
- 【重要】今天是 ${todayStr}。时间以此换算：明天=+1天，后天=+2天，"周五/周X"=最近的下一个周X，"上午10点"=当天10:00，"明天上午10点"=明天10:00。输出 ISO8601 带时区
- todo 的 category 只能从「${cats}」中选一个，默认 工作
- title 必须是读完全文后的概括，不是原文前缀；无法可靠概括时给最核心的名词短语，不要编造细节

【示例】
${shots}

【用户输入】
${raw}`;
}

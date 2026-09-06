/**
 * wb-cli · AI 判类 prompt 模块（纯数据，无 IO）
 * ------------------------------------------------
 * 9 类型定义 + few-shot 示例，供 scripts/wb-cli.mjs 组装判类请求。
 * 模型：百炼 qwen-flash + json_object；失败由主程序降级本地关键词判类。
 */

/** 9 类型枚举（与 alias 表、字段映射一一对应） */
export const WB_TYPES = [
  'todo', // 待办
  'schedule', // 日程
  'capsule', // 闪念
  'diary', // 日记
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
  diary: 'capsules',
  article: 'articles_inbox',
  idea: 'ai_ideas（+镜像 todos）',
  bug: 'ai_bugs（+镜像 todos）',
  book: 'books（力争直传 growth-library 桶）',
  other: 'capsules（兜底闪念）',
};

/** 类型定义正文（prompt 用） */
export const TYPE_DEFS = `类型定义（type 只能取以下 9 个之一）：
- todo 待办：有明确要做的事（买/交/办/写/提交/还/送/寄/整理/检查/汇报...），或有截止时间的一般任务
- schedule 日程：确定时间点的安排（会议/约见/家长会/体检/出差/聚会/面试...），常带"明天X点/周X/上午下午"
- capsule 闪念：想法/观点/感悟，无明确行动（"闪念：...""突然想到...""我觉得..."）
- diary 日记：记录今天经历/心情/反思/复盘（"记个日记""今天...心情..."）
- article 公众号收藏/链接：内容含 http(s) 链接，或明确说"这篇文章/这个链接收一下"
- idea AI 点子：关于产品/功能/项目的创意想法（"这个想法不错：...""给XX加个...""有个点子..."）
- bug 开发待办：AI 工作台自身的 bug 或优化需求（"修复：...""bug：...""优化：...""看板拖拽闪烁"等，常带模块/严重度）
- book 电子书：电子书文件录入（通常配合 --file 或文本含本地电子书路径）
- other 人脉/其他：人物介绍等无法安全归入上述类型的内容（宁可不猜错表）`;

/** few-shot 示例（判类 prompt 内嵌；只给 type/reason/关键字段，输出格式见 OUTPUT_SHAPE） */
export const FEW_SHOTS = [
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
    input: '修复：看板拖拽时卡片闪烁 bug，UI 模块，medium',
    output: {
      type: 'bug',
      reason: '工作台自身缺陷修复需求，带模块与严重度',
      title: '看板拖拽时卡片闪烁',
      kind: 'bug',
      module: 'UI',
      severity: 'medium',
    },
  },
  {
    input: '闪念：AI董事会应该有质询环节',
    output: {
      type: 'capsule',
      reason: '观点想法，无明确行动',
      title: 'AI董事会应该有质询环节',
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
export const OUTPUT_SHAPE = `{"type":"todo|schedule|capsule|diary|article|idea|bug|book|other","reason":"一句话判断理由","title":"精炼标题（去口语化，10-20字）","due":"todo专用：YYYY-MM-DD 或空","priority":"todo专用：high|medium|low，默认 medium","category":"todo专用：待办分类，从给定分类列表选，默认 工作","task_source":"todo专用：任务来源（如 沈总布置/财务部通知），无则空","start_at":"schedule专用：ISO8601 带时区，口语时间以今天为基准换算，或空","end_at":"schedule专用：ISO8601，默认 start_at+1小时，或空","location":"schedule专用：地点，无则空","url":"article专用：文本中第一个 http(s) 链接，无则空","one_liner":"idea专用：一句话概述，或空","kind":"bug专用：bug|opt，默认 bug","module":"bug专用：中文板块名（ORPT/待办/日程/闪念/UI/人脉/Omni输入/沉浸式/教育/文章收录/知识库/用量监控/开发日记/Hub导航/画布/安全/开发待办管理...），或空","severity":"bug专用：high|medium|low，默认 medium"}`;

/**
 * 组装完整判类 prompt
 * @param {string} raw 用户原始输入
 * @param {string} todayStr 今天日期（YYYY-MM-DD 周X）
 * @param {string[]} catNames todo_categories 现有分类名列表
 * @returns {string} 完整 prompt
 */
export function buildClassifyPrompt(raw, todayStr, catNames) {
  const cats = catNames && catNames.length ? catNames.join('|') : '工作|生活|个人|家庭|财务';
  const shots = FEW_SHOTS.map(
    (s, i) => `示例${i + 1}：【${s.input}】→ ${JSON.stringify(s.output)}`
  ).join('\n');
  return `你是刘潜的个人 AI 工作台终端录入助手（wb-cli）。把任意终端提交的一段文本判类并结构化，只输出合法 JSON（不要 markdown 代码块标记）：

${OUTPUT_SHAPE}

${TYPE_DEFS}

判类细则：
- 链接强信号 → article；"闪念/突然想到/我觉得" → capsule；"记个日记/今天…"日记体 → diary
- 工作台自身开发需求 → bug（优化诉求也是 bug 类，kind=opt）；产品功能创意 → idea
- 有确定时间点的安排选 schedule 而非 todo；有截止日期但非时间点会议类，选 todo 并填 due
- 人脉介绍（姓名+单位/职务/联系方式）→ other（本期不强判，由兜底闪念收录）
- 拿不准就在 todo/capsule 中选；宁可不猜错表
- 【重要】今天是 ${todayStr}。时间以此换算：明天=+1天，后天=+2天，"周五/周X"=最近的下一个周X，"上午10点"=当天10:00，"明天上午10点"=明天10:00。输出 ISO8601 带时区
- todo 的 category 只能从「${cats}」中选一个，默认 工作
- title 精炼去口语（去掉"帮我/记得/顺便/修复："等前缀词）

【示例】
${shots}

【用户输入】
${raw}`;
}

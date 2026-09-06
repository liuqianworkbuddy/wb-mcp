/**
 * wb-cli · 表字段映射 + 镜像规矩（纯数据/纯函数，无 IO）
 * ------------------------------------------------
 * AI 判类结果(通用对象) → 各目标表行对象的构造规则。
 * 表结构以 cloudbase/migrations/20260819063850（主表）与
 * 20260819213000（growth 表 books）建表 SQL 为准。
 */

/** todo 优先级枚举（todos.priority text） */
export const TODO_PRIORITIES = ['high', 'medium', 'low'];

/** bug kind 枚举（ai_bugs.kind text） */
export const BUG_KINDS = ['bug', 'opt'];

/** bug severity 枚举（ai_bugs.severity text） */
export const BUG_SEVERITIES = ['high', 'medium', 'low'];

/** 书格式枚举（books.format text） */
export const BOOK_FORMATS = ['epub', 'pdf', 'txt'];

/**
 * 待办 → todos 行
 * 分类需从 todo_categories 现有树匹配；匹配不上由主程序换「工作」。
 */
export function mapTodo(c, todayStr) {
  const dueDay = c.due || todayStr; // 日粒度截止
  return {
    title: c.title || '（未命名待办）',
    description: c._raw || '',
    status: 'pending',
    priority: TODO_PRIORITIES.includes(c.priority) ? c.priority : 'medium',
    category: c.category || '工作',
    // A 段口径：todo_date 双写 + end_at 当日 23:59:59（+08）+ all_day（DDL-2 删列后移除 todo_date）
    todo_date: dueDay,
    end_at: `${dueDay}T23:59:59+08:00`,
    all_day: true,
    task_source: c.task_source || c.taskSource || null,
  };
}

/**
 * 日程 → schedules 行（start_at/end_at 为 ISO 串或 null）
 */
export function mapSchedule(c) {
  return {
    title: c.title || '（未命名日程）',
    content: c._raw || '',
    start_at: c.start_at || null,
    end_at: c.end_at || null,
    location: c.location || '',
  };
}

/**
 * hashtag 解析（对齐任务包 27A3 规范）：正文 `#标签` 自动识别，一条可多标签。
 * 标签字符集：中日韩/字母/数字/下划线/连字符/斜杠（支持 flomo 式层级 a/b）。
 * 存储格式：不带 # 前缀的纯标签名数组。
 */
export function parseHashtags(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/#([\p{L}\p{N}_\-/]{1,30})/gu)) {
    const t = m[1].replace(/\/+$/, ''); // 去尾部斜杠
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 标签入参归一：容忍 # 前缀（`--tag #工作` 等价 `--tag 工作`） */
export function normalizeTag(t) {
  return String(t || '').replace(/^#/, '').trim();
}

/**
 * 闪念/日记 → capsules 行（日记 category='日记'，闪念 'inbox'）
 * tags：正文 hashtag 自动解析（A3 规范）——含 #标签 的胶囊保存后标签自动带上
 */
export function mapCapsule(c, isDiary) {
  return {
    content: c._raw || '',
    title: c.title || '',
    category: isDiary ? '日记' : 'inbox',
    tags: parseHashtags(c._raw),
    source: 'wb-cli',
  };
}

/**
 * 公众号收藏/链接 → articles_inbox 行。
 * url NOT NULL——无 URL 时主程序不得调用此映射（降级闪念）。
 * title 取链接前后说明文字（AI 已提炼；无则用域名，由主程序兜底）。
 */
export function mapArticle(c, fallbackTitle) {
  return {
    url: c.url || c._url || '',
    status: 'pending',
    source: 'CLI',
    title: c.title || fallbackTitle || '',
  };
}

/**
 * AI 点子 → ai_ideas 行（主数据；镜像 todos 由主程序另建）
 */
export function mapIdea(c) {
  return {
    raw_input: c._raw || '',
    title: c.title || '',
    one_liner: c.one_liner || c.title || '',
    status: '待评估',
    source_type: 'cli',
  };
}

/**
 * AI 点子 → 镜像 todos 行。
 * 🔴 项目铁律：点子主数据在 ai_ideas，todos 只做镜像。
 * description 带 ai_ideas id 回指；category 固定 'AI灵感'。
 */
export function mapIdeaMirrorTodo(ideaRow) {
  return {
    title: ideaRow.title || ideaRow.raw_input.slice(0, 40),
    description: `AI点子镜像（ai_ideas:${ideaRow.id}）\n${ideaRow.raw_input}`,
    status: 'pending',
    priority: 'medium',
    category: 'AI灵感',
    dev_idea_id: ideaRow.id,
  };
}

/**
 * 开发待办 → ai_bugs 行（主数据；镜像 todos 由主程序另建）
 */
export function mapBug(c) {
  return {
    title: c.title || '（未命名开发待办）',
    description: c._raw || '',
    kind: BUG_KINDS.includes(c.kind) ? c.kind : 'bug',
    module: c.module || '',
    severity: BUG_SEVERITIES.includes(c.severity) ? c.severity : 'medium',
    status: 'open',
    source: 'cli',
  };
}

/**
 * 开发待办 → 镜像 todos 行。
 * 🔴 项目铁律：绝不直写 todos 完事，必须 ai_bugs + 镜像双写。
 * dev_bug_id 挂 ai_bugs.id；category 固定 '开发待办'。
 */
export function mapBugMirrorTodo(bugRow) {
  return {
    title: bugRow.title,
    description: bugRow.description,
    status: 'pending',
    priority: bugRow.severity === 'high' ? 'high' : 'medium',
    category: '开发待办',
    dev_bug_id: bugRow.id,
    dev_kind: bugRow.kind,
    dev_module: bugRow.module,
    task_source: 'wb-cli',
  };
}

/**
 * 电子书 → books 行（file_path 桶内 key 或 'local:<绝对路径>' 降级标记）
 */
export function mapBook({ title, format, filePath, fileSize, uploaded }) {
  return {
    title,
    format,
    file_path: uploaded ? filePath : `local:${filePath}`,
    file_size: fileSize,
    status: 'unread',
    metadata: { source: 'wb-cli', uploaded: !!uploaded },
  };
}

/** 书名从文件名推（去扩展名、去 [站点]尾巴等常见噪声） */
export function bookTitleFromFilename(name) {
  const base = name.replace(/\.(epub|pdf|txt)$/i, '');
  return base
    .replace(/\s*[\[（(【][^\]）)】]*[\]）)】]\s*$/, '')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || name;
}

/** format 按后缀推 */
export function bookFormatFromExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (BOOK_FORMATS.includes(e)) return e;
  return null;
}

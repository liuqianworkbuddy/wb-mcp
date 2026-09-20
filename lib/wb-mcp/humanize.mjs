/**
 * wb-mcp · humanize 写操作人话反馈层
 * ------------------------------------------------
 * 背景：wb-cli 全量 --json（envelope {success,data,error}），wb-mcp 原样透传
 * ——机器可读但用户看到的只有裸 JSON。得到大脑 MCP 的「已记录到得到大脑 ✅」
 * 式摘要体验好，本模块为写命令成功路径补同款反馈（刘总 2026-09-09 提出）。
 *
 * 设计约束：
 *   1. 只动「写命令 + 退出码 0 + envelope 可解析」的成功路径，读命令原样透传
 *   2. 摘要文末必附原始 JSON——AI 消费方（id/状态回写）不受影响，人机两用
 *   3. 识别不了的命令/数据形态返回 null，调用方回落原始 JSON（永不丢信息）
 *   4. 纯函数、零依赖、零 IO——可单测，不影响握手时延
 */

/** 域 → 工作台页面路径（「去哪看」提示用） */
const DOMAIN_PAGE = {
  todo: 'liflow.cn 待办看板',
  note: 'liflow.cn/notes/ 笔记页',
  fin: 'liflow.cn 财务页',
  manage: 'liflow.cn 工作台',
  dev_task: 'liflow.cn AI开发仪表盘',
};

/** 首个非空行（截断）——标题口径与 wb-cli 各 handler 一致 */
function firstLine(s, max = 40) {
  const line = String(s || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) || '';
  return line.length > max ? line.slice(0, max) + '…' : line;
}

/** ISO → 北京时间 YYYY-MM-DD HH:mm */
function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || '').slice(0, 16).replace('T', ' ');
  const p = new Date(d.getTime() + 8 * 3600e3);
  return `${p.toISOString().slice(0, 10)} ${p.toISOString().slice(11, 16)}`;
}

/** 短 id（uuid 前 8 位） */
function shortId(id) {
  const s = String(id || '');
  return s.length > 8 ? s.slice(0, 8) + '…' : s;
}

/** 标签数组 → #a #b 展示串 */
function tagsText(tags) {
  return Array.isArray(tags) && tags.length ? tags.map((t) => `#${t}`).join(' ') : '(无标签)';
}

/**
 * 信封解析：成功信封 → data；已是裸数据形态（success:boolean）→ 原样；
 * 失败信封 → null。不抛错，形态怪异一律 null（回落透传）。
 */
function envelopeData(text) {
  let v;
  try { v = JSON.parse(String(text || '').trim()); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  if (v.success === true) return v.data;
  return null; // 失败信封 / 裸标量 / 未知形态
}

/** 主输出组装：头部 + 字段行 + 去哪看 + 原始 JSON 附录 */
function render(lines, json, domain) {
  const head = [`已记录到 AI 工作台 ✅`, ...lines.map((l) => `  ${l}`)];
  const page = DOMAIN_PAGE[domain] ? `\n  去哪看：${DOMAIN_PAGE[domain]}` : '';
  return `${head.join('\n')}${page}\n\n（原始数据，供程序读取：\n${json}\n）`;
}

/* ============================================================
 * 各命令族摘要器：入参（data, argv, rawText）→ 文案 | null
 * data 为 envelope.data；识别不了返回 null 由调用方回落透传。
 * ============================================================ */

const HUMANIZERS = [
  // ---- note add（cmd-note.mjs：data = { note: created }）----
  {
    match: (argv) => argv[0] === 'note' && argv[1] === 'add',
    render: (data) => {
      const n = data && data.note;
      if (!n || typeof n !== 'object') return null;
      return [
        `类型：笔记`,
        `标题：${firstLine(n.title) || '(无标题)'}`,
        `标签：${tagsText(n.tags)}`,
        `时间：${fmtTime(n.created_at)}`,
        `id：${shortId(n.id)}`,
      ];
    },
  },

  // ---- todo done（主文件：data = { done: row }，row 仅 id/title）----
  {
    match: (argv) => argv[0] === 'todo' && argv[1] === 'done',
    render: (data) => {
      const t = data && data.done;
      if (!t || typeof t !== 'object') return null;
      return [
        `类型：待办 · 标完成`,
        `标题：${firstLine(t.title) || '(无标题)'}`,
        `id：${shortId(t.id)}`,
      ];
    },
  },

  // ---- schedule done（主文件：data = { updated }）----
  {
    match: (argv) => argv[0] === 'schedule' && argv[1] === 'done',
    render: (data) => {
      const s = data && data.updated;
      if (!s || typeof s !== 'object') return null;
      return [
        `类型：日程 · 标完成`,
        `标题：${firstLine(s.title) || '(无标题)'}`,
        s.start_at ? `时间：${fmtTime(s.start_at)}` : null,
        `id：${shortId(s.id)}`,
      ].filter(Boolean);
    },
  },

  // ---- idea add（dispatchAdd：result = { type:'idea', reason, writes:[主数据+镜像] }）----
  {
    match: (argv) => argv[0] === 'idea' && argv[1] === 'add',
    render: (data) => {
      if (!data || data.type !== 'idea' || !Array.isArray(data.writes) || !data.writes.length) return null;
      const main = data.writes[0];
      return [
        `类型：AI 点子`,
        `标题：${firstLine(main.title) || '(无标题)'}`,
        data.writes.length > 1 ? `镜像：待办看板已建关联行（id=${shortId(data.writes[1].id)}）` : null,
        `id：${shortId(main.id)}`,
      ].filter(Boolean);
    },
  },

  // ---- bug add（同上，type='bug'）----
  {
    match: (argv) => argv[0] === 'bug' && argv[1] === 'add',
    render: (data) => {
      if (!data || data.type !== 'bug' || !Array.isArray(data.writes) || !data.writes.length) return null;
      const main = data.writes[0];
      return [
        `类型：开发待办`,
        `标题：${firstLine(main.title) || '(无标题)'}`,
        data.writes.length > 1 ? `镜像：待办看板已建关联行（id=${shortId(data.writes[1].id)}）` : null,
        `id：${shortId(main.id)}`,
      ].filter(Boolean);
    },
  },

  // ---- schedule add / todo add / capsule add 等 dispatchAdd 族（result.type 命名）----
  {
    match: (argv) => ['schedule', 'todo', 'capsule', 'diary', 'article'].includes(argv[0]) && argv[1] === 'add',
    render: (data, argv) => {
      if (!data || !Array.isArray(data.writes) || !data.writes.length || !data.type) return null;
      if (data.type !== argv[0]) return null; // 只认类型一致的（防 add 命令语义漂移）
      const main = data.writes[0];
      const LABEL = { schedule: '日程', todo: '待办', capsule: '闪念', diary: '日记', article: '公众号收藏' };
      const lines = [
        `类型：${LABEL[data.type] || data.type}`,
        `标题：${firstLine(main.title) || firstLine(main.content || main.content_md, 30) || '(无标题)'}`,
      ];
      if (data.type === 'schedule' && main.start_at) lines.push(`时间：${fmtTime(main.start_at)}`);
      if (main.location) lines.push(`地点：${main.location}`);
      if (data.type === 'capsule' || data.type === 'diary') {
        lines.push(`原文：${firstLine(main.content || main.content_md, 60)}`);
      }
      if (data.type === 'article' && main.url) lines.push(`链接：${main.url}`);
      lines.push(`id：${shortId(main.id)}`);
      return lines;
    },
  },

  // ---- add（manage 域 AI 判类全类型录入）----
  // ⚠️ 主文件 dispatchAdd 收 pos.slice(1) 为正文：'add 文本' 经 resolveLongInput
  // 后 argv 仍是两词，数据面靠 data.type 判别（LABEL 覆盖 9 类）。
  {
    match: (argv) => argv[0] === 'add' && (argv.length < 2 || !['done', 'edit', 'del', 'tag'].includes(argv[1])),
    render: (data, argv) => {
      if (argv[0] !== 'add') return null;
      if (!data || !Array.isArray(data.writes) || !data.writes.length || !data.type) return null;
      const main = data.writes[0];
      const LABEL = {
        todo: '待办', schedule: '日程', capsule: '闪念', diary: '日记', note: '笔记',
        article: '公众号收藏', idea: 'AI 点子', bug: '开发待办', book: '电子书', other: '闪念（兜底）',
      };
      const lines = [
        `类型：${LABEL[data.type] || data.type}（AI 判类）`,
        `标题：${firstLine(main.title) || firstLine(main.content || main.content_md, 30) || '(无标题)'}`,
      ];
      if (data.type === 'schedule' && main.start_at) lines.push(`时间：${fmtTime(main.start_at)}`);
      if (main.location) lines.push(`地点：${main.location}`);
      if (data.writes.length > 1) lines.push(`镜像：待办看板已建关联行`);
      lines.push(`id：${shortId(main.id)}`);
      return lines;
    },
  },

  // ---- wb_note_add / wb_todo_done 等细粒度写工具：argv 同构，天然被上方命中，无需单列 ----
];

/**
 * 生成人话反馈。
 * @param {object} opts
 * @param {string} opts.argvStr   写命令 join(' ') 后的串（域校验已通过的 argv）
 * @param {string} opts.json      wb-cli 成功输出原文（envelope JSON 文本）
 * @returns {string|null} 摘要文案；null = 无摘要器命中或数据形态不识别（调用方透传原 JSON）
 */
export function humanize(argvStr, json) {
  const argv = String(argvStr || '').trim().split(/\s+/).filter(Boolean);
  if (argv.length < 2) return null;
  const data = envelopeData(json);
  if (!data) return null;
  for (const h of HUMANIZERS) {
    if (!h.match(argv)) continue;
    let lines;
    try { lines = h.render(data, argv); } catch { lines = null; }
    if (Array.isArray(lines) && lines.length) return render(lines, json, argv[0]);
  }
  return null;
}

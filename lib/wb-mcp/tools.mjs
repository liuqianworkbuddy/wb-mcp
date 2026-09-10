/**
 * wb-mcp · 6 域 tool 定义（dt_xbobex · dt_eaxp4w A段数组参数扩展）
 * ------------------------------------------------
 * 按域收敛（不按子命令拆 tool，防 tool 稀释模型选择准确率）：
 *   wb_query    全域只读调阅（t 命令族 + search/table 等）
 *   wb_todo     todo / capsule / idea / bug / book 待办闪念域
 *   wb_fin      fin 财务域
 *   wb_note     note 笔记域
 *   wb_manage   add / done / key 管理域
 *   wb_dev_task dev-task 流水线域（打勾竞态重点保护）
 *
 * 调用形态（v5.6.0 起两种，args 优先）：
 *   { command: "todo list --open", confirm?: true }          —— 字符串按空白切 argv
 *   { command: "note add", args: ["note","add","正文…","#tag"], confirm: true }
 *                                                             —— 数组原样传 argv（长文安全）
 */

/** 命令首词 → 域 归属表（P1 FR-7 单源化）：由 lib/wb-cli/capabilities.mjs 派生，
 *  手抄表已删除；新增命令只需登记 DOMAIN_TABLE/LEGACY_COMMANDS，一致性由
 *  scripts/check-domain-consistency.mjs 断言。 */
import { writeFileSync } from 'node:fs';
import { DOMAIN_TABLE, isWriteInvocation } from '../wb-cli/capabilities.mjs';

/** P1 FR-6 超时三档（毫秒）：读 15s / 写 60s / 批量与构建 120s（按域默认，spec 可覆盖） */
export const DOMAIN_TIMEOUT = {
  query: 15e3, todo: 60e3, fin: 15e3, note: 15e3, manage: 15e3,
  dev_task: 60e3, vault: 60e3, archive: 60e3,
};
export const TIMEOUT_WRITE = 60e3;
export const TIMEOUT_BATCH = 120e3;
export const COMMAND_DOMAINS = DOMAIN_TABLE;

/** 域描述（tool description 用） */
export const DOMAIN_DESC = {
  query: '全域只读调阅：wb-cli 的 search/table/fill/growth/canvas/artifact/log/decision/orpt/people/doctor 命令族，跨 49 张表查询 AI 工作台数据（待办/闪念/日程/人脉/财务/成长/画布/日志/开发）；doctor=环境自检（node/key/网关/表权限/版本）。只读安全。',
  todo: '待办与闪念域：todo/capsule/idea/bug/book/schedule 命令族（列表/详情/完成/编辑/标签）。含写操作需 confirm。',
  fin: '财务域：fin 命令族（账户/流水/分类/预算/目标/订阅等）。含写操作需 confirm。',
  note: '笔记域：note 命令族（笔记列表/新增/编辑）。含写操作需 confirm。',
  manage: '管理域：add（全类型录入 AI 判类）/ done（打标）/ key（API Key 签发/清单/吊销）。写操作需 confirm；key 域建议直接终端操作。',
  dev_task: '开发任务流水线域：dev-task 命令族（list/show/create/stage/item 九步链回写）。写操作需 confirm；并发打勾由串行队列保护。',
  vault: 'vault 云档只读域（P1 · dt_iy2eek）：vault list/search/read 命令族，检索与读取 Obsidian 主库上云 md（COS vault-store 桶 obsidian/ 前缀 + vault_files 索引，刘总 5 年历史思考）。示例：vault search 精力 → vault read <path>。只读安全，readonly profile 可见。',
  archive: 'archive 记忆档案只读域（P4 · dt_mkq335）：archive list/show/gen/detect 命令族。list=档案清单（vault 桶 archive/ 前缀）；show=档案 md 全文（示例：archive show 顾铭）；gen=透传 A 段生成脚本；detect=近 N 天闪念+决策 × 档案的矛盾/关联检测（无 LLM 时自动降级素材摘要）。「顾铭眼中的刘总」档案是所有 AI 的公共记忆资产，会话开场可 archive list 查看、archive show 读取。只读安全，readonly profile 可见。',
};

/** 写动词判定（命中即需 confirm:true 才放行） */

/**
 * 写路径细粒度工具 specs（D段 FR-8 · dt_o2ch2u）。
 * params 是单源：inputSchema、tool description、argv 组装三者都由它生成，
 * 不手写三遍。每条对齐 wb-cli 真实子命令的 flags（逐 handler 核实）。
 * book add（--file 本地电子书）MCP 场景低频且涉本机路径，不拆、走 wb_query/域 tool。
 */
export const WRITE_TOOL_SPECS = [
  {
    tool: 'wb_todo_done', domain: 'todo', argv: ['todo', 'done'],
    summary: '完成待办',
    params: [{ name: 'id', type: 'string', required: true, positional: true, desc: '待办 id（前缀匹配）' }],
  },
  {
    tool: 'wb_todo_edit', domain: 'todo', argv: ['todo', 'edit'],
    summary: '编辑待办字段（至少传一个要改的）',
    params: [
      { name: 'id', type: 'string', required: true, positional: true, desc: 'id 前缀' },
      { name: 'title', type: 'string', desc: '新标题' },
      { name: 'priority', type: 'string', enum: ['high', 'medium', 'low'], desc: '优先级' },
      { name: 'due', type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', desc: '截止日期 YYYY-MM-DD' },
      { name: 'category', type: 'string', desc: '分类' },
      { name: 'status', type: 'string', enum: ['pending', 'featured', 'completed'], desc: '状态' },
    ],
  },
  {
    tool: 'wb_todo_tag', domain: 'todo', argv: ['todo', 'tag'],
    summary: '待办标签增删（至少传 add 或 del）',
    params: [
      { name: 'id', type: 'string', required: true, positional: true, desc: 'id 前缀' },
      { name: 'add', type: 'string', desc: '要加的标签，逗号分隔' },
      { name: 'del', type: 'string', desc: '要删的标签，逗号分隔' },
    ],
  },
  {
    tool: 'wb_todo_del', domain: 'todo', argv: ['todo', 'del'],
    summary: '删除待办（不可恢复，慎用）',
    params: [{ name: 'id', type: 'string', required: true, positional: true, desc: 'id 前缀' }],
  },
  {
    tool: 'wb_idea_add', domain: 'todo', argv: ['idea', 'add'],
    summary: '直录 AI 点子（不经 AI 判类；仅当用户明确要记点子时用，泛化记录走 wb_add）',
    params: [
      { name: 'raw', type: 'string', required: true, positional: true, maxLen: 2000, longInput: true, desc: '点子原文（含空格换行均可）' },
      { name: 'title', type: 'string', desc: '标题（缺省取原文前 30 字）' },
    ],
  },
  {
    tool: 'wb_note_add', domain: 'note', argv: ['note', 'add'],
    summary: '写笔记（capsules 表，#标签 自动解析；仅当用户明确要记笔记时用，泛化记录走 wb_add）',
    params: [
      { name: 'content', type: 'string', required: true, positional: true, maxLen: 20000, longInput: true, desc: '笔记正文，含空格换行原样入库，#标签 自动解析' },
    ],
  },
  {
    tool: 'wb_note_edit', domain: 'note', argv: ['note', 'edit'],
    summary: '改笔记（换正文重解析标签 / 仅改标题）',
    params: [
      { name: 'id', type: 'string', required: true, positional: true, desc: '笔记 id 前缀' },
      { name: 'file', type: 'string', desc: '新正文的 md 文件路径' },
      { name: 'title', type: 'string', desc: '新标题' },
    ],
  },
  {
    tool: 'wb_schedule_add', domain: 'todo', argv: ['schedule', 'add'],
    summary: '新增日程（自然语言或 --at 显式时间；仅当用户明确要加日程时用，泛化记录走 wb_add）',
    params: [
      { name: 'text', type: 'string', required: true, positional: true, maxLen: 500, desc: '日程描述（自然语言）' },
      { name: 'at', type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}[ T]\\d{1,2}:\\d{2}$', desc: '显式时间 YYYY-MM-DD HH:mm' },
      { name: 'loc', type: 'string', desc: '地点' },
    ],
  },
  {
    tool: 'wb_add', domain: 'manage', argv: ['add'],
    summary: '全类型录入·默认入口（泛化记录指令一律走这里：AI 判类自动路由到 待办/闪念/bug/日程等表）',
    params: [
      { name: 'text', type: 'string', required: true, positional: true, maxLen: 5000, longInput: true, desc: '用户原文原样传入，调用方勿总结/改写/润色（AI 自动判类；前缀「修复/优化/闪念/日程」可引导判类）' },
      { name: 'type', type: 'string', desc: '强制指定类型别名（跳过 AI 判类，如 todo/bug/idea/schedule）' },
    ],
  },
  {
    tool: 'wb_dev_task_create', domain: 'dev_task', argv: ['dev-task', 'create'],
    summary: '新建开发任务（S0 需求汇总自动生成）',
    params: [
      { name: 'title', type: 'string', required: true, desc: '任务标题' },
      { name: 'bugs', type: 'string', required: true, desc: '关联待办 id（逗号分隔，支持前缀）' },
    ],
  },
  {
    tool: 'wb_dev_task_stage', domain: 'dev_task', argv: ['dev-task', 'stage'],
    summary: '九步链步骤回写（每完成一步必须回写）',
    params: [
      { name: 'id', type: 'string', required: true, positional: true, desc: '开发任务 id 前缀' },
      { name: 'key', type: 'string', required: true, positional: true, enum: ['brief', 'prd', 'tdd', 'wbs', 'dev', 'handoff', 'release', 'test', 'wrap'], desc: '步骤' },
      { name: 'status', type: 'string', enum: ['running', 'done'], desc: '步骤状态（缺省 done）' },
      { name: 'file', type: 'string', desc: '产物文件路径（内容写入步骤）' },
      { name: 'note', type: 'string', desc: '备注' },
      { name: 'kind', type: 'string', enum: ['html', 'md'], desc: '产物类型' },
    ],
  },
  {
    tool: 'wb_dev_task_item', domain: 'dev_task', argv: ['dev-task', 'item'],
    summary: 'S4 条目 / S7 清单打勾',
    params: [
      { name: 'id', type: 'string', required: true, positional: true, desc: '开发任务 id 前缀' },
      { name: 'key', type: 'string', required: true, positional: true, desc: '步骤（dev/test）' },
      { name: 'index', type: 'number', required: true, desc: '条目序号（0 起）' },
      { name: 'status', type: 'string', enum: ['done', 'pending'], desc: '目标状态' },
      { name: 'note', type: 'string', desc: '备注' },
    ],
  },
];

/** params → MCP inputSchema（JSON Schema 直传，零依赖） */
export function specToInputSchema(spec) {
  const properties = {
    confirm: { type: 'boolean', description: '写操作必传 true（安全门）', default: false },
  };
  const required = [];
  for (const p of spec.params) {
    const prop = { type: p.type, description: (p.desc || '') + (p.enum ? `（可选：${p.enum.join('/')}）` : '') };
    if (p.enum) prop.enum = p.enum;
    if (p.pattern) prop.pattern = p.pattern;
    properties[p.name] = prop;
    if (p.required) required.push(p.name);
  }
  return { type: 'object', properties, required };
}

/** params → tool description（与 schema 同源，不手写） */
export function specDescription(spec) {
  const ps = spec.params
    .map((p) => `${p.name}${p.required ? '*' : ''}(${p.desc || p.type})`)
    .join(', ');
  return `${spec.summary}。对应 CLI：${spec.argv.join(' ')}。参数：${ps}。写操作须 confirm:true。`;
}

/**
 * 校验 arguments 并组装 wb-cli argv（D段 FR-8：非法参数在此拦截，不发起子进程）。
 * positional 参数按定义序 push，其余转 --name value。
 */
export function buildSpecArgv(spec, args, { tmpDir } = {}) {
  const errors = [];
  const argv = [...spec.argv];
  const tmpFiles = [];
  const a = args || {};
  for (const p of spec.params) {
    const v = a[p.name];
    if (v === undefined || v === null || v === '') {
      if (p.required) errors.push(`缺少必填参数 ${p.name}（${p.desc || p.type}）`);
      continue;
    }
    const s = String(v);
    if (p.type === 'number' && !/^-?\d+$/.test(s)) errors.push(`参数 ${p.name} 需为数字，收到「${s}」`);
    if (p.enum && !p.enum.includes(s)) errors.push(`参数 ${p.name} 仅支持：${p.enum.join('/')}`);
    if (p.pattern && !new RegExp(p.pattern).test(s)) errors.push(`参数 ${p.name} 格式不符（需 ${p.pattern}）`);
    if (p.maxLen && s.length > p.maxLen) errors.push(`参数 ${p.name} 超 ${p.maxLen} 字符上限（现 ${s.length}）`);
    if (p.longInput && s.length > 16384 && tmpDir) {
      // P1 FR-3：MCP 长文走临时文件中转（CLI --content-file 通道），tmpFiles 由调用方清理
      const tmp = `${tmpDir}/.wb-longinput-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`;
      writeFileSync(tmp, s);
      tmpFiles.push(tmp);
      argv.push('--content-file', tmp);
    } else if (p.positional) argv.push(s);
    else argv.push(`--${p.name}`, s);
  }
  // 未声明的键 = 调用方拼错参数名，显式拒绝（与 FR-1 静默吞参数教训同源）
  const known = new Set(spec.params.map((p) => p.name).concat(['confirm']));
  for (const k of Object.keys(a)) {
    if (!known.has(k)) errors.push(`未知参数 ${k}（本工具支持：${[...known].join(', ')}）`);
  }
  return { ok: errors.length === 0, errors, argv, tmpFiles };
}


/**
 * command 字符串按 shell 规则切分（A段 FR-1）：单/双引号包裹的参数
 * 含空格不切碎、引号成对还原；未闭合引号按「剩余为一段」闭合（契约：
 * 复杂引号/嵌套场景请走 args 数组形态，字符串形态不做转义）。
 */
export function splitCommandString(s) {
  const out = [];
  let cur = '';
  let q = null;
  for (const ch of String(s)) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 归一：command(string) | args(string[]) → argv 数组；空返回 null */
export function toArgv(command, args) {
  if (Array.isArray(args) && args.length > 0) return args.map((a) => String(a));
  const s = String(command || '').trim();
  if (!s) return null;
  return splitCommandString(s);
}

/** argv → 展示串（错误提示用：截短防长文刷屏） */
export function displayOf(argv) {
  const s = (Array.isArray(argv) ? argv.join(' ') : String(argv || '')).trim();
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

/**
 * 判定是否写操作。接受 string | string[]（数组 join(' ') 后判定，confirm 门语义不变）。
 * @param {string|string[]} command
 * @returns {boolean}
 */
export function isWriteCommand(command) {
  // P1 FR-1：写动词正则退役——confirm 边界查契约表（capabilities.mjs isWriteInvocation）
  return isWriteInvocation(command);
}

/**
 * 解析首词。接受 string | string[]：数组取首个元素的第一个词
 * （防御：AI 偶发把整条命令塞进 args[0]，如 ["note add","正文"]）。
 * @param {string|string[]} command
 * @returns {string} 如 "dev-task"
 */
export function firstToken(command) {
  const head = Array.isArray(command) ? String(command[0] || '') : String(command || '');
  const m = head.trim().match(/^[\w-]+/);
  return m ? m[0] : '';
}

/** 首词 → 域；未知返回 null（调用方拒绝并提示） */
export function domainOf(command) {
  const head = firstToken(command);
  return COMMAND_DOMAINS[head] || null;
}

/**
 * 6 域 tool 的 MCP 定义（name/description/inputSchema）。
 * readonly profile（hermes）只放 query 域。
 */
export function buildToolDefs({ readonly = false } = {}) {
  const defs = [
    { name: 'wb_query', domain: 'query', readOnly: true },
    { name: 'wb_todo', domain: 'todo', readOnly: false },
    { name: 'wb_fin', domain: 'fin', readOnly: false },
    { name: 'wb_note', domain: 'note', readOnly: false },
    { name: 'wb_manage', domain: 'manage', readOnly: false },
    { name: 'wb_dev_task', domain: 'dev_task', readOnly: false },
    { name: 'wb_vault', domain: 'vault', readOnly: true },
    { name: 'wb_archive', domain: 'archive', readOnly: true },
  ];
  return defs.filter((d) => !(readonly && !d.readOnly));
}

/**
 * 参数 schema（MCP inputSchema JSON Schema 格式，各 tool 同构）。
 * v5.6.0 新增 args 数组：元素原样作为 argv 传给 wb-cli，不按空白切分
 * ——长文（笔记正文 500+ 字）含空格/换行不会被切碎，告别「占位+edit 两步绕行」。
 * required 保持 ['command'] 兼容旧客户端（args-only 调用由客户端侧必填 command 保证；
 * 服务端 handler 对两者全缺的情况兜底报 400）。
 */
export function commonInputSchema() {
  return {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'wb-cli 命令串（不含 wb-cli 前缀），如 "t todo"、"todo list --open"、"dev-task show dt_xxx"。与 args 二选一：传了 args 时 args 优先。各域允许的首词见 tool description。',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: '命令参数数组（推荐，长文安全）：如 ["note","add","这里是500字正文，含空格换行都不会被切碎","#工作笔记"]。数组元素原样作为 argv 传给 wb-cli，不按空白切分。command 仍需传（可传命令串本身），实际执行以 args 为准。',
      },
      confirm: {
        type: 'boolean',
        description: '写操作必传 true（安全门）。判定为写操作的命令（add/done/edit/del/stage/item 等）缺 confirm 会被拒绝。',
        default: false,
      },
    },
    required: ['command'],
  };
}

/**
 * wb-cli · capabilities 机器契约（dt_o2ch2u C段 · FR-6）
 * ------------------------------------------------
 * 单源真相 = registry 动态注册命令（B段起带 domain/params/write/confirmNeed/
 * resultFields/limits 扩展元数据）+ 主文件 switch 老命令静态最小契约（legacy:true，
 * 渐进债显式化，不强制外移）。registry 新注册一条带元数据的命令，capabilities
 * 自动包含——契约从代码生成，不做两处手工维护。
 *
 * 消费方：wb-cli capabilities [--json|--md]、wb-mcp（D 段细粒度工具 description 同源生成）、
 * 各 Agent 接入文档（docs/wb-cli-capabilities.md 为 `--md` 生成物，DO NOT EDIT）。
 */

export const CONTRACT_VERSION = '1.0';

/**
 * confirm 查表（P1 FR-1 · dt_r5j0rp）：写动词正则退役。
 * 两层语义：FAMILY_WRITE=整族含写（族内任意调用按写对待）；
 * SUBCOMMAND_WRITE=仅列出的子命令是写。未命中走通用写动词兜底
 * （对登记滞后的新命令保守放行到 confirm 门，误拦安全于漏拦）。
 */
export const FAMILY_WRITE = new Set(['add', 'fill', 'key', 'dev-task', 'idea', 'bug', 'book', 'image']);
export const SUBCOMMAND_WRITE = {
  todo: ['done', 'edit', 'del', 'tag'],
  capsule: ['add', 'edit', 'tag'],
  note: ['add', 'edit', 'tag'],
  schedule: ['add', 'done', 'del'],
};
const GENERIC_WRITE_VERBS = new Set(['done', 'edit', 'del', 'tag', 'add', 'fix', 'import', 'remove', 'create', 'rename']);

/** confirm 门判定（P1 FR-1 单一入口）。argv：命令参数数组或命令串。 */
export function isWriteInvocation(argv) {
  const a = Array.isArray(argv) ? argv.map(String) : splitCmd(String(argv || ''));
  const family = (a[0] || '').toLowerCase();
  const sub = (a[1] || '').toLowerCase();
  if (FAMILY_WRITE.has(family)) return true;
  if (SUBCOMMAND_WRITE[family]) return SUBCOMMAND_WRITE[family].includes(sub);
  // 兜底：未登记命令的第二词命中通用写动词 → 保守按写对待
  if (GENERIC_WRITE_VERBS.has(sub)) return true;
  return false;
}

function splitCmd(s) {
  return s.trim().split(/\s+/).filter(Boolean);
}

/**
 * 主文件 switch 老命令静态最小契约。
 * domain 与 lib/wb-mcp/tools.mjs COMMAND_DOMAINS 同构（该表为 MCP 路由消费方）；
 * write=true 表示命令族含写动词（confirm 门按子命令实际判定）。
 */
export const LEGACY_COMMANDS = [
  { name: 'todo', domain: 'todo', write: true, summary: '待办增删改查（list/add/done/edit/del/tag；list 已接游标分页）', legacy: true },
  { name: 'idea', domain: 'todo', write: true, summary: 'AI 点子（list 默认/add/show）', legacy: true },
  { name: 'bug', domain: 'todo', write: true, summary: '开发待办（list/add/show/done/fix；list 已接游标分页）', legacy: true },
  { name: 'capsule', domain: 'todo', write: true, summary: '闪念胶囊（list 默认/search/tag/add/edit；list 已接游标分页）', legacy: true },
  { name: 'schedule', domain: 'todo', write: true, summary: '日程（list/today/add/del）', legacy: true },
  { name: 'book', domain: 'todo', write: true, summary: '书库（list 已接游标分页/add --file）', legacy: true },
  { name: 'add', domain: 'manage', write: true, summary: '全类型录入（AI 判类路由各表）', legacy: true },
  { name: 'fill', domain: 'query', write: true, summary: '模板化录入（FILL_TEMPLATES 路由）', legacy: true },
  { name: 'dev-task', domain: 'dev_task', write: true, summary: '开发任务九步链（list 已接游标分页/show/create/stage/item）', legacy: true },
  { name: 'key', domain: 'manage', write: true, summary: 'API Key 签发/清单/吊销（建议终端操作）', legacy: true },
];

/**
 * 元数据前时代 cmd-* 模块的域兜底（与 lib/wb-mcp/tools.mjs COMMAND_DOMAINS 同构）。
 * 过渡期用：新命令注册时应自带 domain 元数据（doctor/capabilities 先例），
 * 存量模块逐个补齐后本表退役。
 */
const DOMAIN_FALLBACK = {
  search: 'query', table: 'query', growth: 'query', canvas: 'query',
  artifact: 'query', log: 'query', decision: 'query', orpt: 'query', people: 'query',
  fin: 'fin', note: 'note', diary: 'todo', vault: 'vault', archive: 'archive',
  image: 'image',
};

/**
 * 合并动态注册命令与 legacy 静态表为完整契约。
 * @param {object} registry createRegistry() 实例（需支持 entries()）
 */
export function buildCapabilities(registry) {
  const dynamic = registry.entries().map((c) => ({
    name: c.name,
    domain: c.domain ?? DOMAIN_FALLBACK[c.name] ?? null,
    params: Array.isArray(c.params) ? c.params : null,
    write: c.write ?? null,
    confirmNeed: c.confirmNeed ?? (c.write ?? false),
    resultFields: Array.isArray(c.resultFields) ? c.resultFields : null,
    limits: c.limits ?? null,
    summary: c.summary || '',
    legacy: false,
  }));
  return {
    contract_version: CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
    commands: [...dynamic, ...LEGACY_COMMANDS],
  };
}

/** 渲染 markdown（`capabilities --md` 生成物，入仓 docs/ 前加 DO NOT EDIT 头） */
export function renderMd(cap) {
  const lines = [
    '# wb-cli capabilities 命令契约（自动生成）',
    '',
    `> DO NOT EDIT · 由 \`wb-cli capabilities --md\` 生成于 ${cap.generated_at} · contract v${cap.contract_version}`,
    '> 单源=lib/wb-cli/registry.mjs（动态注册，含扩展元数据）+ capabilities.mjs LEGACY_COMMANDS（switch 老命令）。',
    '',
    '| 命令 | 域 | 含写 | confirm | 结果字段 | 说明 |',
    '|---|---|---|---|---|---|',
  ];
  for (const c of cap.commands) {
    const params = Array.isArray(c.params) ? c.params.map((p) => p.name).join(' ') : '—';
    lines.push(
      `| \`${c.name}\`${c.legacy ? '（legacy）' : ''} | ${c.domain ?? '—'} | ${c.write ? '是' : '—'} | ${c.confirmNeed ? '是' : '—'} | ${Array.isArray(c.resultFields) ? c.resultFields.join(' ') : '—'} | ${c.summary || ''} |`,
    );
    if (Array.isArray(c.params) && c.params.length) {
      lines.push(`| ↳ 参数 | ${params} | | | | ${c.params.map((p) => `${p.name}${p.required ? '*(必填)*' : ''}:${p.desc || p.type || ''}`).join('；')} |`);
    }
  }
  lines.push('', `共 ${cap.commands.length} 个命令（动态 ${cap.commands.filter((c) => !c.legacy).length} + legacy ${cap.commands.filter((c) => c.legacy).length}）。`);
  return lines.join('\n');
}

/**
 * 域路由单源表（P1 FR-7）：LEGACY_COMMANDS + DOMAIN_FALLBACK 合并 + 新命令登记。
 * lib/wb-mcp/tools.mjs 的 COMMAND_DOMAINS 改由本表派生（手抄表已删）；
 * 一致性由 scripts/check-domain-consistency.mjs 断言防回退。
 * 注意：须定义在 LEGACY_COMMANDS / DOMAIN_FALLBACK 之后（const 时序依赖）。
 */
export const DOMAIN_TABLE = Object.freeze((() => {
  const merged = {};
  for (const c of LEGACY_COMMANDS) if (c.domain) merged[c.name] = c.domain;
  for (const [k, v] of Object.entries(DOMAIN_FALLBACK)) merged[k] = v;
  Object.assign(merged, { doctor: 'query', capabilities: 'query', help: 'query', quota: 'query', task: 'query', update: 'manage', setup: 'manage' });
  return merged;
})());

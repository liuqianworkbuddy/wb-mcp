/**
 * wb-cli · help 体系（dt_4er4pw P2 · FR-2）
 * ------------------------------------------------
 * wb-cli help [命令] / <命令> --help：从 capabilities 合并契约（LEGACY+动态注册
 * +细粒度 specs）自动渲染 summary/参数表/confirm 边界/真实示例，与 P0-6 单源。
 * 别名表 ALIASES 支持常用缩写。
 */

import { CONTRACT_VERSION, LEGACY_COMMANDS, FAMILY_WRITE, SUBCOMMAND_WRITE } from './capabilities.mjs';
import { WRITE_TOOL_SPECS } from '../wb-mcp/tools.mjs';

/** 常用别名（输入侧归一） */
export const ALIASES = {
  t: 'todo', td: 'todo', nt: 'note', cp: 'capsule', bg: 'bug',
  dt: 'dev-task', sch: 'schedule', cap: 'capabilities', dr: 'doctor',
};

/** 每命令真实示例（capabilities 同源维护） */
export const EXAMPLES = {
  todo: ['todo list --limit 5', 'todo list --today', 'todo add <文本>', 'todo done <id前缀>', 'todo tag <id前缀> --add 工作,紧急'],
  note: ['note add "正文… #标签"', 'note list --limit 10', 'note search 关键词', 'note add --content-file 笔记.md --idempotency-key n1'],
  bug: ['bug list --open', 'bug list --limit 10', 'bug show <id前缀>'],
  'dev-task': ['dev-task list --search 得到大脑', 'dev-task show dt_xxx', 'dev-task stage dt_xxx prd --status done --file docs/PRD.md'],
  capsule: ['capsule list', 'capsule search 关键词 --tag 标签'],
  schedule: ['schedule add "明天下午3点开会" --at "2026-09-08 15:00"', 'schedule today'],
  doctor: ['doctor', 'doctor --json'],
  quota: ['quota', 'quota --json'],
  capabilities: ['capabilities', 'capabilities --json', 'capabilities --md'],
  update: ['update'],
  setup: ['setup --dry-run', 'setup'],
  task: ['task list', 'task status --id <task_id>'],
};

function findEntry(name, registry) {
  const entry = LEGACY_COMMANDS.find((c) => c.name === name);
  if (entry) return { ...entry, params: null };
  const spec = WRITE_TOOL_SPECS.find((s) => s.tool === name);
  if (spec) return { name: spec.tool, domain: spec.domain, write: true, summary: spec.summary, params: spec.params, examples: spec.examples || [] };
  // 动态注册命令（cmd-* 族）：从注册器取 summary/元数据
  if (registry && registry.has(name)) {
    const meta = registry.entries().find((c) => c.name === name) || {};
    return { name, domain: meta.domain || null, write: !!meta.write, summary: meta.summary || '', params: meta.params || null };
  }
  return null;
}

function renderHelp(name, registry) {
  const e = findEntry(name, registry);
  if (!e) return `未知命令：${name}（wb-cli help 查看全部）`;
  const lines = [];
  lines.push(`wb-cli ${e.name} — ${e.summary || ''}`);
  lines.push(`  域：${e.domain} ｜ 写操作：${e.write ? '是（confirm 边界：' + confirmDesc(name) + '）' : '否（只读）'}`);
  if (Array.isArray(e.params) && e.params.length) {
    lines.push('  参数：');
    for (const p of e.params) {
      lines.push(`    ${p.required ? '*' : ' '} ${p.name}  ${p.type}${p.desc ? `  ${p.desc}` : ''}${p.enum ? `（可选：${p.enum.join('/')}）` : ''}`);
    }
  }
  const ex = e.examples || EXAMPLES[name] || [];
  if (ex.length) {
    lines.push('  示例：');
    for (const x of ex) lines.push(`    wb-cli ${x}`);
  }
  return lines.join('\n');
}

function confirmDesc(name) {
  if (SUBCOMMAND_WRITE[name]) return `子命令 ${SUBCOMMAND_WRITE[name].join('/')} 需 confirm`;
  return '整族需 confirm';
}

export function register(registry, ctx) {
  registry.register('help', {
    summary: '命令帮助：summary/参数/confirm 边界/示例（capabilities 单源渲染）',
    lines: ['  help [命令]                        命令帮助（别名：--help）'],
    handler: cmdHelp,
    domain: 'query',
    write: false,
    confirmNeed: false,
    params: [{ name: 'cmd', type: 'string', required: false, positional: true, desc: '命令名（缺省=全量契约概览）' }],
    resultFields: ['contract_version', 'help'],
  });

  async function cmdHelp(flags, pos) {
    // <命令> --help 形态：pos[0] 已是命令名（主文件已剥离 --help）
    const name = pos[0] ? (ALIASES[pos[0]] || pos[0]) : null;
    if (!name) {
      ctx.output({
        contract_version: CONTRACT_VERSION,
        families_write: [...FAMILY_WRITE],
        hint: 'wb-cli help <命令> 查看参数与示例；wb-cli capabilities --json 拿机器契约',
        commands: LEGACY_COMMANDS.map((c) => c.name),
      }, () => {
        console.log(`wb-cli 契约 v${CONTRACT_VERSION} · 命令族：${LEGACY_COMMANDS.map((c) => c.name).join(' ')}\n`);
        console.log('  wb-cli help <命令> 看参数与示例（写族：' + [...FAMILY_WRITE].join(' ') + '）');
      });
      return;
    }
    const text = renderHelp(name, registry);
    ctx.output({ command: name, help: text }, () => console.log(text));
  }
}

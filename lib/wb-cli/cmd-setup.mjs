/**
 * wb-cli · setup 宿主探测与 Skill 自动分发（dt_r5j0rp C段 · FR-10）
 * ------------------------------------------------
 * 探测本机 AI 宿主目录（WorkBuddy/Claude Code/OpenClaw/ZCode），把 wb-cli 接入
 * 模板（capabilities 契约 / 快速上手 / SKILL 描述）幂等落位。幂等=内容 sha256
 * 比对 + .wb-setup.json 清单，重复执行零改动；--dry-run 只打印计划不落盘。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { REPO_ROOT } from '../wb-auth.mjs';

const HOSTS = [
  { name: 'WorkBuddy', dir: () => join(homedir(), '.workbuddy', 'skills'), always: true },
  { name: 'Claude Code', dir: () => join(homedir(), '.claude', 'skills') },
  { name: 'OpenClaw', dir: () => join(homedir(), '.openclaw', 'skills') },
  { name: 'ZCode（当前目录）', dir: () => resolve(process.cwd(), '.zcode', 'skills') },
];

const FILES = [
  { from: resolve(REPO_ROOT, 'docs', 'wb-cli-capabilities.md'), to: 'wb-cli-capabilities.md' },
  { from: resolve(REPO_ROOT, 'docs', 'wb-mcp-接入指南.md'), to: 'wb-mcp-quickstart.md' },
];

const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

export function register(registry, ctx) {
  registry.register('setup', {
    summary: '宿主探测与 Skill 幂等分发（新机器两条命令完成接入的第二条）',
    lines: ['  setup [--dry-run] [--json]         探测宿主→Skill 模板幂等落位（重复执行零改动）'],
    handler: cmdSetup,
    domain: 'manage',
    write: true,
    confirmNeed: true,
    params: [
      { name: 'dry-run', type: 'boolean', required: false, desc: '只打印落位计划不写盘' },
      { name: 'json', type: 'boolean', required: false, desc: '机器可读输出' },
    ],
    resultFields: ['hosts', 'planned', 'installed', 'skipped'],
  });

  async function cmdSetup(flags) {
    const plan = [];
    for (const h of HOSTS) {
      const dir = h.dir();
      if (!h.always && !existsSync(dir)) continue; // 宿主未安装则跳过（WorkBuddy 主宿主 always 创建）
      for (const f of FILES) {
        if (!existsSync(f.from)) continue;
        plan.push({ host: h.name, from: f.from, to: join(dir, f.to) });
      }
    }
    if (flags['dry-run']) {
      ctx.output({ hosts: [...new Set(plan.map((p) => p.host))], planned: plan, installed: 0, skipped: 0, dry_run: true }, () => {
        console.log('wb-cli setup · 落位计划（--dry-run，未写盘）\n');
        for (const p of plan) console.log(`  [${p.host}] ${p.from}\n    → ${p.to}`);
        if (!plan.length) console.log('  （未探测到可用宿主目录）');
      });
      return;
    }
    let installed = 0;
    let skipped = 0;
    const detail = [];
    for (const p of plan) {
      const content = readFileSync(p.from);
      const hash = sha(content);
      const manifestPath = join(p.to, '..', '.wb-setup.json');
      let manifest = {};
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { /* 首次落位 */ }
      mkdirSync(dirnameOf(p.to), { recursive: true });
      if (existsSync(p.to) && manifest[p.to] === hash && sha(readFileSync(p.to)) === hash) {
        skipped++;
        detail.push({ to: p.to, action: 'skipped' });
        continue;
      }
      writeFileSync(p.to, content);
      manifest[p.to] = hash;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      installed++;
      detail.push({ to: p.to, action: 'installed' });
    }
    const result = { hosts: [...new Set(plan.map((p) => p.host))], planned: plan.length, installed, skipped, detail };
    ctx.output(result, () => {
      console.log(`wb-cli setup · Skill 分发完成：安装 ${installed}，跳过（已同版）${skipped}\n`);
      for (const d of detail) console.log(`  ${d.action === 'installed' ? '📝' : '♻️ '} ${d.to}`);
      if (!plan.length) console.log('  （未探测到可用宿主目录——WorkBuddy/Claude Code/OpenClaw 均未安装）');
    });
  }
}

function dirnameOf(p) {
  const parts = p.split(/[\\/]/);
  parts.pop();
  return parts.join('/');
}

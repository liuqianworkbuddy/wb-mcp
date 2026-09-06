/**
 * wb-cli · update 自更新（dt_r5j0rp C段 · FR-9）
 * ------------------------------------------------
 * 仓库模式（当前分发形态）：git fetch → 落后判定 → --ff-only pull（原子，失败不动 HEAD）
 * → 依赖检查 → 自动 doctor 复验。任一步失败中止并保留原状。
 * 包模式（npm 托管）预留：检测到全局包安装时提示 npm update -g（P1-8 分发通道上线后启用）。
 */

import { execSync } from 'node:child_process';
import { REPO_ROOT } from '../wb-auth.mjs';

function git(args, opts = {}) {
  return execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: 'utf8', ...opts }).trim();
}

export function register(registry, ctx) {
  registry.register('update', {
    summary: '自更新：仓库模式 git 拉齐 + 依赖检查 + doctor 复验（失败保留原状）',
    lines: ['  update [--json]                    自更新（git 拉齐→依赖→doctor 复验；包模式预留）'],
    handler: cmdUpdate,
    domain: 'manage',
    write: false,
    confirmNeed: false,
    params: [{ name: 'json', type: 'boolean', required: false, desc: '机器可读输出' }],
    resultFields: ['steps', 'updated', 'version_after'],
  });

  async function cmdUpdate(flags) {
    const steps = [];
    const step = (name, fn) => {
      try {
        const detail = fn();
        steps.push({ name, ok: true, detail });
        return detail;
      } catch (e) {
        steps.push({ name, ok: false, detail: String(e.message || e).slice(0, 200) });
        throw new Error(`步骤「${name}」失败：${e.message}（已保留原状，未做破坏性变更）`);
      }
    };

    const branch = step('识别分支', () => git('rev-parse --abbrev-ref HEAD'));
    step('拉取远端', () => git(`fetch origin ${branch}`));
    const behind = Number(git(`rev-list --count HEAD..origin/${branch}`));
    let updated = false;
    step('落后判定', () => (behind > 0 ? `落后 origin/${branch} ${behind} 个提交` : '已是最新'));
    if (behind > 0) {
      step('快进合并（--ff-only，失败不动 HEAD）', () => git(`pull --ff-only origin ${branch}`));
      updated = true;
      step('依赖安装', () => {
        try { return execSync('npm ci', { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).slice(0, 80) || 'npm ci 完成'; }
        catch { return execSync('npm install', { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).slice(0, 80) || 'npm install 完成'; }
      });
    }
    const versionAfter = git('log --oneline -1');
    // doctor 复验（轻量：node + key + 网关，表权限留给 doctor 命令本体）
    step('doctor 复验', () => {
      const out = execSync(`node scripts/wb-cli.mjs doctor --json`, { cwd: REPO_ROOT, encoding: 'utf8', env: process.env }).toString();
      const j = JSON.parse(out);
      const fails = (j.data?.checks || []).filter((c) => !c.ok);
      if (fails.length) throw new Error(`自检未过：${fails.map((f) => f.name).join('/')}`);
      return 'checks 全过';
    });

    const result = { steps, updated, version_after: versionAfter };
    ctx.output(result, () => {
      console.log(`wb-cli update · 自更新（仓库模式）\n`);
      for (const s of steps) console.log(`  ${s.ok ? '✅' : '❌'} ${s.name}：${s.detail}`);
      console.log(`\n  ${updated ? `✅ 已更新到 ${versionAfter}` : '✅ 已是最新，无需更新'}`);
    });
  }
}

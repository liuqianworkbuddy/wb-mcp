/**
 * wb-cli · doctor 环境自检（dt_o2ch2u B段 · FR-5）
 * ------------------------------------------------
 * 五层 checks（对标得到大脑 doctor 思路）：node / 认证 / 网关 / 核心表读权限 / 版本。
 * 输出 { checks, issues, next_actions, version }，--json 时经 output() 出口层包 envelope。
 * 只读探测，零写操作（readonly profile 同样可跑）；
 * 退出码恒 0（诊断本身成功与否看 issues——命令失败走顶层 catch）。
 *
 * 注册元数据带 domain/write/params/resultFields——FR-6 新元数据形态首个试点，
 * C 段 capabilities 单源生成直接消费（TDD §1.6）。
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeApi, GATEWAY_BASE, REPO_ROOT } from '../wb-auth.mjs';

const TABLES = ['todos', 'ai_bugs', 'dev_tasks'];

function maskKey(key) {
  const s = String(key || '');
  if (!s) return '(空)';
  return `${s.slice(0, 5)}…${s.slice(-3)}（len=${s.length}）`;
}

async function timed(fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { ok: true, detail, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e).slice(0, 200), ms: Date.now() - t0 };
  }
}

export function register(registry, ctx) {
  registry.register('doctor', {
    summary: '环境自检：node/key/网关/表权限/版本 五层 checks + next_actions',
    lines: ['  doctor [--json]                   环境自检（node/认证/网关/表读权限/版本，只读）'],
    handler: cmdDoctor,
    // FR-6 扩展元数据试点（registry B段起保留额外字段，C 段 capabilities 消费）
    domain: 'query',
    write: false,
    confirmNeed: false,
    params: [{ name: 'json', type: 'boolean', required: false, desc: '机器可读输出（经 envelope）' }],
    resultFields: ['checks', 'issues', 'next_actions', 'version'],
  });

  async function cmdDoctor(flags, pos) {
    const checks = [];
    const issues = [];
    const nexts = [];
    const add = (name, r, fix) => {
      checks.push({ name, ok: r.ok, detail: r.detail, ms: r.ms });
      if (!r.ok) {
        issues.push({ check: name, detail: r.detail });
        if (fix) nexts.push(fix);
      }
    };

    // 1. node（server 侧同款探测链思路：execPath + version）
    add('node', await timed(async () => {
      const v = process.version;
      if (!process.execPath) throw new Error('process.execPath 为空');
      return `${v}（${process.execPath}）`;
    }), 'node 异常：检查 node 安装，或设 WB_NODE 指向正确可执行文件');

    // 2. 认证（resolveAuth 与主链路同 env 同 profile，结果一致；不回显完整 key）
    const { auth, base, api } = makeApi({ profile: process.env.WB_PROFILE });
    add('auth', await timed(async () => {
      if (!auth.key) throw new Error(`未找到 wbk_ key（profile=${auth.profile}，source=${auth.source}）`);
      if (String(auth.source).includes('builtin-fallback')) throw new Error(`profile 配置缺失，降级匿名 fallback（profile=${auth.profile}）`);
      if (auth.mode === 'legacy' && process.env.WB_PROFILE) {
        // 指定了 profile 却没命中网关 key——wb-mcp 场景最常见的配错形态（静默降级直连）
        return `⚠️ legacy 直连（指定 profile=${auth.profile} 未命中网关 key，现用 ${auth.source}）——wb-mcp 场景应在 profile env 配 wbk_ WB_API_KEY`;
      }
      return `${auth.mode}/${auth.profile} · ${maskKey(auth.key)}（${auth.source}）`;
    }), `认证配置缺失：在 ~/.workbuddy/agents/${auth.profile}.env 配 WB_API_KEY（wbk_ 前缀）；没有 key 到 liflow.cn/settings/ 用站长密码自助签发`);

    // 3. 网关可达（任何 HTTP 响应都算可达——404 只说明无 /health 路由，链路是通的）
    add('gateway', await timed(async () => {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
      return `HTTP ${res.status} @ ${base}`;
    }), `网关不可达（${base}）：检查网络/WB_GATEWAY_URL；gateway 服务状态找 MM 端确认（ai-proxy CloudRun）`);

    // 4. 核心表读权限（逐表 SELECT id LIMIT 1；401/403 归因认证，其余归因权限）
    add('tables', await timed(async () => {
      const bad = [];
      for (const t of TABLES) {
        try { await api('GET', `${t}?select=id&limit=1`); }
        catch (e) {
          const m = String(e.message).match(/→\s*(\d{3}):\s/);
          const st = m ? Number(m[1]) : 0;
          bad.push(st === 401 || st === 403 ? `${t}(认证拒绝${st})` : `${t}(${st || e.message.slice(0, 40)})`);
        }
      }
      if (bad.length) throw new Error(`读探测失败：${bad.join('/')}`);
      return `${TABLES.join('/')} 读 OK（写权限不实测，以 MM 端 profile 配置为准）`;
    }), '表读权限异常：401/403 先重签 key；仍失败找 MM 核对该 key 的表权限 profile（action_logs 有审计）');

    // 5. 版本（APP_VERSION 优先——与工作台发布版本号一致；回落 package.json）
    add('version', await timed(async () => {
      let ver = '';
      const vt = resolve(REPO_ROOT, 'lib', 'version.ts');
      if (existsSync(vt)) {
        ver = (readFileSync(vt, 'utf8').match(/APP_VERSION\s*=\s*'([^']+)'/) || [])[1] || '';
      }
      if (!ver) ver = `v${JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')).version}`;
      let git = '';
      try { git = ` @ ${execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT }).toString().trim()}`; } catch { /* 非 git 环境忽略 */ }
      return `wb-cli ${ver}${git}（gateway=${GATEWAY_BASE}）`;
    }), null);

    const result = { checks, issues, next_actions: nexts, version: checks.find((c) => c.name === 'version')?.detail || '' };
    ctx.output(result, () => {
      console.log(`wb-cli doctor · 环境自检（profile=${auth.profile}）\n`);
      for (const c of checks) console.log(`  ${c.ok ? '✅' : '❌'} ${c.name.padEnd(8)} ${c.detail}${c.ms ? `  ${c.ms}ms` : ''}`);
      if (issues.length) {
        console.log('\n  issues:');
        for (const i of issues) console.log(`   · [${i.check}] ${i.detail}`);
        console.log('\n  next_actions:');
        nexts.forEach((n, i) => console.log(`   ${i + 1}. ${n}`));
      } else {
        console.log('\n  ✅ 全部通过，无 issues');
      }
    });
  }
}

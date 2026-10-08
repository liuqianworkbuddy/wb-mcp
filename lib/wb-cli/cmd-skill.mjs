/**
 * wb-cli · 技能商店命令（2026-09-27 · mm-workbuddy-skill-store）
 * ------------------------------------------------------------
 * skill list                          列出商店内全部技能（skills 表）
 * skill show <name>                   查看技能详情（含 SKILL.md 全文与下载直链）
 * skill install <name> [--dir 目标]   下载 zip → sha256 校验 → 解压到 ~/.workbuddy/skills/<name>/
 * skill publish <目录> [--name ...]   把本地 skill 目录打 zip 上传入库（上架/更新）
 *
 * 元数据：PostgREST skills 表（经 ai-proxy /v1/rest，wbk_ key 鉴权）；
 * 包体：POST /v1/storage/upload?bucket=canvas-assets&key=skill-packages/...，
 * 公网下载直链 https://api.liflow.cn/storage/canvas-assets/<key>。
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeApi } from '../wb-auth.mjs';

const MAX_BYTES = 50 * 1024 * 1024;

function apiOrigin(base) {
  return String(base || '').replace(/\/v1\/rest$/, '').replace(/\/+$/, '');
}

async function errorMessage(res) {
  const text = await res.text().catch(() => '');
  try {
    const data = JSON.parse(text);
    return data.message || data.error || text.slice(0, 200) || `HTTP ${res.status}`;
  } catch {
    return text.slice(0, 200) || `HTTP ${res.status}`;
  }
}

function restGet(base, auth, path) {
  return fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${auth.key}` },
    signal: AbortSignal.timeout(30000),
  });
}

async function restSend(base, auth, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${auth.key}`,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=representation',
    },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  return res;
}

/** 解析 SKILL.md frontmatter 的 name/description/version */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) out[kv[1].trim()] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

async function writeGuard(ctx, label, flags) {
  (flags.json ? console.error : console.log)(`将执行 · ${label}`);
  if (flags.yes) return true;
  if (process.stdin.isTTY) {
    const ok = await ctx.confirm('确认执行？');
    if (!ok) {
      console.log('已取消（加 --yes 跳过确认）');
      return false;
    }
    return true;
  }
  console.error('非 TTY 环境写操作需 --yes');
  process.exitCode = 2;
  return false;
}

/** 递归收集 skill 目录文件清单（相对路径 + 字节数，跳过 .git/__pycache__ 等） */
function collectFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...collectFiles(full, rel));
    else out.push({ path: rel, size: statSync(full).size });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function fetchSkillRow(base, auth, name) {
  const res = await restGet(base, auth, `/skills?name=eq.${encodeURIComponent(name)}&select=*`);
  if (!res.ok) throw new Error(await errorMessage(res));
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export function register(registry, ctx) {
  registry.register('skill', {
    summary: '技能商店（list/show/install/publish）',
    lines: [
      '  skill list [--tag 标签] [--json]             商店技能清单（名称/用途/版本/标签/安装量）',
      '  skill show <name> [--json]                   技能详情（SKILL.md 全文、文件清单、下载直链）',
      '  skill install <name> [--dir 目标目录] [--yes] 下载 zip→sha256 校验→解压安装到本机',
      '  skill publish <skill目录> [--name] [--title] [--desc] [--ver] [--tags a,b] [--yes]',
      '                                               上架/更新：短标题+3句以上说明→zip→存储→skills 表',
    ],
    handler: cmdSkill,
    domain: 'skill',
    write: true,
    confirmNeed: true,
    params: [{ name: 'cmd', type: 'string', required: true, positional: true, desc: 'list|show|install|publish' }],
    resultFields: ['name', 'version', 'url', 'dir', 'action'],
  });

  async function cmdSkill(flags, pos) {
    const sub = pos[0];
    const { auth, base } = makeApi({ profile: process.env.WB_PROFILE });
    if (auth.mode !== 'gateway') {
      throw new Error('技能商店需要 WB_API_KEY（wbk_ 前缀）。请在 ~/.workbuddy/agents/<profile>.env 配置后重试');
    }

    /* ---------------- list ---------------- */
    if (sub === 'list') {
      const tag = flags.tag;
      let path = '/skills?select=name,display_name,description,version,tags,author,downloads,installs,updated_at&order=updated_at.desc&limit=100';
      if (tag) path += `&tags=cs.{${encodeURIComponent(tag)}}`;
      const res = await restGet(base, auth, path);
      if (!res.ok) throw new Error(await errorMessage(res));
      const rows = await res.json().catch(() => []);
      const result = { count: rows.length, skills: rows };
      ctx.output(result, () => {
        console.log(`技能商店共 ${rows.length} 个技能：`);
        for (const s of rows) {
          console.log(`  ${s.name}  v${s.version}  ⬇${s.downloads ?? 0} ⚙${s.installs ?? 0}`);
          if (s.display_name && s.display_name !== s.name) console.log(`    标题: ${s.display_name}`);
          console.log(`    ${String(s.description || '').slice(0, 72)}`);
          if (Array.isArray(s.tags) && s.tags.length) console.log(`    标签: ${s.tags.join(', ')}`);
        }
      });
      return;
    }

    /* ---------------- show ---------------- */
    if (sub === 'show') {
      const name = pos[1];
      if (!name) throw new Error('用法：skill show <name>');
      const row = await fetchSkillRow(base, auth, name);
      if (!row) throw new Error(`技能不存在：${name}（skill list 查看）`);
      ctx.output(row, () => {
        console.log(`📦 ${row.display_name || row.name}  v${row.version}  by ${row.author}`);
        console.log(`   ${row.description || ''}`);
        console.log(`   下载：${row.package_url || '（未上架包体）'}`);
        console.log(`   安装：wb-cli skill install ${row.name}`);
        console.log(`   文件 ${Array.isArray(row.files) ? row.files.length : 0} 个：`);
        for (const f of Array.isArray(row.files) ? row.files : []) console.log(`     - ${f.path} (${f.size}B)`);
        console.log('──────────── SKILL.md ────────────');
        console.log(String(row.readme || ''));
      });
      return;
    }

    /* ---------------- install ---------------- */
    if (sub === 'install') {
      const name = pos[1];
      if (!name) throw new Error('用法：skill install <name> [--dir 目标目录]');
      const targetRoot = resolve(flags.dir || join(homedir(), '.workbuddy', 'skills'));
      const row = await fetchSkillRow(base, auth, name);
      if (!row) throw new Error(`技能不存在：${name}（skill list 查看）`);
      if (!row.package_url || !row.package_sha256) throw new Error(`技能「${name}」没有可用包体（未上架或数据不全）`);
      if (!(await writeGuard(ctx, `安装技能「${row.display_name || row.name}」v${row.version} 到 ${targetRoot}`, flags))) return;

      const res = await fetch(row.package_url, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`包体下载失败：HTTP ${res.status}（${row.package_url}）`);
      const buf = Buffer.from(await res.arrayBuffer());
      const sha = createHash('sha256').update(buf).digest('hex');
      if (row.package_sha256 && sha !== row.package_sha256) {
        throw new Error(`sha256 校验失败：期望 ${row.package_sha256}，实际 ${sha}。已中止安装`);
      }
      if (buf.length > MAX_BYTES) throw new Error(`包体超出 50MB 上限`);

      const skillDir = join(targetRoot, row.name);
      mkdirSync(targetRoot, { recursive: true });
      if (existsSync(skillDir)) {
        const bak = `${skillDir}.bak-${Date.now()}`;
        renameSync(skillDir, bak);
        console.log(`  旧版本已备份：${bak}`);
      }
      mkdirSync(skillDir, { recursive: true });
      const tmpZip = join(tmpdir(), `wbskill-${row.name}-${Date.now()}.zip`);
      try {
        writeFileSync(tmpZip, buf);
        // ditto（macOS 自带）解 zip 到目标目录；失败回退 unzip
        try {
          execFileSync('/usr/bin/ditto', ['-x', '-k', tmpZip, skillDir]);
        } catch {
          execFileSync('/usr/bin/unzip', ['-o', '-q', '-x', '__MACOSX/*', tmpZip, '-d', skillDir]);
        }
      } catch (e) {
        throw new Error(`解压失败：${e.message}`);
      } finally {
        rmSync(tmpZip, { force: true });
        rmSync(join(tmpdir(), `wbskill-${row.name}-`), { recursive: true, force: true });
      }
      if (!existsSync(join(skillDir, 'SKILL.md'))) throw new Error(`安装后未找到 SKILL.md，已中止（检查包结构）`);

      // 安装计数 +1（读改写，失败不阻断）
      try {
        const next = (Number(row.installs) || 0) + 1;
        await restSend(base, auth, 'PATCH', `/skills?name=eq.${encodeURIComponent(name)}`, { installs: next, updated_at: new Date().toISOString() });
      } catch { /* 计数失败不阻断 */ }

      const result = { action: 'install', name: row.name, version: row.version, dir: skillDir, url: row.package_url };
      ctx.output(result, () => {
        console.log('技能安装成功');
        console.log(`  名称：${row.name}（v${row.version}）`);
        console.log(`  位置：${skillDir}`);
        console.log(`  重启会话后即可被 agent 加载`);
      });
      return;
    }

    /* ---------------- publish ---------------- */
    if (sub === 'publish') {
      const dir = resolve(pos[1] || '');
      if (!dir || !existsSync(dir)) throw new Error('用法：skill publish <skill目录> [--name xxx] [--title xxx] [--desc xxx]');
      const skillMd = join(dir, 'SKILL.md');
      if (!existsSync(skillMd)) throw new Error('目标目录缺少 SKILL.md，不是有效的 skill 目录');
      const fm = parseFrontmatter(readFileSync(skillMd, 'utf-8'));
      const name = flags.name || fm.name || basename(dir);
      if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(name)) {
        throw new Error(`技能名不合法：${name}（需小写字母/数字/连字符，≤40 字符）`);
      }
      const displayName = String(flags.title || fm.display_name || fm.title || '').trim();
      if (!displayName) {
        throw new Error('技能标题不能为空：请在 SKILL.md frontmatter 写 display_name/title，或传 --title');
      }
      if (Array.from(displayName).length > 16) {
        throw new Error(`技能标题过长：${displayName}（请控制在十来个字、最多 16 字符）`);
      }
      const description = flags.desc || fm.description || '';
      const sentenceCount = String(description)
        .split(/(?<=[。！？!?])\s*/)
        .map((item) => item.trim())
        .filter(Boolean).length;
      if (sentenceCount < 3) {
        throw new Error('技能描述至少写 3 句话：先说做什么，再说怎么用，最后说适用场景或输出');
      }
      const version = flags.ver || fm.version || '0.1.0';
      const tags = String(flags.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
      if (!(await writeGuard(ctx, `上架或更新技能「${name}」v${version}`, flags))) return;

      // ① 打 zip（SKILL.md 位于 zip 根）
      const files = collectFiles(dir);
      const zipPath = `/tmp/wbskill-${name}-${Date.now()}.zip`;
      execFileSync('/usr/bin/zip', ['-r', '-X', '-q', zipPath, '.'], { cwd: dir });
      const buf = readFileSync(zipPath);
      const sha = createHash('sha256').update(buf).digest('hex');
      if (buf.length > MAX_BYTES) throw new Error(`zip 超出 50MB 上限：${buf.length} 字节`);

      // ② 传存储（canvas-assets/skill-packages/）
      const { auth: a2, base: b2 } = makeApi({ profile: process.env.WB_PROFILE });
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const key = `skill-packages/${day}/${Date.now()}-${randomBytes(6).toString('hex')}.zip`;
      const upRes = await fetch(`${apiOrigin(b2)}/v1/storage/upload?bucket=canvas-assets&key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${a2.key}` },
        body: new Uint8Array(buf),
        signal: AbortSignal.timeout(115000),
      });
      if (!upRes.ok) throw new Error(`存储上传失败：${await errorMessage(upRes)}`);
      const upData = await upRes.json().catch(() => null);
      if (!upData || upData.ok === false || !upData.url) throw new Error('存储上传成功但返回数据异常');
      const packageUrl = upData.url;

      // ③ 写 skills 表（存在则 PATCH 更新，否则 POST 新增）
      const existing = await fetchSkillRow(b2, a2, name);
      const payload = {
        name,
        display_name: displayName,
        description,
        readme: readFileSync(skillMd, 'utf-8'),
        version,
        tags,
        author: 'WorkBuddy',
        files,
        package_key: key,
        package_url: packageUrl,
        package_size: buf.length,
        package_sha256: sha,
        updated_at: new Date().toISOString(),
      };
      let row;
      if (existing) {
        const res = await restSend(b2, a2, 'PATCH', `/skills?name=eq.${encodeURIComponent(name)}`, payload);
        if (!res.ok) throw new Error(`元数据更新失败：${await errorMessage(res)}`);
        row = (await res.json().catch(() => [null]))?.[0] || null;
      } else {
        const res = await restSend(b2, a2, 'POST', '/skills', payload);
        if (!res.ok) throw new Error(`元数据写入失败：${await errorMessage(res)}`);
        row = (await res.json().catch(() => [null]))?.[0] || null;
      }

      const result = { action: existing ? 'update' : 'publish', name, version, url: packageUrl, key, sha256: sha, files: files.length };
      ctx.output(result, () => {
        console.log(`技能${existing ? '更新' : '上架'}成功`);
        console.log(`  名称：${name}（v${version}，${files.length} 个文件，zip ${buf.length} 字节）`);
        console.log(`  标题：${displayName}`);
        console.log(`  下载：${packageUrl}`);
        console.log(`  安装：wb-cli skill install ${name}`);
      });
      return;
    }

    throw new Error('用法：skill list | skill show <name> | skill install <name> | skill publish <目录>');
  }
}

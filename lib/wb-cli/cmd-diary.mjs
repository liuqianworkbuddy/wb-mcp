/**
 * wb-cli · diary 日记命令族（dt_yutubs P5）
 * ------------------------------------------------------------
 * 目标表：diaries。正文为轻量 Markdown，entry_date 由 00:00-04:59 归前一天规则生成。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { normalizeTag, parseHashtags } from './table-maps.mjs';
import { calcEntryDate, markdownToPlainText } from '../records-core.mjs';
import { makeApiList, resolveLongInput } from './shared.mjs';
import { idempotencyLookup, idempotencySave } from './idempotency.mjs';

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[k] = next; i++; }
      else flags[k] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

async function confirm(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(`${message} [y/N] `, (a) => {
    rl.close();
    r(/^y(es)?$/i.test(a.trim()));
  }));
}

async function writeGuard(label, flags) {
  (flags.json ? console.error : console.log)(`将执行 · ${label}`);
  if (flags.yes) return true;
  if (process.stdin.isTTY) return confirm('确认执行？');
  console.log('非 TTY 环境写操作需 --yes');
  process.exitCode = 2;
  return false;
}

let ctxOutput = null;
function out(flags, data, human) {
  if (flags.json && ctxOutput) ctxOutput(data, human);
  else if (flags.json) console.log(JSON.stringify(data, null, 2));
  else if (human) human();
}

function titleFromContent(content) {
  const firstLine = String(content || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  return firstLine.slice(0, 30);
}

async function findByIdPrefix(api, table, prefix, select = '*') {
  const rows = await api('GET', `${table}?select=${select}&order=created_at.desc&limit=1000`);
  const list = Array.isArray(rows) ? rows : [];
  const hit = list.filter((r) => String(r.id).startsWith(String(prefix)));
  if (!hit.length) throw new Error(`${table} 中未找到 id 前缀 ${prefix}`);
  if (hit.length > 1) throw new Error(`id 前缀 ${prefix} 命中 ${hit.length} 行，请补齐`);
  return hit[0];
}

async function diaryAdd(ctx, flags, pos) {
  const key = flags['idempotency-key'];
  if (key) {
    const hit = ctx.idempotencyLookup ? ctx.idempotencyLookup(key) : idempotencyLookup(key);
    if (hit) {
      out(flags, { ...hit, deduped: true }, () => console.log(`幂等命中（key=${key}），返回首次日记 id=${hit.id}`));
      return;
    }
  }
  const { text: raw } = resolveLongInput(flags, pos, { label: 'diary 正文' });
  if (!raw) {
    console.error('用法: diary add "<日记正文>" [--content-file md] [--stdin] [--yes] [--idempotency-key key]');
    process.exitCode = 1;
    return;
  }
  const createdAt = new Date().toISOString();
  const row = {
    content_md: raw,
    plain_text: markdownToPlainText(raw),
    title: titleFromContent(raw),
    entry_date: calcEntryDate(createdAt),
    category: '日记',
    tags: parseHashtags(raw),
    source: 'wb-cli',
    created_at: createdAt,
  };
  const echo = (l) => (flags.json ? console.error : console.log)(l);
  echo('将写入 · 日记（diaries · content_md + entry_date）');
  echo(`  → 归属日期：${row.entry_date}`);
  echo(`  → 标题：${row.title || '(空)'}`);
  echo(`  → 正文：${raw.length} 字`);
  if (!(await writeGuard(`新增日记「${row.title || raw.slice(0, 20)}」`, flags))) return;
  const [created] = await ctx.api('POST', 'diaries', row);
  await ctx.logCli('diary_add', 'diary', created.id, { title: row.title, content: raw, type: '日记新增', table: 'diaries' });
  out(flags, { diary: created }, () => {
    console.log('已写入 · 日记（diaries）');
    console.log(`   [diaries] ${created.title || '(无标题)'}  id=${created.id}  entry_date=${created.entry_date}`);
  });
  if (key) idempotencySave(key, { ok: true, cmd: 'diary add', id: created.id });
}

async function diaryList(ctx, flags) {
  let extra = '';
  if (typeof flags.tag === 'string' && flags.tag.trim()) extra += `&tags=cs.{${encodeURIComponent(normalizeTag(flags.tag))}}`;
  if (typeof flags.date === 'string' && flags.date) extra += `&entry_date=eq.${flags.date}`;
  const list = await ctx.apiList('diaries', {
    limit: flags.limit != null ? Number(flags.limit) : 20,
    cursor: typeof flags.cursor === 'string' && flags.cursor ? flags.cursor : null,
    all: !!flags.all,
    fields: typeof flags.fields === 'string' && flags.fields ? flags.fields : 'id,title,content_md,tags,entry_date,created_at',
    order: 'entry_date.desc,created_at.desc,id',
    extra,
  });
  out(flags, list, () => {
    if (!list.data.length) {
      console.log(typeof flags.tag === 'string' && flags.tag ? `无带 #${normalizeTag(flags.tag)} 标签的日记` : '无日记');
      return;
    }
    console.log(`日记共 ${list.total} 条（本页 ${list.data.length}${list.has_more ? '，--cursor 续取' : ''}）：`);
    for (const d of list.data) {
      const tags = (d.tags || []).length ? `  #${d.tags.join(' #')}` : '';
      console.log(`${d.entry_date}  ${(d.title || '(无标题)').slice(0, 40)}${tags}`);
      console.log(`   id=${d.id}`);
    }
  });
}

async function diaryShow(ctx, flags, pos) {
  const id = pos[0];
  if (!id) { console.error('用法: diary show <id前缀>'); process.exitCode = 1; return; }
  const row = await findByIdPrefix(ctx.api, 'diaries', id, 'id,title,content_md,tags,entry_date,source,created_at,updated_at');
  out(flags, { diary: row }, () => {
    console.log(`${row.entry_date} ${row.title || '(无标题)'}`);
    console.log(`   tags: ${(row.tags || []).map((t) => `#${t}`).join(' ') || '(无)'}  source=${row.source || '-'}`);
    console.log(`   id=${row.id}`);
    console.log('─'.repeat(40));
    console.log(row.content_md || '(空)');
  });
}

async function diarySearch(ctx, flags, pos) {
  const kw = pos.join(' ').trim();
  if (!kw && !flags.tag && !flags.since && !flags.until) {
    console.error('用法: diary search [关键词] [--tag 标签] [--since YYYY-MM-DD] [--until YYYY-MM-DD]');
    process.exitCode = 1;
    return;
  }
  let q = 'diaries?select=id,title,content_md,plain_text,tags,entry_date,created_at&order=entry_date.desc,created_at.desc&limit=50';
  if (kw) q += `&or=(plain_text.ilike.*${encodeURIComponent(kw)}*,content_md.ilike.*${encodeURIComponent(kw)}*,title.ilike.*${encodeURIComponent(kw)}*)`;
  if (typeof flags.since === 'string') q += `&entry_date=gte.${flags.since}`;
  if (typeof flags.until === 'string') q += `&entry_date=lt.${flags.until}`;
  let rows = await ctx.api('GET', q);
  if (typeof flags.tag === 'string' && flags.tag.trim()) {
    const t = normalizeTag(flags.tag);
    rows = rows.filter((r) => (r.tags || []).includes(t));
  }
  out(flags, { keyword: kw || null, count: rows.length, diaries: rows }, () => {
    if (!rows.length) { console.log('无命中'); return; }
    console.log(`日记检索命中 ${rows.length} 条：`);
    for (const d of rows) console.log(`${d.entry_date} ${(d.title || '(无标题)').slice(0, 40)}  id=${d.id}`);
  });
}

async function diaryEdit(ctx, flags, pos) {
  const id = pos[0];
  const hasFile = typeof flags.file === 'string';
  const hasTitle = typeof flags.title === 'string';
  if (!id || (!hasFile && !hasTitle)) {
    console.error('用法: diary edit <id前缀> --file <md文件> | --title "新标题" [--yes]');
    process.exitCode = 1;
    return;
  }
  const row = await findByIdPrefix(ctx.api, 'diaries', id, 'id,title,content_md,tags');
  const patch = {};
  if (hasFile) {
    const abs = pathResolve(String(flags.file).replace(/^~(?=\/|$)/, homedir()));
    if (!existsSync(abs)) { console.error(`文件不存在：${abs}`); process.exitCode = 1; return; }
    const content = readFileSync(abs, 'utf8');
    patch.content_md = content;
    patch.plain_text = markdownToPlainText(content);
    patch.tags = parseHashtags(content);
    patch.title = titleFromContent(content);
  }
  if (hasTitle) patch.title = String(flags.title).trim().slice(0, 120);
  const changes = Object.keys(patch);
  if (!(await writeGuard(`日记编辑「${row.title || '(无标题)'}」：${changes.join('、') || '无变更'}`, flags))) return;
  const [updated] = await ctx.api('PATCH', `diaries?id=eq.${encodeURIComponent(row.id)}&select=id,title,content_md,tags,entry_date`, patch);
  await ctx.logCli('diary_edit', 'diary', row.id, { title: updated.title || row.title, content: patch.content_md || `变更：${changes.join('，')}`, type: '日记编辑', table: 'diaries' });
  out(flags, { diary: updated }, () => console.log(`已修改日记「${updated.title || '(无标题)'}」（id=${updated.id}）`));
}

async function diaryTag(ctx, flags, pos) {
  const id = pos[0];
  if (!id || (!flags.add && !flags.del)) {
    console.error('用法: diary tag <id前缀> --add 标签1[,标签2] | --del 标签1[,标签2] [--yes]');
    process.exitCode = 1;
    return;
  }
  const row = await findByIdPrefix(ctx.api, 'diaries', id, 'id,title,tags');
  const cur = [...(row.tags || [])];
  let next = [...cur];
  if (typeof flags.add === 'string') for (const t of flags.add.split(/[,，]/).map(normalizeTag).filter(Boolean)) if (!next.includes(t)) next.push(t);
  if (typeof flags.del === 'string') {
    const rm = flags.del.split(/[,，]/).map(normalizeTag).filter(Boolean);
    next = next.filter((t) => !rm.includes(t));
  }
  if (!(await writeGuard(`日记标签「${row.title || '(无标题)'}」：[${cur.join('、')}] → [${next.join('、')}]`, flags))) return;
  const [updated] = await ctx.api('PATCH', `diaries?id=eq.${encodeURIComponent(row.id)}&select=id,title,tags`, { tags: next });
  await ctx.logCli('diary_tag', 'diary', row.id, { title: row.title, content: `标签：[${cur.join('、')}] → [${next.join('、')}]`, type: '日记标签', table: 'diaries' });
  out(flags, { updated }, () => console.log(`标签已更新：[${(updated.tags || []).join('、')}]（id=${updated.id}）`));
}

export const command = 'diary';
export const summary = '日记命令族（diaries 表：add/list/show/search/edit/tag）';
export const usage = [
  '  diary add "<正文>" [--content-file md] [--yes]   写日记（自动计算 entry_date）',
  '  diary list [--limit 20] [--tag 标签] [--date YYYY-MM-DD]',
  '  diary show <id前缀>',
  '  diary search <关键词> [--tag 标签] [--since 日期] [--until 日期]',
  '  diary edit <id前缀> --file <md> | --title "新标题" [--yes]',
  '  diary tag <id前缀> --add a,b | --del a,b [--yes]',
];

export async function run(flags, pos, ctx = {}) {
  ctxOutput = ctx.output || null;
  if (!ctx.api) {
    const { makeApi } = await import('../wb-auth.mjs');
    const { auth, base, api } = makeApi({ profile: process.env.WB_PROFILE });
    ctx = { api, apiList: makeApiList({ base, auth }), logCli: () => {} };
  }
  const sub = pos[0] || 'list';
  const rest = pos.slice(1);
  if (sub === 'add') return diaryAdd(ctx, flags, rest);
  if (sub === 'list') return diaryList(ctx, flags);
  if (sub === 'show') return diaryShow(ctx, flags, rest);
  if (sub === 'search') return diarySearch(ctx, flags, rest);
  if (sub === 'edit') return diaryEdit(ctx, flags, rest);
  if (sub === 'tag') return diaryTag(ctx, flags, rest);
  console.error(`未知子命令：${sub}（支持 add/list/show/search/edit/tag）`);
  process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  run(flags, pos, {}).catch((e) => { console.error(e.message); process.exitCode = 1; });
}

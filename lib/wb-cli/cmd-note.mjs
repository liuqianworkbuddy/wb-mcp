/**
 * wb-cli · note 笔记命令族（C 段 · 开发任务 dt_dod7ui）
 * ------------------------------------------------------------
 * 域语义：capsules 表中 category='笔记' AND is_refined=true 的行
 * （与前端 /notes/ 笔记域同口径；is_refined 为空闲列复用标记）
 *
 * 接口约定（A 段注册器架构，wb-cli.mjs 动态发现 cmd-*.mjs 挂载）：
 *   export const command = 'note'          // 命令名
 *   export const usage    = [ ... ]        // usage 聚合行
 *   export async function run(flags, pos, ctx)
 *     ctx: { api, logCli }（A 段注入统一通道；缺省时本模块自兜底
 *           经 lib/wb-auth.mjs makeApi 构建，保证注册器落地前可独立验证）
 *
 * 依赖（只读，不改其他段文件）：
 *   - parseHashtags / normalizeTag ← 同目录 table-maps.mjs
 *   - findByIdPrefix：本模块自实现（uuid 前缀本地匹配，口径同主文件）
 *
 * 列名陷阱（capsules）：分类列是 category（非 category_l1 等）；
 * 排序键 created_at；tags 为 text[] 且存储不带 # 前缀（2026-09-04 探活确认）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { parseHashtags, normalizeTag } from './table-maps.mjs';

/** 笔记域过滤串（category='笔记' AND is_refined=true；中文需 URL 编码） */
import { resolveLongInput } from './shared.mjs';
import { idempotencyLookup, idempotencySave } from './idempotency.mjs';

const NOTE_DOMAIN = `category=eq.${encodeURIComponent('笔记')}&is_refined=eq.true`;

/** 标题截断长度（FR1：首行截 20 字，口径同前端降级命名） */
const TITLE_MAX = 20;

/* ============================================================
 * 基础工具（ctx 未注入时自兜底；签名与主文件同构）
 * ============================================================ */

/** 解析 argv：flags（--key value / --key）+ 位置参数（口径同主文件 parseArgs） */
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

/** 交互确认（--yes 跳过；非 TTY 由 writeGuard 拦截，这里只管 TTY 问答） */
async function confirm(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => {
    rl.question(`${message} [y/N] `, (a) => {
      rl.close();
      r(/^y(es)?$/i.test(a.trim()));
    });
  });
}

/** 统一输出：--json 机器可读，否则走人类可读渲染。
 *  C段 FR-7：--json 委托主出口层（envelope {success,data,error}）——
 *  ctx.output 未注入时（独立运行调试通道）保留裸 stringify 兜底。 */
let _ctxOutput = null;
function out(flags, data, human) {
  if (flags.json && _ctxOutput) _ctxOutput(data, human);
  else if (flags.json) console.log(JSON.stringify(data, null, 2));
  else if (human) human();
}

/** 写操作安全门：回显 + 确认 + --yes；非 TTY 需 --yes（口径同主文件 writeGuard） */
async function writeGuard(label, flags) {
  // 🔴 --json 时回显走 stderr（stdout 只留数据，防 wb-mcp 误判重试导致双写）；
  // 本模块独立运行（无 ctx.output）时 FLAGS.json 等价 flags.json。
  (flags.json ? console.error : console.log)(`将执行 · ${label}`);
  if (flags.yes) return true;
  if (process.stdin.isTTY) {
    const ok = await confirm('确认执行？');
    if (!ok) { console.log('已取消（加 --yes 跳过确认）'); return false; }
    return true;
  }
  console.log('⛔ 非 TTY 环境写操作需 --yes');
  process.exitCode = 2;
  return false;
}

/** logCli 兜底实现（口径同主文件：action_logs，source=wb-cli，截断，失败不阻断） */
async function logCliFallback(api, action, module, targetId, detail) {
  try {
    const TITLE_MAX_LOG = 120;
    const CONTENT_MAX_LOG = 4000;
    const d = { source: 'wb-cli', ...detail };
    if (typeof d.title === 'string' && d.title.length > TITLE_MAX_LOG) d.title = d.title.slice(0, TITLE_MAX_LOG);
    if (typeof d.content === 'string' && d.content.length > CONTENT_MAX_LOG) d.content = d.content.slice(0, CONTENT_MAX_LOG) + '…(截断)';
    await api('POST', 'action_logs', {
      actor: 'liuqian',
      module,
      action,
      target_id: targetId || null,
      detail: d,
    });
  } catch (e) {
    console.error(`ℹ️ [action-log] CLI 日志写入跳过：${String(e.message || e).slice(0, 120)}`);
  }
}

/** 用 id 前缀取行（全 id 或前缀唯一命中；多命中/零命中报错）。
 *  uuid 列不支持 like，拉 id 列表本地前缀匹配——口径同主文件 findByIdPrefix。 */
async function findByIdPrefix(api, table, idPrefix, select = '*') {
  const p = String(idPrefix).trim();
  const idRows = await api('GET', `${table}?select=id&limit=5000`);
  const hits = idRows.filter((r) => r.id === p || String(r.id).startsWith(p));
  if (!hits.length) throw new Error(`${table} 无 id 前缀为 ${p} 的行`);
  if (hits.length > 1) throw new Error(`id 前缀 ${p} 命中 ${hits.length} 行，请加长前缀`);
  const [row] = await api('GET', `${table}?select=${select}&id=eq.${encodeURIComponent(hits[0].id)}`);
  return row;
}

/** 首个非空行截 20 字作标题（FR1 title 口径） */
function titleFromContent(content) {
  const firstLine = String(content || '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) || '';
  return firstLine.slice(0, TITLE_MAX);
}

/** 展开 ~ 的路径解析 */
function expandPath(p) {
  return pathResolve(String(p).replace(/^~(?=\/|$)/, homedir()));
}

/* ============================================================
 * 子命令实现
 * ============================================================ */

/** note add "<内容>"：category='笔记'+is_refined=true，#tag 解析，回显确认。
 *  P1 FR-2 幂等（--idempotency-key 同 key 返回首次 id）+ FR-3 长输入（--content-file/--stdin）。 */
async function noteAdd(ctx, flags, pos) {
  if (flags['idempotency-key']) {
    const hit = ctx.idempotencyLookup ? ctx.idempotencyLookup(flags['idempotency-key']) : idempotencyLookup(flags['idempotency-key']);
    if (hit) {
      out(flags, { ...hit, deduped: true }, () => console.log(`♻️ 幂等命中（key=${flags['idempotency-key']}），返回首次笔记 id=${hit.id}，未重复入库`));
      return;
    }
  }
  const long = resolveLongInput(flags, pos, { label: 'note 正文' });
  const raw = long.text;
  if (!raw) {
    console.error('用法: note add "<内容>" [--yes] [--content-file <md>] [--stdin] [--idempotency-key key]（#标签 自动解析入 tags）');
    process.exitCode = 1;
    return;
  }
  const tags = parseHashtags(raw);
  const title = titleFromContent(raw);
  const row = {
    content: raw,
    title,
    category: '笔记',
    is_refined: true,
    tags,
    source: 'wb-cli',
  };

  // 🔴 --json 时回显走 stderr（stdout 只留数据，防 wb-mcp 误判重试导致双写）
  const echo = (l) => (flags.json ? console.error : console.log)(l);
  echo('将写入 · 笔记（capsules · category=笔记 · is_refined=true）');
  echo(`  → 标题：${title || '(空)'}`);
  echo(`  → 标签：${tags.length ? tags.map((t) => `#${t}`).join(' ') : '(无)'}`);
  echo(`  → 正文：${raw.length} 字`);
  if (!(await writeGuard(`新增笔记「${title || raw.slice(0, 20)}」`, flags))) return;

  const [created] = await ctx.api('POST', 'capsules', row);
  await ctx.logCli('note_add', 'capsule', String(created.id),
    { title: row.title, content: raw, type: '笔记新增', table: 'capsules' });

  out(flags, { note: created }, () => {
    console.log(`✅ 已写入 · 笔记（capsules）`);
    console.log(`   [capsules] ${created.title || '(无标题)'}  id=${created.id}`);
    console.log(`   /notes/ 前端列表已可见（is_refined=true）`);
  });
  // P1 FR-2 幂等 save：落库成功记首次 id（同 key 重试直接返回）
  if (flags['idempotency-key']) idempotencySave(flags['idempotency-key'], { ok: true, cmd: 'note add', id: created.id });
}

/** note list [--limit 20] [--tag]：笔记域倒序；C段 FR-7 游标分页（--tag 服务器端 cs 过滤） */
async function noteList(ctx, flags) {
  let extra = `&${NOTE_DOMAIN}`;
  if (typeof flags.tag === 'string' && flags.tag.trim()) {
    extra += `&tags=cs.{${encodeURIComponent(normalizeTag(flags.tag))}}`;
  }
  const list = await ctx.apiList('capsules', {
    limit: flags.limit != null ? Number(flags.limit) : 20,
    cursor: typeof flags.cursor === 'string' && flags.cursor ? flags.cursor : null,
    all: !!flags.all,
    fields: typeof flags.fields === 'string' && flags.fields ? flags.fields : 'id,title,content,tags,category,created_at',
    order: 'created_at.desc,id',
    extra,
  });
  const notes = list.data;
  out(flags, list, () => {
    if (!notes.length) {
      console.log(typeof flags.tag === 'string' && flags.tag ? `（无带 #${normalizeTag(flags.tag)} 标签的笔记）` : '（无笔记）');
      return;
    }
    console.log(`笔记共 ${list.total} 条（本页 ${notes.length}${list.has_more ? '，--cursor 续取' : ''}）：\n`);
    for (const n of notes) {
      const tags = Array.isArray(n.tags) && n.tags.length ? `  #${n.tags.join(' #')}` : '';
      console.log(`📝 ${(n.title || '(无标题)').slice(0, 40)}  ${String(n.created_at).slice(0, 10)}${tags}`);
      console.log(`   id=${n.id}`);
    }
  });
}

/** note show <id前缀>：全文输出（越域行提示不阻断） */
async function noteShow(ctx, flags, pos) {
  const id = pos[0];
  if (!id) { console.error('用法: note show <id前缀>'); process.exitCode = 1; return; }
  const row = await findByIdPrefix(ctx.api, 'capsules', id, 'id,title,content,category,tags,is_refined,source,created_at,updated_at');
  out(flags, { note: row }, () => {
    const offDomain = row.category !== '笔记' || !row.is_refined;
    if (offDomain) console.log(`⚠️ 该行不在笔记域（category=${row.category}，is_refined=${row.is_refined}），仅展示不代表笔记列表内容\n`);
    console.log(`📝 ${row.title || '(无标题)'}`);
    const tags = Array.isArray(row.tags) && row.tags.length ? `#${row.tags.join(' #')}` : '(无)';
    console.log(`   ${String(row.created_at).slice(0, 10)} · category=${row.category} · tags: ${tags} · source=${row.source || '-'}`);
    console.log(`   id=${row.id}`);
    console.log('─'.repeat(40));
    console.log(row.content || '(空)');
  });
}

/** note search <关键词> [--tag] [--since] [--until]：content/title ilike + 日期范围 */
async function noteSearch(ctx, flags, pos) {
  const kw = pos.join(' ').trim();
  if (!kw && !flags.tag && !flags.since && !flags.until) {
    console.error('用法: note search [关键词] [--tag 标签] [--since YYYY-MM-DD] [--until YYYY-MM-DD]');
    process.exitCode = 1;
    return;
  }
  let q = `capsules?select=id,title,content,tags,category,created_at&${NOTE_DOMAIN}&order=created_at.desc&limit=50`;
  if (kw) q += `&or=(content.ilike.*${encodeURIComponent(kw)}*,title.ilike.*${encodeURIComponent(kw)}*)`;
  if (typeof flags.since === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.since)) { console.error('❌ --since 需 YYYY-MM-DD'); process.exitCode = 1; return; }
    q += `&created_at=gte.${flags.since}`;
  }
  if (typeof flags.until === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.until)) { console.error('❌ --until 需 YYYY-MM-DD'); process.exitCode = 1; return; }
    q += `&created_at=lt.${flags.until}`;
  }
  let rows = await ctx.api('GET', q);
  if (typeof flags.tag === 'string' && flags.tag.trim()) {
    const t = normalizeTag(flags.tag);
    rows = rows.filter((r) => Array.isArray(r.tags) && r.tags.includes(t));
  }
  out(flags, { keyword: kw || null, tag: flags.tag || null, count: rows.length, notes: rows }, () => {
    if (!rows.length) { console.log('（无命中）'); return; }
    console.log(`笔记检索命中 ${rows.length} 条：\n`);
    for (const n of rows) {
      const tags = Array.isArray(n.tags) && n.tags.length ? `  #${n.tags.join(' #')}` : '';
      console.log(`📝 ${(n.title || '(无标题)').slice(0, 40)}${tags}`);
      console.log(`   ${(n.content || '').slice(0, 80)}${(n.content || '').length > 80 ? '…' : ''}`);
      console.log(`   id=${n.id}  ${String(n.created_at).slice(0, 10)}`);
    }
  });
}

/** note edit <id前缀> --file <md> | --title "新标题"：重解析替换 / 仅改标题；is_refined 恒 true */
async function noteEdit(ctx, flags, pos) {
  const id = pos[0];
  const hasFile = typeof flags.file === 'string';
  const hasTitle = typeof flags.title === 'string';
  if (!id || (!hasFile && !hasTitle)) {
    console.error('用法: note edit <id前缀> --file <md文件> | --title "新标题" [--yes]');
    console.error('      --file：content/title/tags 按文件重解析替换；--title：仅改标题；is_refined 恒 true');
    process.exitCode = 1;
    return;
  }
  const row = await findByIdPrefix(ctx.api, 'capsules', id, 'id,title,content,category,tags,is_refined');
  if (row.category !== '笔记' || !row.is_refined) {
    console.log(`ℹ️ 目标行当前不在笔记域（category=${row.category}，is_refined=${row.is_refined}），本次编辑后将标记为笔记`);
  }

  const patch = { is_refined: true }; // FR5：恒 true
  if (hasFile) {
    const abs = expandPath(flags.file);
    if (!existsSync(abs)) { console.error(`❌ 文件不存在：${abs}`); process.exitCode = 1; return; }
    const content = readFileSync(abs, 'utf8');
    patch.content = content;
    patch.tags = parseHashtags(content);
    patch.title = titleFromContent(content); // --file 重解析（--title 同时显式给则下方覆盖）
  }
  if (hasTitle) patch.title = String(flags.title).trim().slice(0, 120);

  const changes = [];
  if (patch.content !== undefined) changes.push(`content→${patch.content.length} 字`);
  if (patch.title !== undefined && patch.title !== row.title) changes.push(`title→「${patch.title}」`);
  else if (patch.title !== undefined && patch.title === row.title) changes.push('title（未变）');
  if (patch.tags !== undefined) changes.push(`tags→[${patch.tags.join('、')}]`);
  changes.push('is_refined→true');
  if (!(await writeGuard(`笔记编辑「${row.title || '(无标题)'}」：${changes.join('，')}`, flags))) return;

  const [updated] = await ctx.api('PATCH', `capsules?id=eq.${encodeURIComponent(row.id)}&select=id,title,content,category,tags,is_refined,created_at`, patch);
  await ctx.logCli('note_edit', 'capsule', row.id, {
    title: updated.title || row.title,
    content: patch.content !== undefined ? patch.content : `变更：${changes.join('，')}`,
    type: '笔记编辑', table: 'capsules',
  });
  out(flags, { note: updated }, () => {
    console.log(`✅ 已修改笔记「${updated.title || '(无标题)'}」（id=${updated.id}）`);
  });
}

/** note tag <id> --add a,b / --del a,b：tags 数组增删 */
async function noteTag(ctx, flags, pos) {
  const id = pos[0];
  if (!id || (!flags.add && !flags.del)) {
    console.error('用法: note tag <id前缀> --add 标签1[,标签2] | --del 标签1[,标签2] [--yes]');
    process.exitCode = 1;
    return;
  }
  const row = await findByIdPrefix(ctx.api, 'capsules', id, 'id,title,content,category,tags,is_refined');
  if (row.category !== '笔记' || !row.is_refined) {
    console.log(`ℹ️ 目标行当前不在笔记域（category=${row.category}，is_refined=${row.is_refined}）`);
  }
  const cur = Array.isArray(row.tags) ? [...row.tags] : [];
  let next = [...cur]; // 🔴 浅拷贝，否则回显「现→改」同一数组（同 todo/capsule tag 教训）
  if (typeof flags.add === 'string') {
    for (const t of flags.add.split(/[,，]/).map(normalizeTag).filter(Boolean)) if (!next.includes(t)) next.push(t);
  }
  if (typeof flags.del === 'string') {
    const rm = flags.del.split(/[,，]/).map(normalizeTag).filter(Boolean);
    next = next.filter((t) => !rm.includes(t));
  }
  if (!(await writeGuard(`笔记标签「${(row.title || row.content || '').slice(0, 30)}」：现 [${cur.join('、')}] → [${next.join('、')}]`, flags))) return;
  const [updated] = await ctx.api('PATCH', `capsules?id=eq.${encodeURIComponent(row.id)}&select=id,title,tags`, { tags: next });
  await ctx.logCli('note_tag', 'capsule', row.id, {
    title: row.title || (row.content || '').slice(0, 30),
    content: `标签：[${cur.join('、')}] → [${next.join('、')}]`,
    type: '笔记标签', table: 'capsules',
  });
  out(flags, { updated }, () => console.log(`✅ 标签已更新「${updated.title || '(无标题)'}」：[${(updated.tags || []).join('、')}]（id=${updated.id}）`));
}

/* ============================================================
 * 命令族入口（A 段注册器挂载点）
 * ============================================================ */

export const command = 'note';

export const usage = [
  '  note add "<内容>"              记笔记（#标签 自动解析；category=笔记 + is_refined=true，/notes/ 可见）[--yes]',
  '  note list [--limit 20] [--tag 标签]                    笔记列表（不含闪念/日记）',
  '  note show <id前缀>                                           全文输出',
  '  note search <关键词> [--tag 标签] [--since 日期] [--until 日期]   content/title ilike 检索',
  '  note edit <id前缀> --file <md> | --title "新标题" [--yes]        换正文重解析 / 仅改标题',
  '  note tag <id前缀> --add a,b | --del a,b [--yes]        标签增删',
];

export async function run(flags, pos, ctx = {}) {
  _ctxOutput = ctx.output || null;
  // ctx 兜底：A 段注册器未注入时（独立运行/早期验证），走 lib/wb-auth.mjs 统一通道
  if (!ctx.api) {
    const { makeApi } = await import('../wb-auth.mjs');
    const { api } = makeApi({ profile: process.env.WB_PROFILE });
    ctx = {
      api,
      logCli: (action, module, targetId, detail) => logCliFallback(api, action, module, targetId, detail),
    };
  }
  const sub = pos[0] || 'list';
  const rest = pos.slice(1);
  switch (sub) {
    case 'add': return noteAdd(ctx, flags, rest);
    case 'list': return noteList(ctx, flags);
    case 'show': return noteShow(ctx, flags, rest);
    case 'search': return noteSearch(ctx, flags, rest);
    case 'edit': return noteEdit(ctx, flags, rest);
    case 'tag': return noteTag(ctx, flags, rest);
    default:
      console.error(`未知子命令：${sub}（支持 add / list / show / search / edit / tag）`);
      process.exitCode = 1;
      return;
  }
}

/* ============================================================
 * 独立运行兜底（A 段注册器合并前的验证通道）：
 *   node lib/wb-cli/cmd-note.mjs add "..." --yes
 *   node lib/wb-cli/cmd-note.mjs list
 * ============================================================ */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  run(flags, pos, {}).catch((e) => { console.error('❌', e.message); process.exitCode = 1; });
}

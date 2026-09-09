#!/usr/bin/env node
/**
 * AI 工作台 · wb-cli（跨终端 CLI 功能集成工具）
 * ------------------------------------------------------------
 * 用途（刘总 2026-08-21 任务包 C / id a05596fa）：
 *   1) add <文本|文件路径>  —— 全类型录入（9 类）AI 自动判类落库
 *      覆盖：待办/AI点子/开发待办/闪念/日记/公众号收藏/日程/电子书
 *   2) todo/idea/bug/capsule/book list —— 各域查询
 *   3) search <关键词>       —— ilike 全文检索（多表）
 *   4) fill <模板名>         —— 输出预置提示词模板（日报/周报素材/点子复盘）
 *
 * 设计约束：
 *   - Node ≥18 原生（fetch/readline），零 npm 依赖，单文件入口 + lib/wb-cli/ 纯数据模块
 *   - 数据通道复用 ai-bug-cli 模式：CloudBase PG REST（PostgREST 语法，Publishable Key anon）
 *   - Key 读取降级链：lib/cloudbase-config.ts → ~/.workbuddy/cloudbase.env → 内置公钥兜底
 *   - AI 判类：百炼 qwen-flash（BAILIAN_API_KEY，降级链同 ai-bug-cli；本文件自实现 fetch，
 *     禁止 import lib/ai.ts——该文件被任务包 A 独占）
 *   - 🔴 镜像铁律：idea → ai_ideas + 镜像 todos（category='AI灵感'，description 带 id 回指）；
 *     bug → ai_bugs + 镜像 todos（category='开发待办'，dev_bug_id 挂接）。绝不直写 todos 完事。
 *   - 写操作安全：先回显「将写入」再执行（--yes 跳过）；--type <别名> 可强制指定类型
 *   - 27N3B（id f0c0c3dc）：所有写操作（add/todo/idea/schedule/capsule tag/book）经 REST 等价写
 *     action_logs（口径同 lib/action-log.ts：action=cli_*，detail 带 title+content 全量），
 *     fire-and-forget 失败不阻断主流程
 *
 * 用法示例：
 *   node scripts/wb-cli.mjs add "明天上午10点提醒我与周晨凯对Q3数据"
 *   node scripts/wb-cli.mjs add --file ~/Downloads/三体.epub
 *   node scripts/wb-cli.mjs add "修复：看板闪烁" --type bug --yes
 *   node scripts/wb-cli.mjs todo list [--status pending|featured|completed] [--today] [--json]
 *   node scripts/wb-cli.mjs todo done <id>
 *   node scripts/wb-cli.mjs idea list / bug list --open / capsule list / book list
 *   node scripts/wb-cli.mjs search 周晨凯 [--table todos|capsules|ai_ideas|ai_bugs|articles_inbox|people]
 *   node scripts/wb-cli.mjs fill 日报
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { makeApi, resolveAuth, authHint, GATEWAY_BASE } from '../lib/wb-auth.mjs';
import {
  TYPE_LABEL, TYPE_TABLE, buildClassifyPrompt,
} from '../lib/wb-cli/classify-prompt.mjs';
import {
  mapTodo, mapSchedule, mapCapsule, mapArticle, mapIdea, mapIdeaMirrorTodo,
  mapBug, mapBugMirrorTodo, mapBook, bookTitleFromFilename, bookFormatFromExt,
  parseHashtags, normalizeTag,
} from '../lib/wb-cli/table-maps.mjs';
import { resolveTypeAlias, FILL_TEMPLATES, FILL_ALIASES } from '../lib/wb-cli/aliases.mjs';
import { createRegistry } from '../lib/wb-cli/registry.mjs';
import { makeCtx, loadCmdModules, makeApiList } from '../lib/wb-cli/shared.mjs';
import { EXIT, envelopeOk, envelopeErr, classifyError, withCode, setLang } from '../lib/wb-cli/output.mjs';
import { idempotencyLookup, idempotencySave } from '../lib/wb-cli/idempotency.mjs';
import { resolveLongInput } from '../lib/wb-cli/shared.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/* ============================================================
 * 配置：统一走 lib/wb-auth.mjs（2026-08-31 方案 A）
 * 优先 ai-proxy /v1/rest 鉴权通道（Bearer wbk_ API Key），
 * 旧 key（service_role/anon）降级直连——行为兼容迁移期。
 * ============================================================ */

const { auth, base, api } = makeApi({ profile: process.env.WB_PROFILE });
// C段 FR-7：list 类命令游标分页取数器（todo/bug/book/capsule/dev-task/note list 统一走它）
const apiList = makeApiList({ base, auth });

function getBailianKey() {
  // ① 环境变量
  if (process.env.BAILIAN_API_KEY) return process.env.BAILIAN_API_KEY;
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  // ② ~/.workbuddy/bailian.env（本机百炼 Key 实际存放处）
  const paths = [resolve(homedir(), '.workbuddy/bailian.env'), resolve(homedir(), '.workbuddy/cloudbase.env')];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^\s*(?:export\s+)?(?:BAILIAN_API_KEY|DASHSCOPE_API_KEY)\s*=\s*['"]?([^\s'"]+)/m);
    if (m) return m[1];
  }
  return null;
}

/* ============================================================
 * 27N3B（id f0c0c3dc）：操作日志 REST 等价写入
 * 口径对齐 lib/action-log.ts（ACTION_CN / detail.title+content）；
 * fire-and-forget：失败仅 stderr 提示，绝不阻断写主流程。
 * ============================================================ */

const CONTENT_MAX = 4000;
const TITLE_MAX = 120;

/** CLI 版表名→module 映射（与 lib/action-log.ts TABLE_MODULE 同口径） */
const TABLE_MODULE = {
  todos: 'todo', capsules: 'capsule', schedules: 'schedule',
  ai_ideas: 'ai', ai_bugs: 'ai', people: 'people',
  org_knowledge: 'knowledge', knowledge_cards: 'knowledge',
  articles_inbox: 'capture', books: 'growth', canvases: 'canvas',
  decision_logs: 'orpt',
};

/** 记一条 CLI 操作日志（不抛错） */
async function logCli(action, module, targetId, detail) {
  try {
    const d = { source: 'wb-cli', ...detail };
    if (typeof d.title === 'string' && d.title.length > TITLE_MAX) d.title = d.title.slice(0, TITLE_MAX);
    if (typeof d.content === 'string' && d.content.length > CONTENT_MAX) d.content = d.content.slice(0, CONTENT_MAX) + '…(截断)';
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

/* ============================================================
 * 通用工具
 * ============================================================ */

function todayCtx() {
  const d = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}（周${week}）`;
}

function todayDateStr() {
  return todayCtx().slice(0, 10);
}

function tomorrowDateStr() {
  const d = new Date(Date.now() + 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function extractUrl(text) {
  const m = String(text).match(/https?:\/\/[^\s，。；、"'<>【】]+/i);
  return m ? m[0].replace(/[)，。；]/g, '') : null;
}

/** 交互确认（--yes 跳过；非 TTY 默认拒绝） */
async function confirm(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => {
    rl.question(`${message} [y/N] `, (a) => {
      rl.close();
      r(/^y(es)?$/i.test(a.trim()));
    });
  });
}

/** 解析 argv：flags（--key value / --key）+ 位置参数 */
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

/** 统一 JSON 输出（--json 机器可读；A段 FR-2：包 {success,data,error} envelope） */
function output(data, human) {
  if (FLAGS.json) console.log(JSON.stringify(envelopeOk(data), null, 2));
  else if (human) human();
}

/** readline 单问（返回输入串；EOF/非 TTY 返回 null） */
async function prompt(message) {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => {
    rl.question(`${message} `, (a) => { rl.close(); r(a.trim() || null); });
  });
}

let FLAGS = {};

/* A段 FR-1：未知 flag 告警（渐进：重灾区先行）。flags 不删不拒（行为兼容），
 * 仅 stderr 提示——静默吞参数是「过滤不生效」类 bug 的直接根因
 * （如 todo list 只认 --cat，传 --category 会被无声忽略恒返全量）。 */
const KNOWN_FLAGS = {
  'todo list': ['json', 'status', 'today', 'cat', 'prio', 'tag', 'overdue', 'limit', 'cursor', 'all', 'fields'],
  'add': ['json', 'yes', 'type', 'file', 'idempotency-key', 'content-file', 'stdin', 'profile'],
  'idea add': ['json', 'yes', 'title', 'idempotency-key', 'content-file', 'stdin'],
  'note add': ['json', 'yes', 'idempotency-key', 'content-file', 'stdin'],
  'schedule add': ['json', 'yes', 'at', 'loc', 'idempotency-key', 'content-file', 'stdin'],
  'dev-task list': ['json', 'search', 'status', 'limit', 'cursor', 'all', 'fields'],
  'bug list': ['json', 'open', 'status', 'module', 'limit', 'cursor', 'all', 'fields'],
  'book list': ['json', 'limit', 'cursor', 'all', 'fields'],
  'capsule list': ['json', 'limit', 'category', 'tag', 'cursor', 'all', 'fields'],
  'note list': ['json', 'limit', 'tag', 'cursor', 'all', 'fields'],
};
function warnUnknownFlags(cmd, sub, flags) {
  const key = `${cmd} ${sub || ''}`.trim();
  const known = KNOWN_FLAGS[key];
  if (!known) return;
  const bad = Object.keys(flags).filter((k) => !known.includes(k));
  if (bad.length) {
    console.error(`⚠️ ${key} 不支持参数 ${bad.map((b) => `--${b}`).join(' ')}（已知：${known.map((k) => `--${k}`).join(' ')}），参数已忽略`);
  }
}

/** C段 FR-7：list 命令分页参数提取（--limit 默认值各命令自定）。
 *  fields 仅在用户显式传 --fields 时含键（避免 undefined 覆盖调用方默认列）。 */
function pageOpts(flags, defLimit) {
  const o = {
    limit: flags.limit != null ? Number(flags.limit) : defLimit,
    cursor: typeof flags.cursor === 'string' && flags.cursor ? flags.cursor : null,
    all: !!flags.all,
  };
  if (typeof flags.fields === 'string' && flags.fields) o.fields = flags.fields;
  return o;
}

/* ============================================================
 * AI 判类（百炼 qwen-flash + json_object；失败返回 null 降级）
 * ============================================================ */

const BAILIAN_MODEL = 'qwen-flash';
const BAILIAN_TIMEOUT_MS = 8000;

async function aiClassifyRaw(raw, catNames) {
  const key = getBailianKey();
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BAILIAN_TIMEOUT_MS);
  try {
    const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: BAILIAN_MODEL,
        messages: [{ role: 'user', content: buildClassifyPrompt(raw, todayCtx(), catNames) }],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    const cleaned = content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    parsed._raw = raw;
    return parsed;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
 * E2（4f7d6296）：口语转写前置修正——判类与落库基于修正文本
 * ============================================================ */

/** 噪声启发式门控（与 lib/ai.ts needsTranscriptPolish 同规则）：干净文本零成本直过 */
function needsTranscriptPolish(text) {
  const t = String(text || '').trim();
  if (t.length < 12) return false;
  if (/[嗯呃哎]{2,}|(?:就是|那个|这个|然后|对吧|等于说){2,}/.test(t)) return true;
  if (/(.)\1{2,}/u.test(t)) return true;
  if (/(.{2,10}?)\1/u.test(t.replace(/\s/g, ''))) return true;
  if (/不对[，,。就是的]|说错了|搞错了|更正一下|应该是|我是说|口误|不是不是/.test(t)) return true;
  return false;
}

/** 调百炼修正口语转写（错别字/语气词/重复/口误残留）；失败/超时返回原文降级 */
async function aiPolishTranscript(text) {
  const key = getBailianKey();
  if (!key) return text;
  const t = text.trim();
  const prompt = `你是中文口语转写修正助手。下面是一段语音转写文本，可能包含：ASR 错别字/同音字错误、口头语气词、重复表述、口误后自行纠正但转写把两句都留下的残留。请输出修正后的干净文本。

要求：
- 修正错别字与同音字错误（按上下文取正确词）
- 删除口头语气词（嗯/呃/那个/就是说等）与重复表述，同一意思只保留一次完整表达
- 口误后自行纠正的：只保留纠正后的正确表述，删除口误原文
- 🔴 不改原意、不增删任何信息点、不总结概括、不调整无关语序
- 保留原有标点与分段；直接输出修正后的文本，不要任何解释、前后缀、markdown

【待修正文本】
${t}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: BAILIAN_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return t;
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return t;
    const cleaned = content.replace(/^```(?:text|plain)?\s*|\s*```$/g, '').trim();
    // 保险丝：修正结果异常（空/暴长暴短）视为失败，回原文
    if (!cleaned || cleaned.length < t.length / 3 || cleaned.length > t.length * 2) return t;
    return cleaned;
  } catch {
    return t;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 提交前统一修正入口：噪声门控命中才修（省一次调用），修正后判类与落库都用干净文本。
 * 修正成功时回显提示，让刘总知道文本被修过。
 */
async function polishIfNoisy(raw) {
  if (!needsTranscriptPolish(raw)) return raw;
  const polished = await aiPolishTranscript(raw);
  if (polished !== raw) {
    console.error(`ℹ️ 已前置修正口语转写（判类与落库基于修正文本）`);
  }
  return polished;
}

/** 本地关键词降级判类（参考 lib/format.ts detectEntryType 语义，自实现扩展 9 类） */
function localClassify(raw, hasFile) {
  const text = String(raw || '').trim();
  if (hasFile) return { type: 'book', reason: '（本地降级）--file 电子书', title: '', _raw: raw };
  if (extractUrl(text)) {
    const isWeixin = /mp\.weixin\.qq\.com/.test(text);
    return { type: 'article', reason: '（本地降级）含链接强信号', url: extractUrl(text), title: text.replace(extractUrl(text), '').trim(), _raw: raw };
  }
  if (/修复|bug|优化[:：]|改动[:：]|报错|崩溃|闪烁|开发待办/.test(text) && /工作台|看板|页面|按钮|输入|模块|UI|系统|组件/.test(text)) {
    const kind = /优化|改进|增强/.test(text) ? 'opt' : 'bug';
    return { type: 'bug', reason: '（本地降级）工作台开发需求特征', kind, title: text.replace(/^(修复|bug|优化)[:：]?\s*/i, '').split(/[,，。;；]/)[0].slice(0, 30), _raw: raw };
  }
  if (/^(闪念|突然想到|有个想法|我觉得|灵感)/.test(text) || /这个想法不错|有个点子|加个.{2,8}(功能|按钮|视图)/.test(text)) {
    if (/工作台|工作流|产品|功能/.test(text)) {
      return { type: 'idea', reason: '（本地降级）产品功能创意特征', title: text.replace(/^(这个想法不错[:：]?|有个点子[:：]?|闪念[:：]?)/, '').slice(0, 30), _raw: raw };
    }
    return { type: 'capsule', reason: '（本地降级）想法感悟', title: text.replace(/^(闪念|突然想到)[:：]?/, '').slice(0, 30), _raw: raw };
  }
  if (/日记|心情|反思|复盘今天|今天做了|我决定/.test(text)) {
    return { type: 'diary', reason: '（本地降级）日记体', title: text.slice(0, 20), _raw: raw };
  }
  if ((/明天|后天|周[一二三四五六日天]/.test(text) || /\d{1,2}[点时:：]/.test(text)) && /开会|会议|家长会|约|见|提醒|对齐|沟通|汇报|体检|出差|生日|预约|聚会|面试|上课|机票|高铁|培训|调研/.test(text)) {
    return { type: 'schedule', reason: '（本地降级）确定时间点安排', title: text.replace(/^(明天|后天|周[一二三四五六日天])[^，。 ]*/, '').slice(0, 25) || text.slice(0, 25), scheduleTime: text, _raw: raw };
  }
  if (/买|交|还|办|做|报|去|取|写|整理|检查|提交|报销|付|带|送|领|寄|务必|截止|落实|推进/.test(text)) {
    return { type: 'todo', reason: '（本地降级）明确任务动词', title: text.slice(0, 30), _raw: raw };
  }
  return { type: 'capsule', reason: '（本地降级）无法判断，闪念兜底', title: text.slice(0, 30), _raw: raw };
}

/** 拉取 todo_categories 现有分类树（供 AI 判类 + todos.category 匹配） */
async function fetchCategoryNames() {
  try {
    const rows = await api('GET', 'todo_categories?select=name&order=sort_order.asc&limit=100');
    return Array.isArray(rows) ? rows.map((r) => r.name) : [];
  } catch { return []; }
}

/** 待办分类匹配：精确/包含匹配现有树，匹配不上返回 '工作' */
function matchCategory(candidate, catNames) {
  if (!candidate) return '工作';
  const c = String(candidate).trim();
  if (catNames.includes(c)) return c;
  const fuzzy = catNames.find((n) => n.includes(c) || c.includes(n));
  return fuzzy || '工作';
}

/* ============================================================
 * 口语时间解析（schedule 降级用；AI 已给 start_at 时跳过）
 * ============================================================ */

function parseNaturalDateTime(text, now = new Date()) {
  const d = new Date(now);
  const dayMap = { 日: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 天: 0 };
  let matched = false;
  const mWeek = text.match(/周([一二三四五六日天])/);
  if (mWeek) {
    const target = dayMap[mWeek[1]];
    let diff = target - now.getDay();
    if (diff <= 0) diff += 7;
    d.setTime(now.getTime() + diff * 86400000);
    matched = true;
  } else if (/后天/.test(text)) {
    d.setTime(now.getTime() + 2 * 86400000); matched = true;
  } else if (/明天/.test(text)) {
    d.setTime(now.getTime() + 86400000); matched = true;
  } else if (/今天|今晚/.test(text)) {
    matched = true;
  }
  const hm = text.match(/(?:上午|下午|晚上|中午)?\s*(\d{1,2})[点时:：](\d{0,2})/);
  let hasTime = false;
  if (hm) {
    let h = parseInt(hm[1]);
    if (/下午|晚上/.test(text) && h < 12) h += 12;
    d.setHours(h, parseInt(hm[2] || '0'), 0, 0);
    hasTime = true;
  } else {
    d.setHours(9, 0, 0, 0);
  }
  // 只有时间没有日期词 → 今天；只有日期词没时间 → 9:00
  return { iso: d.toISOString(), matched: matched || hasTime };
}

/* ============================================================
 * add：全类型录入
 * ============================================================ */

async function cmdAdd(flags, pos) {
  // P1 FR-2 幂等：同 key 24h 内重复提交返回首次结果，不再落库（save 在 dispatchAdd 落库点统一做）
  const idemKey = typeof flags['idempotency-key'] === 'string' ? flags['idempotency-key'] : null;
  if (idemKey) {
    const hit = idempotencyLookup(idemKey);
    if (hit) { output({ ...hit, deduped: true }, () => console.log(`♻️ 幂等命中（key=${idemKey}），返回首次结果，未重复入库`)); return; }
  }
  // P1 FR-3 长输入通道：--content-file / --stdin 优先
  const long = resolveLongInput(flags, pos, { label: 'add 文本' });
  const raw = long.text !== '' || long.source !== 'argv' ? long.text : pos.join(' ').trim(); // E2 前置修正可能重写为干净文本
  const fileArg = typeof flags.file === 'string' ? flags.file : null;
  if (!raw && !fileArg) {
    console.error('用法: add <文本> | add --file <电子书路径> | add --content-file <md> [--type 别名] [--yes] [--json] [--idempotency-key key]');
    process.exitCode = 1;
    return;
  }
  return cmdAddRun(raw, fileArg, flags, pos, idemKey);
}

/** cmdAdd 主体（幂等包装拆出；raw 已过长输入通道） */
async function cmdAddRun(raw, fileArg, flags, pos, idemKey) {
  if (!raw && !fileArg) {
    console.error('用法: add <文本> | add --file <电子书路径> [--type 别名] [--yes] [--json]');
    process.exitCode = 1;
    return;
  }

  // --file 电子书优先路径
  if (fileArg) {
    return addBook(fileArg, raw, flags);
  }

  // 文本参数本身是存在的本地电子书文件路径 → 走 book
  if (raw && existsSync(resolve(raw)) && statSync(resolve(raw)).isFile() && /\.(epub|pdf|txt)$/i.test(raw)) {
    return addBook(raw, '', flags);
  }

  // --type 强制指定 → 跳过 AI 判类
  let decision;
  const forced = resolveTypeAlias(flags.type);
  if (forced) {
    const url = extractUrl(raw);
    decision = { type: forced, reason: '（--type 强制指定）', title: raw.replace(/^(修复|优化|bug|闪念|点子)[:：]?/i, '').split(/[,，。;；]/)[0].slice(0, 30), url, _raw: raw, kind: forced === 'bug' ? (/优化|改进/.test(raw) ? 'opt' : 'bug') : undefined, scheduleTime: raw };
  } else {
    // E2：口语转写噪声先修正，判类与落库基于修正文本（干净文本直过零成本）
    raw = await polishIfNoisy(raw);
    const catNames = await fetchCategoryNames();
    decision = await aiClassifyRaw(raw, catNames);
    if (!decision) {
      decision = localClassify(raw, false);
      console.error(`ℹ️ AI 判类不可用（无 Key/超时），已降级本地关键词判类：${decision.reason}`);
    }
  }

  // article 无 URL → 降级闪念（任务包硬规则）
  let finalType = decision.type;
  if (finalType === 'article') {
    const u = decision.url || extractUrl(raw);
    if (!u) {
      console.error('⚠️ 判为公众号收藏但未提取到 URL，按规则降级为闪念');
      finalType = 'capsule';
    } else decision.url = u;
  }
  if (finalType === 'other') {
    console.error('ℹ️ 判为人脉/其他（本期不强判），按规则落闪念兜底');
    finalType = 'capsule';
  }

  return dispatchAdd(finalType, decision, flags, raw);
}

/** 按类型分发落库（回显 → 确认 → 写入 → 输出「类型+标题+落库表+id」） */
async function dispatchAdd(type, c, flags, raw) {
  // P1 FR-2 幂等：同 key 重试直接返回首次结果（命中即不再落库）
  const idemKey = typeof flags['idempotency-key'] === 'string' ? flags['idempotency-key'] : null;
  if (idemKey) {
    const hit = idempotencyLookup(idemKey);
    if (hit) {
      output({ ...hit, deduped: true }, () => console.log(`♻️ 幂等命中（key=${idemKey}），返回首次结果 id=${hit.id || '?'}，未重复入库`));
      return;
    }
  }
  const todayStr = todayDateStr();
  let plan; // { rows: [{table, row, label}], echo }

  if (type === 'todo') {
    const catNames = await fetchCategoryNames();
    const row = mapTodo(c, todayStr);
    row.category = matchCategory(row.category, catNames);
    // A 段口径：日粒度截止 → end_at 当日 23:59:59（+08）+ all_day；todo_date 双写（DDL-2 删列后移除双写）
    if (!row.todo_date || row.todo_date === todayStr) row.todo_date = todayStr;
    row.end_at = `${row.todo_date}T23:59:59+08:00`;
    row.all_day = true;
    plan = { rows: [{ table: 'todos', row, label: `待办「${row.title}」（分类：${row.category}）` }] };
  } else if (type === 'schedule') {
    const row = mapSchedule(c);
    if (!row.start_at) {
      const p = parseNaturalDateTime(c.scheduleTime || raw);
      row.start_at = p.iso;
      const e = new Date(p.iso); e.setTime(e.getTime() + 3600000);
      row.end_at = e.toISOString();
    } else if (!row.end_at) {
      const e = new Date(row.start_at); if (!Number.isNaN(e.getTime())) { e.setTime(e.getTime() + 3600000); row.end_at = e.toISOString(); }
    }
    plan = { rows: [{ table: 'schedules', row, label: `日程「${row.title}」 ${String(row.start_at).slice(0, 16).replace('T', ' ')} ~ ${String(row.end_at).slice(0, 16).replace('T', ' ')}` }] };
  } else if (type === 'capsule' || type === 'diary') {
    const row = mapCapsule(c, type === 'diary');
    plan = { rows: [{ table: 'capsules', row, label: `${type === 'diary' ? '日记' : '闪念'}「${(row.content || '').slice(0, 30)}」` }] };
  } else if (type === 'article') {
    const url = c.url || extractUrl(raw);
    let fallbackTitle = raw.replace(url, '').trim();
    if (!fallbackTitle) { try { fallbackTitle = new URL(url).hostname; } catch { fallbackTitle = url; } }
    const row = mapArticle(c, fallbackTitle);
    row.url = url;
    plan = { rows: [{ table: 'articles_inbox', row, label: `公众号收藏「${row.title}」 ${url}` }] };
  } else if (type === 'idea') {
    const ideaRow = mapIdea(c);
    plan = {
      rows: [
        { table: 'ai_ideas', row: ideaRow, label: `AI 点子「${ideaRow.title}」（主数据）`, primary: true },
      ],
      mirror: 'idea',
    };
  } else if (type === 'bug') {
    const bugRow = mapBug(c);
    plan = {
      rows: [
        { table: 'ai_bugs', row: bugRow, label: `开发待办「${bugRow.title}」（主数据 kind=${bugRow.kind}）`, primary: true },
      ],
      mirror: 'bug',
    };
  } else {
    console.error(`❌ 未支持的类型：${type}`);
    process.exitCode = 1;
    return;
  }

  // 回显 + 确认
  const echoLines = plan.rows.map((r) => `  → ${r.table}：${r.label}`);
  if (plan.mirror === 'idea') echoLines.push('  → todos：镜像行（category=AI灵感，description 带 ai_ideas id 回指）');
  if (plan.mirror === 'bug') echoLines.push('  → todos：镜像行（category=开发待办，dev_bug_id 挂接）');
  // 🔴 --json 模式回显必须走 stderr（stdout 只留数据）：曾因回显污染 stdout，
  // wb-mcp 判定「非 JSON」后关 --json 重试一次 = 写命令双写。console.error 在
  // 非 json 模式仍写 stdout，人读体验不变。
  const echo = (l) => (FLAGS.json ? console.error(l) : console.log(l));
  echo(`将写入 · 类型：${TYPE_LABEL[type]}${c.reason ? `（${c.reason}）` : ''}`);
  echoLines.forEach((l) => echo(l));

  if (!flags.yes) {
    if (process.stdin.isTTY) {
      const ok = await confirm('确认写入？');
      if (!ok) { console.log('已取消（加 --yes 跳过确认）'); return; }
    } else {
      console.error('⛔ 非 TTY 环境写操作需 --yes'); process.exitCode = 2; return;
    }
  }

  // 写入（primary 先行拿 id，再建镜像）
  const result = { type, reason: c.reason || '', writes: [] };
  let primaryCreated = null;
  for (const r of plan.rows) {
    const [created] = await api('POST', r.table, r.row);
    result.writes.push({ table: r.table, id: created.id, title: r.row.title || r.row.content?.slice(0, 30) || '' });
    if (r.primary) primaryCreated = created;
  }

  // P1 FR-2 幂等 save：落库成功后记首次结果（含主行 id，供同 key 重试直接返回）
  if (idemKey && primaryCreated) {
    idempotencySave(idemKey, { ok: true, cmd: type, id: primaryCreated.id });
  }

  if (plan.mirror === 'idea' && primaryCreated) {
    const mirror = mapIdeaMirrorTodo(primaryCreated);
    const [m] = await api('POST', 'todos', mirror);
    await api('PATCH', `ai_ideas?id=eq.${primaryCreated.id}`, { todo_id: m.id });
    result.writes.push({ table: 'todos(镜像)', id: m.id, title: mirror.title });
  }
  if (plan.mirror === 'bug' && primaryCreated) {
    const mirror = mapBugMirrorTodo(primaryCreated);
    const [m] = await api('POST', 'todos', mirror);
    await api('PATCH', `ai_bugs?id=eq.${primaryCreated.id}`, { todo_id: m.id });
    result.writes.push({ table: 'todos(镜像)', id: m.id, title: mirror.title });
  }

  // 27N3B：命令行录入记操作日志（主表行 + 镜像行；content 全量）
  {
    const primary = result.writes[0];
    const moduleName = TABLE_MODULE[plan.rows[0].table] || plan.rows[0].table;
    const fullContent = raw || String(plan.rows[0].row.title || plan.rows[0].row.content || '');
    await logCli('cli_add', moduleName, String(primary?.id || ''),
      { title: primary?.title || String(plan.rows[0].row.title || '').slice(0, 40), content: fullContent, type, table: plan.rows[0].table, mirror: plan.mirror ? `${plan.mirror} 镜像已建` : undefined });
    if (plan.mirror && primaryCreated) {
      const mirrorWrite = result.writes.find((w) => String(w.table).includes('镜像'));
      if (mirrorWrite) {
        await logCli('cli_add', 'todo', String(mirrorWrite.id),
          { title: mirrorWrite.title, content: `${type} 镜像行（主数据 ${plan.rows[0].table} id=${primary.id}）`, type: `${type}镜像`, table: 'todos' });
      }
    }
  }

  // 统一输出：类型 + 标题 + 落库表 + id
  output(result, () => {
    console.log(`✅ 已写入 · ${TYPE_LABEL[type]}（${TYPE_TABLE[type].replace(/（.*/, '')}）`);
    for (const w of result.writes) console.log(`   [${w.table}] ${w.title}  id=${w.id}`);
  });
}

/** 电子书：力争直传 growth-library 桶；降级只落 books 表（file_path=local:<路径>） */
async function addBook(filePath, noteText, flags) {
  const abs = resolve(filePath.replace(/^~(?=\/|$)/, homedir()));
  if (!existsSync(abs)) { console.error(`❌ 文件不存在：${abs}`); process.exitCode = 1; return; }
  const ext = extname(abs).slice(1).toLowerCase();
  const format = bookFormatFromExt(ext);
  if (!format) { console.error(`❌ 不支持的格式 .${ext}（仅 epub/pdf/txt）`); process.exitCode = 1; return; }
  const size = statSync(abs).size;
  const title = (noteText || '').trim() || bookTitleFromFilename(basename(abs));

  (FLAGS.json ? console.error : console.log)(`将写入 · 类型：电子书`);
  (FLAGS.json ? console.error : console.log)(`  → books：${title}（format=${format}，${(size / 1024 / 1024).toFixed(2)}MB）`);
  if (!flags.yes) {
    if (process.stdin.isTTY) {
      const ok = await confirm('确认写入？');
      if (!ok) { console.log('已取消'); return; }
    } else { console.error('⛔ 非 TTY 环境写操作需 --yes'); process.exitCode = 2; return; }
  }

  // ① 力争直传：CloudBase Neo Storage HTTP 端点（js-sdk uploadFile 的底层通道，无 npm 依赖复刻）
  let uploaded = false;
  let remotePath = '';
  try {
    const r = await uploadToGrowthBucket(abs, format);
    if (r) { uploaded = true; remotePath = r; }
  } catch (e) {
    console.error(`ℹ️ 直传未成（${String(e.message || e).slice(0, 120)}），降级只落库`);
  }

  const row = mapBook({ title, format, filePath: uploaded ? remotePath : abs, fileSize: size, uploaded });
  const [created] = await api('POST', 'books', row);

  // 27N3B：电子书录入记操作日志
  await logCli('cli_add', 'growth', String(created.id),
    { title, content: `电子书入库（format=${format}，${(size / 1024 / 1024).toFixed(2)}MB${uploaded ? `，已直传 growth-library/${remotePath}` : '，未上云（local 路径）'}）`, type: 'book', table: 'books' });

  const result = {
    type: 'book', writes: [{ table: 'books', id: created.id, title }],
    uploaded, remotePath: remotePath || null, localPath: uploaded ? null : abs,
  };
  output(result, () => {
    console.log(`✅ 已写入 · 电子书（books）`);
    console.log(`   [books] ${title}  id=${created.id}`);
    if (uploaded) console.log(`   ☁️ 已直传：growth-library/${remotePath}`);
    else console.log(`   ⚠️ 文件未上云（file_path=local:${abs}），请在 Web 端书架重传`);
  });
}

/**
 * CloudBase Neo Storage 直传（原生 fetch + fs 复刻 js-sdk upload 的两步签名链）。
 * 537ab762 修复：v4.10.0 重构误删常量后 headers 展开 {...H} → ReferenceError。
 * 实测（2026-09-04）：桶 public=true 仅可匿名**读**，匿名 PUT 401；
 * js-sdk 底层真实通道为两步——
 *   ① POST /v1/storages/object/upload/sign/<bucket>/<key>（Publishable Key 换签名 URL）
 *   ② PUT 签名 URL（raw body）→ 200
 * 公钥非机密（anon），解析降级链复刻 lib/wb-auth.mjs ③。失败抛错 → 调用方降级。禁止引入 npm 依赖。
 */

/** Publishable Key 解析降级链：env 变量 → ~/.workbuddy/cloudbase.env → lib/cloudbase-config.ts */
function resolvePublishableKey() {
  if (process.env.CLOUDBASE_PUBLISHABLE_KEY) return process.env.CLOUDBASE_PUBLISHABLE_KEY;
  try {
    const envPath = resolve(homedir(), '.workbuddy/cloudbase.env');
    if (existsSync(envPath)) {
      const m = readFileSync(envPath, 'utf8').match(/^\s*(?:export\s+)?(?:CLOUDBASE_)?PUBLISHABLE_KEY\s*=\s*['"]?([^\s'"]+)/mi);
      if (m) return m[1];
    }
  } catch { /* 忽略，走下一级 */ }
  try {
    const cfg = resolve(ROOT, 'lib', 'cloudbase-config.ts');
    if (existsSync(cfg)) {
      const m = readFileSync(cfg, 'utf8').match(/PUBLISHABLE_KEY\s*=\s*\n?\s*'([^']+)'/);
      if (m) return m[1];
    }
  } catch { /* 忽略 */ }
  return null;
}

async function uploadToGrowthBucket(absPath, format) {
  const key = `books/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${format}`;
  const base = 'https://aiworkbech-d7gha8jzi68c36019.api.tcloudbasegateway.com/v1/storages';
  const buf = readFileSync(absPath);
  const pk = resolvePublishableKey();
  if (!pk) throw new Error('storage PUT 500: 未找到 Publishable Key（env / ~/.workbuddy/cloudbase.env / lib/cloudbase-config.ts 均缺失）');

  // ① 换签名 URL（anon 公钥）
  const signRes = await fetch(`${base}/object/upload/sign/growth-library/${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: pk, Authorization: `Bearer ${pk}` },
  });
  if (!signRes.ok) throw new Error(`storage sign ${signRes.status}: ${(await signRes.text()).slice(0, 200)}`);
  const { fullUrl } = await signRes.json();
  if (!fullUrl) throw new Error('storage sign 200 但响应缺 fullUrl');

  // ② PUT 签名 URL（raw body）
  const putRes = await fetch(fullUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buf,
  });
  if (!putRes.ok) throw new Error(`storage PUT ${putRes.status}: ${(await putRes.text()).slice(0, 200)}`);
  return key;
}

/* ============================================================
 * 查询命令（D1 · 11caa4ef · 2026-08-27 扩充：对标滴答清单/Flomo MCP）
 * ============================================================ */

/** 用 id 前缀取行（全 id 或前缀唯一命中；多命中/零命中报错）。
 *  uuid 列不支持 like/字符串范围比较，CloudBase REST 亦无 cast 通道，
 *  故拉 id 列表（轻量）本地前缀匹配——各表均为百千行级，开销可忽略。 */
async function findByIdPrefix(table, idPrefix, select = '*') {
  const p = String(idPrefix).trim();
  const idRows = await api('GET', `${table}?select=id&limit=5000`);
  const hits = idRows.filter((r) => r.id === p || String(r.id).startsWith(p));
  if (!hits.length) throw new Error(`${table} 无 id 前缀为 ${p} 的行`);
  if (hits.length > 1) throw new Error(`id 前缀 ${p} 命中 ${hits.length} 行，请加长前缀`);
  const [row] = await api('GET', `${table}?select=${select}&id=eq.${encodeURIComponent(hits[0].id)}`);
  return row;
}

/** 写操作安全门（回显 + 确认 + --yes；非 TTY 需 --yes） */
async function writeGuard(label, flags) {
  // 🔴 --json 时回显走 stderr（stdout 只留数据，防 wb-mcp 误判重试导致双写）
  (FLAGS.json ? console.error : console.log)(`将执行 · ${label}`);
  if (flags.yes) return true;
  if (process.stdin.isTTY) {
    const ok = await confirm('确认执行？');
    if (!ok) { console.log('已取消（加 --yes 跳过确认）'); return false; }
    return true;
  }
  console.error('⛔ 非 TTY 环境写操作需 --yes');
  process.exitCode = 2;
  return false;
}

async function cmdTodo(flags, pos) {
  const sub = pos[0] || 'list';
  if (sub === 'done') {
    const id = pos[1];
    if (!id) { console.error('用法: todo done <id> [--yes]'); process.exitCode = 1; return; }
    const now = new Date().toISOString();
    const row = await findByIdPrefix('todos', id, 'id,title');
    if (!(await writeGuard(`待办标完成：「${row.title}」（${row.id}）`, flags))) return;
    await api('PATCH', `todos?id=eq.${encodeURIComponent(row.id)}`, { status: 'completed', completed_at: now });
    await logCli('cli_done', 'todo', row.id, { title: row.title, type: '待办完成', table: 'todos' });
    output({ done: row }, () => console.log(`✅ 待办已完成：${row.title}（id=${row.id}）`));
    return;
  }
  if (sub === 'edit') {
    // 用法: todo edit <id> [--title "新标题"] [--priority high|medium|low] [--due YYYY-MM-DD] [--category 分类名] [--status pending|featured|completed] [--yes]
    const id = pos[1];
    if (!id || (!flags.title && !flags.priority && !flags.due && !flags.category && !flags.status)) {
      console.error('用法: todo edit <id> [--title "新标题"] [--priority high|medium|low] [--due YYYY-MM-DD] [--category 分类名] [--status pending|featured|completed] [--yes]');
      process.exitCode = 1; return;
    }
    const row = await findByIdPrefix('todos', id, 'id,title,status,category,priority,todo_date,end_at');
    const patch = {};
    if (typeof flags.title === 'string') patch.title = flags.title.trim();
    if (typeof flags.priority === 'string') {
      if (!['high', 'medium', 'low'].includes(flags.priority)) { console.error('❌ --priority 仅 high|medium|low'); process.exitCode = 1; return; }
      patch.priority = flags.priority;
    }
    if (typeof flags.due === 'string') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.due)) { console.error('❌ --due 需 YYYY-MM-DD'); process.exitCode = 1; return; }
      // A 段口径：双写 todo_date + end_at（当日 23:59:59 +08）
      patch.todo_date = flags.due;
      patch.end_at = `${flags.due}T23:59:59+08:00`;
      patch.all_day = true;
    }
    if (typeof flags.category === 'string') {
      const catNames = await fetchCategoryNames();
      patch.category = matchCategory(flags.category, catNames);
    }
    if (typeof flags.status === 'string') {
      if (!['pending', 'featured', 'completed'].includes(flags.status)) { console.error('❌ --status 仅 pending|featured|completed'); process.exitCode = 1; return; }
      patch.status = flags.status;
      patch.completed_at = flags.status === 'completed' ? new Date().toISOString() : null;
    }
    const changes = Object.entries(patch).map(([k, v]) => `${k}→${v}`).join('，');
    if (!(await writeGuard(`待办修改「${row.title}」：${changes}`, flags))) return;
    const [updated] = await api('PATCH', `todos?id=eq.${encodeURIComponent(row.id)}&select=*`, patch);
    await logCli('cli_edit', 'todo', row.id, { title: row.title, content: `变更：${changes}`, type: '待办修改', table: 'todos' });
    output({ updated }, () => console.log(`✅ 已修改待办「${updated.title}」（id=${updated.id}）`));
    return;
  }
  if (sub === 'del') {
    // 用法: todo del <id> [--yes]（镜像行随 reconcile 逻辑不自动删主数据；此处只删 todos 行本身）
    const id = pos[1];
    if (!id) { console.error('用法: todo del <id> [--yes]'); process.exitCode = 1; return; }
    const row = await findByIdPrefix('todos', id, 'id,title,category,dev_bug_id,dev_idea_id');
    const isMirror = row.category === '开发待办' || row.category === 'AI灵感';
    if (!(await writeGuard(`删除待办「${row.title}」（${row.id}${isMirror ? '，⚠️ 该行为镜像行，主数据在 ai_bugs/ai_ideas 不受影响，但需手动清理 todo_id 回指' : ''}）`, flags))) return;
    await api('DELETE', `todos?id=eq.${encodeURIComponent(row.id)}`);
    await logCli('cli_delete', 'todo', row.id, { title: row.title, type: '待办删除', table: 'todos', mirror: isMirror || undefined });
    output({ deleted: row }, () => console.log(`🗑️ 已删除待办「${row.title}」（id=${row.id}）`));
    return;
  }
  if (sub === 'tag') {
    // 用法: todo tag <id> --add 标签1,标签2 | --del 标签1,标签2 [--yes]（tags 为 jsonb 数组）
    const id = pos[1];
    if (!id || (!flags.add && !flags.del)) {
      console.error('用法: todo tag <id> --add 标签1[,标签2] | --del 标签1[,标签2] [--yes]');
      process.exitCode = 1; return;
    }
    const row = await findByIdPrefix('todos', id, 'id,title,tags');
    const cur = Array.isArray(row.tags) ? [...row.tags] : [];
    let next = [...cur]; // 🔴 必须浅拷贝，否则回显「现→改」同一数组
    if (typeof flags.add === 'string') {
      for (const t of flags.add.split(/[,，]/).map(normalizeTag).filter(Boolean)) if (!next.includes(t)) next.push(t);
    }
    if (typeof flags.del === 'string') {
      const rm = flags.del.split(/[,，]/).map(normalizeTag).filter(Boolean);
      next = next.filter((t) => !rm.includes(t));
    }
    const changes = [`+${cur.filter((t) => !next.includes(t)).length}`, `-${next.filter((t) => !cur.includes(t)).length}`];
    if (!(await writeGuard(`待办标签「${row.title}」：现 [${cur.join('、')}] → [${next.join('、')}]`, flags))) return;
    const [updated] = await api('PATCH', `todos?id=eq.${encodeURIComponent(row.id)}&select=id,title,tags`, { tags: next });
    await logCli('cli_tag', 'todo', row.id, { title: row.title, content: `标签：[${cur.join('、')}] → [${next.join('、')}]`, type: '待办标签', table: 'todos' });
    output({ updated }, () => console.log(`✅ 标签已更新「${updated.title}」：[${(updated.tags || []).join('、')}]`));
    return;
  }
  if (sub !== 'list') { console.error(`未知子命令：${sub}（支持 list / done / edit / del / tag）`); process.exitCode = 1; return; }

  // A 段口径：查询/过滤/展示改 end_at（取日期部分），todo_date 仍查询带回兜底显示
  // C段 FR-7：apiList 游标分页——--limit/--cursor/--all/--fields，返回 {data,total,has_more,next_cursor}
  const status = typeof flags.status === 'string' ? flags.status : null;
  let extra = '';
  if (status) extra += `&status=eq.${status}`;
  // 3f5bbb17 修复：+08:00 裸拼会被网关解码为空格 → PG invalid timestamp 400。
  // 方案与 L850 schedule today 先例一致：%2B 显式编码北京时间偏移（不依赖库会话时区）。
  if (flags.today) extra += `&end_at=gte.${todayDateStr()}T00:00:00%2B08:00&end_at=lte.${todayDateStr()}T23:59:59%2B08:00`;
  // D1 增强：--cat 分类过滤 / --prio 优先级过滤 / --tag 标签过滤（jsonb cs. 包含）/ --overdue 逾期未完成
  if (typeof flags.cat === 'string') extra += `&category=eq.${encodeURIComponent(flags.cat)}`;
  if (typeof flags.prio === 'string') extra += `&priority=eq.${flags.prio}`;
  if (typeof flags.tag === 'string') extra += `&tags=cs.{${encodeURIComponent(normalizeTag(flags.tag))}}`;
  if (flags.overdue) extra += `&status=eq.pending&end_at=lt.${todayDateStr()}T00:00:00%2B08:00`;
  const list = await apiList('todos', {
    fields: 'id,title,category,priority,status,todo_date,end_at,all_day,completed_at,created_at',
    order: 'created_at.desc,id',
    extra,
    ...pageOpts(flags, 200),
  });
  const rows = list.data;
  const mirrorOnly = rows.filter((r) => r.category === 'AI灵感' || r.category === '开发待办');
  output(list, () => {
    if (!rows.length) { console.log('（无待办）'); return; }
    console.log(`待办共 ${list.total} 条（本页 ${rows.length}${list.has_more ? '，--cursor 续取' : ''}，含镜像 ${mirrorOnly.length} 条）：\n`);
    for (const t of rows) {
      const st = t.status === 'completed' ? '✅' : t.status === 'featured' ? '⭐' : '⬜';
      const mirror = t.category === 'AI灵感' || t.category === '开发待办' ? ' [镜像]' : '';
      const dueDay = String(t.end_at || t.todo_date || '').slice(0, 10);
      const overdue = t.status === 'pending' && dueDay && dueDay < todayDateStr() ? ' ⚠️逾期' : '';
      console.log(`${st} ${t.title}${mirror}${overdue}`);
      console.log(`   id=${t.id}  分类=${t.category}  优先级=${t.priority}${dueDay ? `  日期=${dueDay}` : ''}`);
    }
  });
}

async function cmdIdea(flags, pos) {
  const sub = pos[0] || 'list';
  if (sub === 'add') {
    const { text: raw } = resolveLongInput(flags, pos.slice(1), { label: 'idea 原文' }); // P1 FR-3 长输入
    if (!raw) { console.error('用法: idea add <点子原文> [--title "标题"] [--content-file md] [--stdin] [--yes] [--idempotency-key key]'); process.exitCode = 1; return; }
    return dispatchAdd('idea', { _raw: raw, title: typeof flags.title === 'string' ? flags.title : raw.slice(0, 30), reason: '（idea add 直录）' }, flags, raw);
  }
  if (sub === 'edit') {
    // 用法: idea edit <id> [--title "..."] [--one-liner "..."] [--status 待评估|孵化中|已落地|放弃] [--yes]
    const id = pos[1];
    if (!id || (!flags.title && !flags['one-liner'] && !flags.status)) {
      console.error('用法: idea edit <id> [--title "..."] [--one-liner "..."] [--status 待评估|孵化中|已落地|放弃] [--yes]');
      process.exitCode = 1; return;
    }
    const row = await findByIdPrefix('ai_ideas', id, 'id,title,one_liner,status');
    const patch = {};
    if (typeof flags.title === 'string') patch.title = flags.title.trim();
    if (typeof flags['one-liner'] === 'string') patch.one_liner = flags['one-liner'].trim();
    if (typeof flags.status === 'string') patch.status = flags.status.trim();
    const changes = Object.entries(patch).map(([k, v]) => `${k}→${v}`).join('，');
    if (!(await writeGuard(`点子修改「${row.title || '(无标题)'}」：${changes}`, flags))) return;
    const [updated] = await api('PATCH', `ai_ideas?id=eq.${encodeURIComponent(row.id)}&select=*`, patch);
    await logCli('cli_edit', 'ai', row.id, { title: row.title, content: `变更：${changes}`, type: 'idea', table: 'ai_ideas' });
    output({ updated }, () => console.log(`✅ 已修改点子「${updated.title || '(无标题)'}」（id=${updated.id}，status=${updated.status}）`));
    return;
  }
  if (sub === 'done') {
    // 点子落地：ai_ideas.status=已落地 + 镜像 todos 标完成
    const id = pos[1];
    if (!id) { console.error('用法: idea done <id> [--yes]'); process.exitCode = 1; return; }
    const row = await findByIdPrefix('ai_ideas', id, 'id,title,status,todo_id');
    if (!(await writeGuard(`点子标已落地：「${row.title || '(无标题)'}」（${row.id}）${row.todo_id ? `，镜像待办 ${row.todo_id} 同步完成` : ''}`, flags))) return;
    const now = new Date().toISOString();
    const [updated] = await api('PATCH', `ai_ideas?id=eq.${encodeURIComponent(row.id)}&select=*`, { status: '已落地' });
    let mirrorDone = null;
    if (row.todo_id) {
      await api('PATCH', `todos?id=eq.${encodeURIComponent(row.todo_id)}`, { status: 'completed', completed_at: now });
      mirrorDone = row.todo_id;
    }
    await logCli('cli_done', 'ai', row.id, { title: row.title, content: `点子标已落地${mirrorDone ? `（镜像待办 ${mirrorDone} 同步完成）` : '（无镜像待办）'}`, type: 'idea', table: 'ai_ideas' });
    output({ updated, mirrorDone }, () => console.log(`✅ 点子已落地：「${updated.title}」（id=${updated.id}${mirrorDone ? `，镜像待办已完成` : ''}）`));
    return;
  }
  // list（默认）
  let q = 'ai_ideas?select=id,title,one_liner,status,created_at&order=created_at.desc&limit=100';
  if (typeof flags.status === 'string') q += `&status=eq.${encodeURIComponent(flags.status)}`;
  const rows = await api('GET', q);
  output({ count: rows.length, ideas: rows }, () => {
    if (!rows.length) { console.log('（无点子）'); return; }
    console.log(`AI 点子共 ${rows.length} 条：\n`);
    for (const i of rows) {
      console.log(`💡 [${i.status}] ${i.title || '(无标题)'}`);
      if (i.one_liner) console.log(`   ${i.one_liner}`);
      console.log(`   id=${i.id}`);
    }
  });
}

async function cmdBug(flags) {
  // C段 FR-7：apiList 游标分页——--limit/--cursor/--all/--fields
  let extra = '';
  if (flags.open) extra += '&status=neq.fixed';
  if (typeof flags.status === 'string') extra += `&status=eq.${encodeURIComponent(flags.status)}`;
  if (typeof flags.module === 'string') extra += `&module=eq.${encodeURIComponent(flags.module)}`;
  const list = await apiList('ai_bugs', {
    fields: 'id,title,kind,module,severity,status,source,created_at',
    order: 'created_at.desc,id',
    extra,
    ...pageOpts(flags, 200),
  });
  const rows = list.data;
  output(list, () => {
    if (!rows.length) { console.log('（无开发待办）'); return; }
    console.log(`开发待办共 ${list.total} 条（本页 ${rows.length}${list.has_more ? '，--cursor 续取' : ''}）：\n`);
    for (const b of rows) {
      const kind = b.kind === 'opt' ? '优化' : 'Bug ';
      const st = b.status === 'fixed' ? '已修复' : b.status === 'open' ? '待开发' : b.status;
      console.log(`[${kind}] [${st}] ${b.title}`);
      console.log(`   id=${b.id}  module=${b.module || '(空)'}  severity=${b.severity}  source=${b.source || 'manual'}`);
    }
  });
}

/* ============================================================
 * schedule 命令组（D1 · 11caa4ef：today/add/done）
 * ============================================================ */

async function cmdSchedule(flags, pos) {
  const sub = pos[0] || 'today';
  if (sub === 'today') {
    const t = todayDateStr();
    const tm = tomorrowDateStr();
    // 北京时区当日窗口（+08:00 偏移需 URL 转义，防 UTC 边界漏单）
    const dayStart = `${t}T00:00:00%2B08:00`;
    const dayEnd = `${tm}T00:00:00%2B08:00`;
    const rows = await api('GET', `schedules?select=id,title,content,start_at,end_at,location,is_done&start_at=gte.${dayStart}&start_at=lt.${dayEnd}&order=start_at.asc&limit=50`);
    output({ date: t, count: rows.length, schedules: rows }, () => {
      if (!rows.length) { console.log(`（${t} 无日程）`); return; }
      console.log(`今日日程（${t}）${rows.length} 条：\n`);
      for (const s of rows) {
        const st = s.is_done ? '✅' : '📅';
        const time = s.start_at ? String(s.start_at).slice(11, 16) : '（无时间）';
        console.log(`${st} ${time} ${s.title}${s.location ? ` @${s.location}` : ''}`);
        console.log(`   id=${s.id}${s.end_at ? `  至 ${String(s.end_at).slice(11, 16)}` : ''}`);
      }
    });
    return;
  }
  if (sub === 'add') {
    const { text: raw } = resolveLongInput(flags, pos.slice(1), { label: 'schedule 文本' }); // P1 FR-3 长输入
    if (!raw) { console.error('用法: schedule add <自然语言日程> [--at "2026-08-27 15:00"] [--loc 地点] [--content-file md] [--stdin] [--yes] [--idempotency-key key]'); process.exitCode = 1; return; }
    const c = { _raw: raw, title: raw.replace(/^(日程[:：]?)?/, '').slice(0, 40), scheduleTime: raw, reason: '（schedule add 直录）' };
    if (typeof flags.at === 'string') {
      // --at 显式时间：YYYY-MM-DD HH:mm
      const m = flags.at.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/);
      if (!m) { console.error('❌ --at 需 "YYYY-MM-DD HH:mm" 格式'); process.exitCode = 1; return; }
      c.start_at = new Date(`${m[1]}T${String(m[2]).padStart(2, '0')}:${m[3]}:00+08:00`).toISOString();
      c.end_at = new Date(new Date(c.start_at).getTime() + 3600000).toISOString();
    }
    if (typeof flags.loc === 'string') c.location = flags.loc;
    return dispatchAdd('schedule', c, flags, raw);
  }
  if (sub === 'done') {
    const id = pos[1];
    if (!id) { console.error('用法: schedule done <id> [--yes]'); process.exitCode = 1; return; }
    const row = await findByIdPrefix('schedules', id, 'id,title,start_at');
    if (!(await writeGuard(`日程标完成：「${row.title}」（${row.id}）`, flags))) return;
    const [updated] = await api('PATCH', `schedules?id=eq.${encodeURIComponent(row.id)}&select=*`, { is_done: true });
    await logCli('cli_done', 'schedule', row.id, { title: row.title, type: '日程完成', table: 'schedules' });
    output({ updated }, () => console.log(`✅ 日程已完成：「${updated.title}」（id=${updated.id}）`));
    return;
  }
  if (sub === 'list') {
    let q = 'schedules?select=id,title,start_at,end_at,location,is_done&order=start_at.desc&limit=50';
    if (typeof flags.since === 'string') q += `&start_at=gte.${flags.since}`;
    const rows = await api('GET', q);
    output({ count: rows.length, schedules: rows }, () => {
      if (!rows.length) { console.log('（无日程）'); return; }
      console.log(`日程最近 ${rows.length} 条：\n`);
      for (const s of rows) {
        const st = s.is_done ? '✅' : '📅';
        console.log(`${st} ${String(s.start_at || '').slice(0, 16).replace('T', ' ')} ${s.title}${s.location ? ` @${s.location}` : ''}`);
        console.log(`   id=${s.id}`);
      }
    });
    return;
  }
  console.error(`未知子命令：${sub}（支持 today / add / done / list）`);
  process.exitCode = 1;
}

async function cmdCapsule(flags, pos) {
  const sub = pos[0] || 'list';
  if (sub === 'search') {
    // Flomo memo_search 对标：关键词 + 标签 + 时间范围检索
    const kw = pos.slice(1).join(' ').trim();
    if (!kw && !flags.tag && !flags.since) { console.error('用法: capsule search [关键词] [--tag 标签] [--since YYYY-MM-DD] [--until YYYY-MM-DD]'); process.exitCode = 1; return; }
    let q = 'capsules?select=id,title,content,category,tags,created_at&order=created_at.desc&limit=50';
    if (kw) q += `&or=(content.ilike.*${encodeURIComponent(kw)}*,title.ilike.*${encodeURIComponent(kw)}*)`;
    if (typeof flags.tag === 'string') q += `&tags=cs.{${encodeURIComponent(normalizeTag(flags.tag))}}`;
    if (typeof flags.since === 'string') q += `&created_at=gte.${flags.since}`;
    if (typeof flags.until === 'string') q += `&created_at=lt.${flags.until}`;
    const rows = await api('GET', q);
    output({ keyword: kw || null, tag: flags.tag || null, count: rows.length, capsules: rows }, () => {
      if (!rows.length) { console.log('（无命中）'); return; }
      console.log(`闪念检索命中 ${rows.length} 条：\n`);
      for (const c of rows) {
        const tags = Array.isArray(c.tags) && c.tags.length ? `  #${c.tags.join(' #')}` : '';
        console.log(`💫 [${c.category}] ${(c.title || c.content || '').slice(0, 40)}${tags}`);
        console.log(`   ${(c.content || '').slice(0, 80)}${(c.content || '').length > 80 ? '…' : ''}`);
        console.log(`   id=${c.id}  ${String(c.created_at).slice(0, 10)}`);
      }
    });
    return;
  }
  if (sub === 'tag') {
    // Flomo tag_tree / tag_rename 对标
    const id = pos[1];
    if (!id && !flags.rename) {
      // 无 id：列出全库标签频次树
      const rows = await api('GET', 'capsules?select=tags&limit=2000');
      const freq = new Map();
      for (const r of rows) {
        for (const t of (Array.isArray(r.tags) ? r.tags : [])) freq.set(t, (freq.get(t) || 0) + 1);
      }
      const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
      output({ count: sorted.length, tags: sorted.map(([t, n]) => ({ tag: t, count: n })) }, () => {
        if (!sorted.length) { console.log('（全库无标签）'); return; }
        console.log(`胶囊标签树（${sorted.length} 个，按频次）：\n`);
        for (const [t, n] of sorted) console.log(`  #${t}  ×${n}`);
      });
      return;
    }
    if (flags.rename) {
      // 标签改名：批量更新所有含旧标签的胶囊
      if (typeof flags.rename !== 'string' || !flags.to) { console.error('用法: capsule tag --rename 旧标签 --to 新标签 [--yes]'); process.exitCode = 1; return; }
      const from = normalizeTag(flags.rename);
      const to = normalizeTag(String(flags.to));
      const rows = await api('GET', `capsules?select=id,tags&tags=cs.{${encodeURIComponent(from)}}&limit=500`);
      if (!rows.length) { console.log(`标签 #${from} 无关联胶囊，无需改名`); return; }
      if (!(await writeGuard(`标签改名 #${from} → #${to}（将更新 ${rows.length} 条胶囊）`, flags))) return;
      let n = 0;
      for (const r of rows) {
        const next = (Array.isArray(r.tags) ? r.tags : []).map((t) => (t === from ? to : t)).filter((t, i, a) => a.indexOf(t) === i);
        await api('PATCH', `capsules?id=eq.${encodeURIComponent(r.id)}`, { tags: next });
        n++;
      }
      await logCli('cli_tag', 'capsule', null, { title: `标签改名 #${from} → #${to}`, content: `批量更新 ${n} 条胶囊标签`, type: '标签改名', table: 'capsules' });
      output({ renamed: from, to, updated: n }, () => console.log(`✅ 标签已改名 #${from} → #${to}，更新 ${n} 条胶囊`));
      return;
    }
    // capsule tag <id> --add a,b | --del a,b
    if (!flags.add && !flags.del) { console.error('用法: capsule tag <id> --add 标签1[,标签2] | --del 标签1[,标签2] [--yes]；或 capsule tag [--rename 旧 --to 新]'); process.exitCode = 1; return; }
    const row = await findByIdPrefix('capsules', id, 'id,title,content,tags');
    const cur = Array.isArray(row.tags) ? [...row.tags] : [];
    let next = [...cur]; // 🔴 浅拷贝（同 todo tag：否则回显「现→改」同一数组）
    if (typeof flags.add === 'string') {
      for (const t of flags.add.split(/[,，]/).map(normalizeTag).filter(Boolean)) if (!next.includes(t)) next.push(t);
    }
    if (typeof flags.del === 'string') {
      const rm = flags.del.split(/[,，]/).map(normalizeTag).filter(Boolean);
      next = next.filter((t) => !rm.includes(t));
    }
    if (!(await writeGuard(`胶囊标签「${(row.title || row.content || '').slice(0, 30)}」：现 [${cur.join('、')}] → [${next.join('、')}]`, flags))) return;
    const [updated] = await api('PATCH', `capsules?id=eq.${encodeURIComponent(row.id)}&select=id,title,tags`, { tags: next });
    await logCli('cli_tag', 'capsule', row.id, { title: (row.title || row.content || '').slice(0, 30), content: `标签：[${cur.join('、')}] → [${next.join('、')}]`, type: '胶囊标签', table: 'capsules' });
    output({ updated }, () => console.log(`✅ 标签已更新：[${(updated.tags || []).join('、')}]（id=${updated.id}）`));
    return;
  }
  // list（默认）——C段 FR-7：apiList 游标分页
  let extra = '';
  if (typeof flags.category === 'string') extra += `&category=eq.${encodeURIComponent(flags.category)}`;
  if (typeof flags.tag === 'string') extra += `&tags=cs.{${encodeURIComponent(normalizeTag(flags.tag))}}`;
  const list = await apiList('capsules', {
    fields: 'id,title,content,category,tags,created_at',
    order: 'created_at.desc,id',
    extra,
    ...pageOpts(flags, 20),
  });
  const rows = list.data;
  output(list, () => {
    if (!rows.length) { console.log('（无闪念）'); return; }
    console.log(`闪念共 ${list.total} 条（本页 ${rows.length}${list.has_more ? '，--cursor 续取' : ''}）：\n`);
    for (const c of rows) {
      const tags = Array.isArray(c.tags) && c.tags.length ? `  #${c.tags.join(' #')}` : '';
      console.log(`💫 [${c.category}] ${(c.title || c.content || '').slice(0, 40)}${tags}`);
      console.log(`   ${(c.content || '').slice(0, 60)}${(c.content || '').length > 60 ? '…' : ''}`);
      console.log(`   id=${c.id}  ${String(c.created_at).slice(0, 10)}`);
    }
  });
}

async function cmdBook(flags) {
  // C段 FR-7：apiList 游标分页
  const list = await apiList('books', {
    fields: 'id,title,format,status,progress,file_size,updated_at',
    order: 'updated_at.desc,id',
    ...pageOpts(flags, 200),
  });
  const rows = list.data;
  output(list, () => {
    if (!rows.length) { console.log('（书架为空）'); return; }
    console.log(`书架共 ${list.total} 本（本页 ${rows.length}${list.has_more ? '，--cursor 续取' : ''}）：\n`);
    for (const b of rows) {
      const sizeMb = b.file_size ? `${(b.file_size / 1024 / 1024).toFixed(1)}MB` : '';
      const local = String(b.file_path || '').startsWith('local:') ? ' ⚠️未上云' : '';
      console.log(`📚 [${b.format}] ${b.title}（${b.status}，进度 ${(b.progress * 100).toFixed(0)}%）${sizeMb}${local}`);
      console.log(`   id=${b.id}`);
    }
  });
}

/* search 命令已外移 lib/wb-cli/cmd-search-all.mjs（三期 A 段 · dt_dod7ui）：
 * - 默认跨核心 6 表保持现状兼容；--table 白名单扩容至全部业务表；--domain 按域检索。
 * - 旧 SEARCH_TABLES 常量语义移入 shared.mjs 的 SEARCH_CORE_TABLES。 */

/* ============================================================
 * fill：预置提示词模板
 * ============================================================ */

async function cmdFill(flags, pos) {
  const name = pos[0];
  if (!name || !FILL_ALIASES[name]) {
    console.log('可用模板：');
    for (const [k, v] of Object.entries(FILL_TEMPLATES)) console.log(`  fill ${k.padEnd(6)} —— ${v.desc}`);
    if (name) console.log(`\n（未知模板「${name}」，支持别名：${Object.keys(FILL_ALIASES).join(' / ')}）`);
    return;
  }
  const tpl = FILL_TEMPLATES[FILL_ALIASES[name]];
  const todayStr = todayDateStr();

  // 聚合素材（日报/周报：近期待办+日程；点子复盘：待评估点子）
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const [completedTodos, pendingTodos, schedules, pendingIdeas, openBugs] = await Promise.all([
    api('GET', `todos?select=id,title,category,todo_date,end_at,completed_at&status=eq.completed&completed_at=gte.${weekAgo}&order=completed_at.desc&limit=20`).catch(() => []),
    api('GET', 'todos?select=id,title,category,todo_date,end_at&status=eq.pending&order=created_at.desc&limit=30').catch(() => []),
    api('GET', `schedules?select=id,title,start_at,end_at,location&start_at=gte.${new Date(Date.now() - 86400000).toISOString()}&order=start_at.asc&limit=20`).catch(() => []),
    api('GET', `ai_ideas?select=id,title,one_liner,raw_input&status=eq.${encodeURIComponent('待评估')}&order=created_at.desc&limit=20`).catch(() => []),
    api('GET', 'ai_bugs?select=id,title,kind,module,status&status=neq.fixed&order=created_at.desc&limit=30').catch(() => []),
  ]);

  const text = tpl.build({ todayStr, completedTodos, pendingTodos, schedules, pendingIdeas, openBugs });
  output({ template: FILL_ALIASES[name], text }, () => console.log(text));

  // 非 --json 时可选落盘
  if (typeof flags.out === 'string') {
    writeFileSync(resolve(ROOT, flags.out), text, 'utf8');
    console.error(`\n✅ 已落盘 → ${flags.out}`);
  }
}

/* ============================================================
 * 开发任务全流程衔接（dev_tasks 表 · PRD+TDD v1.0 · 20260828c）
 * 九步链 S0-S8，WorkBuddy 侧唯一回写通道。
 * 流程铁律（ai-workbench-workflow / ai-task-acceptance skill）：
 *   每完成一步（PRD/TDD/任务包/HANDOFF/发布），必须
 *   wb-cli dev-task stage <id> <key> --status done --file <产物> 回写。
 * ============================================================ */

const DEV_STAGES = [
  { stage: 0, key: 'brief', name: '需求收集' },
  { stage: 1, key: 'prd', name: 'PRD' },
  { stage: 2, key: 'tdd', name: '技术方案' },
  { stage: 3, key: 'wbs', name: '任务包' },
  { stage: 4, key: 'dev', name: '开发' },
  { stage: 5, key: 'handoff', name: 'HANDOFF' },
  { stage: 6, key: 'release', name: '验收发布' },
  { stage: 7, key: 'test', name: '人工测试' },
  { stage: 8, key: 'wrap', name: '总结沉淀' },
];

function freshDevStages() {
  const now = new Date().toISOString();
  // A6（id 1b833f54）：新建任务预置 S6 六子步 + S7 四项标准清单（与前端 freshStages 同口径）
  const RELEASE_PRESET = [
    'publish-check 发布前检查', '合并 main', '构建', '部署', '冒烟验证', '收尾（HANDOFF/日志）',
  ];
  const TEST_PRESET = ['桌面功能点检', '移动端适配', '冒烟主流程', '数据回写核对'];
  return DEV_STAGES.map((s) => ({
    ...s,
    status: 'pending',
    artifact_type: null,
    artifact_content: null,
    artifact_url: null,
    items: s.key === 'release'
      ? RELEASE_PRESET.map((title) => ({ title, status: 'pending', note: '' }))
      : s.key === 'test'
        ? TEST_PRESET.map((title) => ({ title, status: 'pending', note: '' }))
        : [],
    note: '',
    updated_at: null,
    _now: now,
  })).map(({ _now, ...s }) => s);
}

async function patchDevTask(id, row) {
  return api('PATCH', `dev_tasks?id=eq.${encodeURIComponent(id)}`, {
    ...row,
    updated_at: new Date().toISOString(),
  });
}

async function cmdDevTask(flags, pos) {
  const sub = String(pos[0] || '').toLowerCase();
  const rest = pos.slice(1);

  if (sub === 'create') {
    const title = flags.title;
    if (!title) throw new Error('--title 必填');
    const bugIds = String(flags.bugs || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!bugIds.length) throw new Error('--bugs 必填（ai_bugs id 或前缀，逗号分隔）');
    if (!(await writeGuard(`新建开发任务「${title}」（关联 ${bugIds.length} 条待办，S0 需求汇总自动生成）`, flags))) return;
    const bugs = [];
    for (const b of bugIds) {
      bugs.push(await findByIdPrefix('ai_bugs', b, 'id,title,description,module,kind,severity,status'));
    }
    const id = 'dt_' + Math.random().toString(36).slice(2, 8);
    const now = new Date().toISOString();
    const stages = freshDevStages();
    const briefMd = [
      `# 需求收集 · ${title}`,
      '',
      `> 生成：${now} · 关联开发待办 ${bugs.length} 条（AI 工作台「新建开发任务」）`,
      '',
      ...bugs.flatMap((b, i) => [
        `## ${i + 1}. ${b.title}`,
        `- id：\`${b.id}\``,
        `- 模块：${b.module || '-'} · 类型：${b.kind || 'bug'} · 级别：${b.severity || '-'} · 状态：${b.status || '-'}`,
        `- 描述：${String(b.description || '').trim() || '（无）'}`,
        '',
      ]),
    ].join('\n');
    stages[0] = { ...stages[0], status: 'done', artifact_type: 'md', artifact_content: briefMd, updated_at: now };
    const rows = await api('POST', 'dev_tasks', { id, title, status: 'active', current_stage: 0, source_bug_ids: bugs.map((b) => b.id), stages });
    const row = Array.isArray(rows) ? rows[0] : { id, title };
    await logCli('create', 'ai', row.id, { title: `新建开发任务 ${title}`, content: `关联待办 ${bugs.length} 条，九步链启动` });
    output(row, () => console.log(`✅ 开发任务已创建：${row.id}「${title}」（S0 需求汇总已生成，${bugs.length} 条待办）`));
    return;
  }

  if (sub === 'list') {
    // A段 FR-1：--search/--status 过滤落地（此前 flag 被静默吞恒返全量）
    // C段 FR-7：迁移到 apiList 游标分页——--limit/--cursor/--all/--fields
    let extra = '';
    if (typeof flags.search === 'string' && flags.search.trim()) extra += `&title=ilike.*${encodeURIComponent(flags.search.trim())}*`;
    if (typeof flags.status === 'string' && flags.status) extra += `&status=eq.${encodeURIComponent(flags.status)}`;
    const list = await apiList('dev_tasks', {
      fields: 'id,title,status,current_stage,source_bug_ids,updated_at',
      order: 'created_at.desc,id',
      extra,
      ...pageOpts(flags, 100),
    });
    const rows = list.data;
    output(list, () => {
      if (!rows.length) { console.log('（暂无开发任务）'); return; }
      console.log(`开发任务共 ${list.total} 条（本页 ${rows.length}${list.has_more ? '，--cursor 续取' : ''}）：`);
      for (const r of rows) {
        console.log(`  ${r.id}  ${r.title}  第${r.current_stage + 1}/9步  ${r.status}  ${String(r.updated_at || '').slice(0, 16)}`);
      }
    });
    return;
  }

  if (sub === 'show') {
    const task = await findByIdPrefix('dev_tasks', rest[0]);
    output(task, () => {
      console.log(`◆ ${task.id}「${task.title}」 status=${task.status} 最远到达=S${task.current_stage}`);
      console.log(`  关联待办：${(task.source_bug_ids || []).join(', ')}`);
      for (const s of task.stages || []) {
        const mark = s.status === 'done' ? '✅' : s.status === 'running' ? '⏳' : '⬜';
        console.log(`  ${mark} S${s.stage} ${s.name}（${s.key}）${s.artifact_url ? ' → ' + s.artifact_url : ''}${s.note ? ' · ' + s.note : ''}`);
      }
      const brief = (task.stages || []).find((s) => s.key === 'brief');
      if (brief && brief.artifact_content) {
        console.log('\n---------- S0 需求汇总 ----------\n');
        console.log(brief.artifact_content);
      }
    });
    return;
  }

  if (sub === 'stage') {
    const [idp, key] = rest;
    const st = DEV_STAGES.find((s) => s.key === key);
    if (!st) throw new Error(`未知步骤 key：${key}（可选：${DEV_STAGES.map((s) => s.key).join('/')}）`);
    const status = String(flags.status || 'done');
    if (!['running', 'done'].includes(status)) throw new Error('--status 仅支持 running|done');

    /* 条目清单：--items <md文件>，每行一条（`- [ ] xxx` / `- xxx` / 裸行均可），
     * 解析后写入该 stage 的 items，供前端逐条打勾（S4 任务包条目 / S7 测试清单）。 */
    let parsedItems = null;
    if (typeof flags.items === 'string') {
      const ip = resolve(flags.items);
      if (!existsSync(ip)) throw new Error(`条目文件不存在：${ip}`);
      const lines = readFileSync(ip, 'utf8')
        .split('\n')
        .map((l) => l.replace(/^\s*[-*+]\s*\[[ xX]?\]\s*/, '').replace(/^\s*[-*+]\s+/, '').replace(/^\s*\d+[.、)]\s*/, '').trim())
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('>'));
      if (!lines.length) throw new Error(`条目文件无有效条目：${ip}`);
      parsedItems = lines.map((title) => ({ title, status: 'pending', note: '' }));
    }

    const task = await findByIdPrefix('dev_tasks', idp);
    const guardMsg = `开发任务 ${task.id}「${task.title}」 S${st.stage} ${st.name} → ${status}`
      + (parsedItems ? `（写入 ${parsedItems.length} 条清单条目）` : '');
    if (!(await writeGuard(guardMsg, flags))) return;

    let content = null;
    let url = typeof flags.url === 'string' ? flags.url : null;
    let type = typeof flags.kind === 'string' ? flags.kind : null;
    if (typeof flags.file === 'string') {
      const abs = resolve(flags.file);
      if (!existsSync(abs)) throw new Error(`文件不存在：${abs}`);
      content = readFileSync(abs, 'utf8');
      type = type || (/\.html?$/i.test(abs) ? 'html' : 'md');
      if (type === 'html') {
        try {
          const { execFileSync } = await import('node:child_process');
          execFileSync(
            process.execPath,
            [resolve(ROOT, 'scripts/sync-html-artifacts.js'), abs, '--title', String(flags.title || `开发任务 ${task.id} · ${st.name}`)],
            { stdio: 'pipe' },
          );
          url = `https://liflow.cn/gallery/${encodeURIComponent(basename(abs))}`;
        } catch (e) {
          console.error(`ℹ️ 产物域归档跳过（不阻断回写）：${String(e.message || e).slice(0, 120)}`);
        }
        if (content.length > 20000) content = content.slice(0, 20000) + '\n<!-- 已截断，全文见 artifact_url -->';
      } else if (content.length > 100000) {
        content = content.slice(0, 100000) + '\n<!-- 已截断 -->';
      }

      /* wbs 自动分段（20260829）：key=wbs、md 产物、未显式 --items 时，解析「## 任务包 X」
       * 分段 → S4 items（每段一条，note=N 文件）。口径同 check-split.mjs / 前端 parseTaskPackages。
       * 前端 S4 每条「生成提示词」即派单给并行 WorkBuddy session。 */
      if (key === 'wbs' && !parsedItems && type === 'md') {
        const pkgs = [];
        let cur = null;
        let inFiles = false;
        let blanks = 0;
        for (const line of content.split(/\r?\n/)) {
          if (/^##\s*任务包/.test(line)) {
            cur = { title: line.replace(/^##\s*/, '').trim(), files: new Set() };
            pkgs.push(cur);
            inFiles = false;
            blanks = 0;
            continue;
          }
          if (!cur) continue;
          if (/^#\s/.test(line)) { inFiles = false; continue; }
          if (/涉及文件/.test(line)) {
            inFiles = true;
            blanks = 0;
            for (const m of line.matchAll(/(?:components|lib|app|scripts|public|cloudbase|supabase|pipeline|assets|types|styles|pages|migrations)\/[^\s、`'")\]]+|\b[A-Za-z0-9_.\/-]+\.(?:tsx?|jsx?|css|json|mjs|sql|md|py|sh|plist|cjs|ttf|woff2)\b/g)) cur.files.add(m[0]);
            continue;
          }
          if (inFiles) {
            if (line.trim() === '') {
              blanks += 1;
              if (blanks >= 2) inFiles = false;
              continue;
            }
            blanks = 0;
            for (const m of line.matchAll(/(?:components|lib|app|scripts|public|cloudbase|supabase|pipeline|assets|types|styles|pages|migrations)\/[^\s、`'")\]]+|\b[A-Za-z0-9_.\/-]+\.(?:tsx?|jsx?|css|json|mjs|sql|md|py|sh|plist|cjs|ttf|woff2)\b/g)) cur.files.add(m[0]);
          }
        }
        if (pkgs.length) {
          parsedItems = pkgs.map((p) => ({
            title: p.title,
            status: 'pending',
            note: `任务包 · ${p.files.size} 个文件`,
          }));
        }
      }
    }
    const now = new Date().toISOString();
    const stages = (task.stages && task.stages.length ? task.stages : freshDevStages()).map((s) => {
      if (s.key !== key) {
        // wbs 分段联动：任务包段清单落到 S4(dev) 的 items（前端 S4 打勾 + 生成提示词的载体）
        if (key === 'wbs' && parsedItems && s.key === 'dev') {
          return { ...s, items: parsedItems, updated_at: now };
        }
        return s;
      }
      return {
        ...s,
        status,
        artifact_type: type || s.artifact_type,
        artifact_content: content ?? s.artifact_content,
        artifact_url: url ?? s.artifact_url,
        note: typeof flags.note === 'string' ? flags.note : s.note,
        // S3 自身不放段清单（那是 S4 的）；--items 显式指定时仍写本 stage（S7 checklist 用）
        items: (key === 'wbs' ? null : parsedItems) || s.items,
        updated_at: now,
        // 完成时刻（dt_5cnqx0-F）：status=done 时自动落 done_at（ISO 时间，前端格式化为北京时间 MM-DD HH:mm）
        // 重开（running）时清空，与状态语义对齐；存量数据不回填
        done_at: status === 'done' ? now : null,
      };
    });
    const patchRow = { stages, current_stage: Math.max(task.current_stage || 0, st.stage) };
    if (key === 'wrap' && status === 'done') patchRow.status = 'done';
    const rows = await patchDevTask(task.id, patchRow);
    const updated = Array.isArray(rows) ? rows[0] : null;
    await logCli('update', 'ai', task.id, { title: `S${st.stage} ${st.name} → ${status}`, content: typeof flags.note === 'string' ? flags.note : '' });
    output(updated || { id: task.id, stage: key, status }, () => {
      console.log(`✅ ${task.id} S${st.stage} ${st.name} → ${status}${url ? '\n   产物：' + url : ''}`);
      if (key === 'wrap' && status === 'done') console.log('🎉 开发任务全流程闭环（status=done）');
    });
    return;
  }

  if (sub === 'item') {
    const [idp, key] = rest;
    const task = await findByIdPrefix('dev_tasks', idp);
    const now = new Date().toISOString();
    // --add 追加新条目（修复 802351af：--add 未实现致不落库，2026-08-30）
    if (typeof flags.add === 'string' && flags.add.trim()) {
      const title = flags.add.trim();
      if (!(await writeGuard(`开发任务 ${task.id} 追加条目：${key} += ${title}`, flags))) return;
      const stages = (task.stages || []).map((s) => {
        if (s.key !== key) return s;
        const items = Array.isArray(s.items) ? [...s.items] : [];
        items.push({ title, status: 'pending', note: typeof flags.note === 'string' ? flags.note : null });
        return { ...s, items, updated_at: now };
      });
      const rows = await patchDevTask(task.id, { stages });
      const st = Array.isArray(rows) && rows[0] && Array.isArray(rows[0].stages) ? rows[0].stages.find((x) => x.key === key) : null;
      output(Array.isArray(rows) ? rows[0] : { id: task.id }, () =>
        console.log(`✅ ${task.id} ${key} 追加条目「${title}」（现共 ${st ? st.items.length : '?'} 条）`)
      );
      return;
    }
    const idx = parseInt(flags.index, 10);
    if (!Number.isInteger(idx) || idx < 0) throw new Error('--index 必填（条目序号，0 起）；追加新条目用 --add "文本"');
    if (!(await writeGuard(`开发任务 ${task.id} 条目打勾：S? ${key}[${idx}] → ${flags.status || 'done'}`, flags))) return;
    let stages = (task.stages || []).map((s) => {
      if (s.key !== key) return s;
      const items = Array.isArray(s.items) ? [...s.items] : [];
      if (!items[idx]) throw new Error(`${key} 无第 ${idx} 条（现有 ${items.length} 条）`);
      items[idx] = { ...items[idx], status: String(flags.status || 'done'), note: typeof flags.note === 'string' ? flags.note : items[idx].note };
      return { ...s, items, updated_at: now };
    });
    // A3（id ba2f7c69）：S7 checklist 全勾 → test 阶段自动 done；wrap 也 done → 任务自动闭环（与前端 toggleStageItem 同口径）
    const patch = {};
    const testStage = stages.find((s) => s.key === 'test');
    if (testStage && Array.isArray(testStage.items) && testStage.items.length > 0 && testStage.items.every((i) => i.status === 'done')) {
      stages = stages.map((s) => (s.key === 'test' ? { ...s, status: 'done', updated_at: now, done_at: s.done_at || now } : s));
      const wrapStage = stages.find((s) => s.key === 'wrap');
      if (wrapStage && wrapStage.status === 'done') {
        patch.status = 'done';
        patch.current_stage = 8;
      }
    }
    const rows = await patchDevTask(task.id, { stages, ...patch });
    const updated = Array.isArray(rows) ? rows[0] : null;
    output(updated || { id: task.id, key, idx }, () => {
      console.log(`✅ ${task.id} ${key}[${idx}] → ${flags.status || 'done'}`);
      if (patch.status === 'done') console.log('🎉 S7 全勾且 S8 已完成 → 任务自动闭环（status=done）');
    });
    return;
  }

  throw new Error(`未知子命令：${sub || '(空)'}。用法见 wb-cli dev-task --help 或 usage()`);
}

/* ============================================================
 * 入口
 * ============================================================ */

/* ============================================================
 * 三期 A 段（dt_dod7ui）：registry 壳 + cmd-* 动态注册
 *   - buildRegistry()：createRegistry + loadCmdModules（readdirSync
 *     lib/wb-cli/cmd-*.mjs 逐个 import 注册；启动开销 <50ms 实测）
 *   - CTX：makeCtx 注入 api/logCli/confirm/prompt/output/todayCtx/ROOT
 *   - REGISTRY：usage() 动态聚合各注册命令说明行
 * ============================================================ */

const CTX = makeCtx({ api, apiList, logCli, confirm, prompt, output, todayCtx, ROOT });
let REGISTRY = null;

async function buildRegistry() {
  if (REGISTRY) return REGISTRY;
  const registry = createRegistry();
  await loadCmdModules(registry, CTX);
  return registry;
}

function usage() {
  const regLines = REGISTRY ? REGISTRY.usageLines() : [];
  console.log(`wb-cli —— AI 工作台跨终端 CLI（零依赖，Node ≥18）

用法：
  add <文本>                     全类型录入（AI 自动判类落库）
      [--type 别名] 强制指定：todo/idea/bug/capsule/diary/article/schedule/book
      [--file <路径>] 电子书录入（epub/pdf/txt，力争直传云存储）
      [--yes] 跳过写入确认
  todo list [--status pending|featured|completed] [--today] [--cat 分类] [--prio high|medium|low] [--tag 标签] [--overdue]
  todo done <id前缀> [--yes]
  todo edit <id前缀> [--title "新标题"] [--priority high|medium|low] [--due YYYY-MM-DD] [--category 分类] [--status pending|featured|completed] [--yes]
  todo del <id前缀> [--yes]
  todo tag <id前缀> --add 标签1[,标签2] | --del 标签1[,标签2] [--yes]
  schedule today                 今日日程
  schedule add <自然语言> [--at "YYYY-MM-DD HH:mm"] [--loc 地点] [--yes]
  schedule done <id前缀> [--yes]
  schedule list [--since YYYY-MM-DD]
  capsule list [--limit N] [--category 日记|inbox] [--tag 标签]
  capsule search [关键词] [--tag 标签] [--since 日期] [--until 日期]
  capsule tag                    标签树（全库频次）
  capsule tag <id前缀> --add a,b | --del a,b [--yes]
  capsule tag --rename 旧 --to 新 [--yes]
  idea add <点子原文> [--title 标题] [--yes]
  dev-task list                                    开发任务列表（九步链进度）
  dev-task show <id前缀>                           任务详情（含 S0 需求汇总全文，供流程消费）
  dev-task create --title "标题" --bugs id1,id2 [--yes]   新建开发任务（S0 自动生成）
  dev-task stage <id前缀> <brief|prd|tdd|wbs|dev|handoff|release|test|wrap>
      --status running|done [--file 产物路径] [--kind html|md] [--url 直链] [--note 备注] [--title 产物标题] [--yes]
                                                   步骤回写（html 自动归档产物域；wrap done=任务闭环）
      [--items md文件]                             同步写入该步骤可勾选清单（每行一条，前端逐条打勾）
  dev-task item <id前缀> <key> --index N [--status done] [--note] [--yes]   S4 条目/S7 checklist 打勾
  idea list [--status 待评估|孵化中|已落地|放弃]
  idea edit <id前缀> [--title ...] [--one-liner ...] [--status ...] [--yes]
  idea done <id前缀> [--yes]     标已落地（镜像待办同步完成）
  bug list [--open] [--status open|fixing|fixed|refining] [--module 板块]
  book list
  archive list [--limit 50]                     记忆档案清单（vault 桶 archive/ 前缀）
  archive show <名|path> [--head N]             档案 md 全文（如 archive show 顾铭）
  archive gen [--since YYYY-MM-DD]              生成档案（透传 A 段 profile-gen.mjs）
  archive detect [--days 30] [--json]           近 N 天闪念+决策 × 档案 → 矛盾/关联清单
  fill <日报|周报素材|点子复盘> [--out 文件名]
  key grant <agent> [--scope readonly|readwrite|admin] [--days N] [--note "…"] [--yes]
                                   签发 API Key（明文仅显示一次；需 admin key）
  key list [--json]               API Key 清单（状态/scope/调用量）
  key revoke <agent|id> [--yes]   吊销 API Key（立即生效）
${regLines.length ? '\n命令族（lib/wb-cli/cmd-*.mjs 动态注册）：\n' + regLines.join('\n') : ''}

说明：
  - id 支持前缀匹配（≥4 位唯一命中即可），不必输全 UUID
  - 含 #标签 的文本录入闪念时自动解析标签（对标 flomo hashtag）
  - 写操作均回显确认，--yes 跳过；--json 机器可读输出（jq 可解析）
示例：
  node scripts/wb-cli.mjs add "明天上午10点提醒我与周晨凯对Q3数据"
  node scripts/wb-cli.mjs add "闪念：AI董事会应该有质询环节 #AI治理"
  node scripts/wb-cli.mjs todo list --overdue
  node scripts/wb-cli.mjs capsule search 董事会 --tag AI治理
  node scripts/wb-cli.mjs schedule add "明早9点部门例会" --yes
  node scripts/wb-cli.mjs archive show 顾铭 --head 80
  node scripts/wb-cli.mjs archive detect --days 30`);
}

async function main() {
  const argv = process.argv.slice(2);
  // 全局 --profile 提前剥离（影响 key 解析）
  const profileIdx = argv.indexOf('--profile');
  let profileVal = null;
  if (profileIdx > -1 && argv[profileIdx + 1]) {
    profileVal = argv[profileIdx + 1];
    argv.splice(profileIdx, 2);
  }
  if (profileVal) process.env.WB_PROFILE = profileVal;

  let cmd = argv[0];
  const { flags, pos } = parseArgs(argv.slice(1));
  FLAGS = flags;
  if (flags.lang) setLang(flags.lang);
  warnUnknownFlags(cmd, pos[0], flags);
  // P2 FR-2：<命令> --help 转 help 命令（capabilities 单源渲染）
  if (flags.help && cmd && cmd !== 'help') {
    pos.unshift(cmd);
    cmd = 'help';
  }
  // legacy 模式提示（gateway 模式静默）
  const hint = authHint(auth);
  if (hint) console.error(hint);

  // 三期 A 段：registry 壳调度——lib/wb-cli/cmd-*.mjs 动态注册（B/C/D 段命令族落位于此）
  // 注册器构建失败（模块损坏等）不炸 usage，仅告警降级回 switch。
  try {
    const registry = await buildRegistry();
    REGISTRY = registry;
    if (cmd && registry.has(cmd)) {
      return await registry.dispatch(cmd, flags, pos, CTX);
    }
  } catch (e) {
    console.error(`⚠️ [registry] 命令模块加载降级：${String(e.message || e).slice(0, 160)}`);
  }

  switch (cmd) {
    case 'add': return await cmdAdd(flags, pos);
    case 'todo': return await cmdTodo(flags, pos);
    case 'idea': return await cmdIdea(flags, pos);
    case 'bug': return await cmdBug(flags);
    case 'capsule': return await cmdCapsule(flags, pos);
    case 'schedule': return await cmdSchedule(flags, pos);
    case 'book': return await cmdBook(flags);
    case 'fill': return await cmdFill(flags, pos);
    case 'dev-task': return await cmdDevTask(flags, pos);
    case 'key': return await cmdKey(flags, pos);
    default: usage(); process.exitCode = cmd ? 1 : 0;
  }
}

/* ============================================================
 * key 管理子命令（2026-08-31 方案 A）：经 ai-proxy /v1/keys
 *   key grant <agent> [--scope readonly|readwrite|admin] [--days N] [--note "备注"] [--yes]
 *   key list
 *   key revoke <agent|id> [--yes]
 * 注意：grant/revoke 需 admin key（刘总本人的 workbuddy key 为 admin scope）。
 * 新签发的 key 明文只显示一次，请立即写入 ~/.workbuddy/agents/<agent>.env
 * ============================================================ */

async function keysFetch(path, method = 'GET', body) {
  // key 管理永远走 gateway（legacy 模式无 Bearer key，明确报错）
  const a = resolveAuth({});
  if (a.mode !== 'gateway') {
    throw new Error('key 管理需要 admin API Key（先配置 ~/.workbuddy/agents/workbuddy.env 的 WB_API_KEY）');
  }
  const res = await fetch(`${GATEWAY_BASE.replace(/\/v1\/rest$/, '')}/v1/keys/${path}`, {
    method,
    headers: { Authorization: `Bearer ${a.key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`keys/${path} → ${res.status}: ${(j?.message || text).slice(0, 200)}`);
  return j;
}

async function cmdKey(flags, pos) {
  const sub = pos[0];
  if (sub === 'grant') {
    const agent = pos[1];
    if (!agent) { console.error('用法：key grant <agent名> [--scope ...] [--days N] [--note "…"] [--yes]'); process.exitCode = 1; return; }
    const scope = ['readonly', 'readwrite', 'admin'].includes(flags.scope) ? flags.scope : 'readonly';
    const days = Number(flags.days) > 0 ? Number(flags.days) : null;
    console.log(`将签发 API Key：agent=${agent} scope=${scope}${days ? ` 有效期${days}天` : ' 永久'}${flags.note ? ` 备注：${flags.note}` : ''}`);
    if (!flags.yes) {
      const ok = await confirm('确认签发？');
      if (!ok) { console.log('已取消'); return; }
    }
    const r = await keysFetch('grant', 'POST', { agent, scope, expiresDays: days, note: flags.note || '' });
    console.log('✅ 签发成功（明文仅此一次显示）：\n');
    console.log(`  ${r.key}\n`);
    console.log(`写入 agent 侧：echo 'WB_API_KEY=${r.key}' > ~/.workbuddy/agents/${agent}.env && chmod 600 ~/.workbuddy/agents/${agent}.env`);
    return;
  }
  if (sub === 'list') {
    const r = await keysFetch('list');
    if (flags.json) return output(r.keys);
    if (!r.keys.length) { console.log('（无 key）'); return; }
    for (const k of r.keys) {
      const status = k.revoked_at ? '⛔已吊销' : (k.expires_at && new Date(k.expires_at) < new Date() ? '⏰已过期' : '✅活跃');
      const used = k.last_used_at ? new Date(k.last_used_at).toLocaleString('zh-CN', { hour12: false }) : '从未';
      console.log(`${status} ${String(k.agent_name).padEnd(12)} ${String(k.scope).padEnd(10)} ${k.key_prefix}… 调用${String(k.request_count).padStart(6)}次 末次:${used}${k.note ? `  # ${k.note}` : ''}`);
    }
    return;
  }
  if (sub === 'revoke') {
    const target = pos[1];
    if (!target) { console.error('用法：key revoke <agent名|id>'); process.exitCode = 1; return; }
    const body = /^[0-9a-f-]{36}$/i.test(target) ? { id: target } : { agent: target };
    if (!flags.yes) {
      const ok = await confirm(`确认吊销 ${target} 的 API Key？（立即生效）`);
      if (!ok) { console.log('已取消'); return; }
    }
    const r = await keysFetch('revoke', 'POST', body);
    console.log(`✅ 已吊销 ${r.revoked} 把 key`);
    return;
  }
  console.error('用法：key grant|list|revoke（详见 wb-cli 不带参数的 usage）');
  process.exitCode = 1;
}


main().catch((e) => {
  // A段 FR-2：退出码分级 0成功/2业务/3网络；--json 时失败信封走 stdout（数据非诊断），wb-mcp isError 路径消费
  const cls = classifyError(e);
  withCode(e, cls.code || (cls.kind === 'net' ? 'NETWORK' : 'ERROR'), { retryable: cls.kind === 'net' });
  if (FLAGS.json) console.log(JSON.stringify(envelopeErr(e), null, 2));
  else console.error('❌', e.message);
  process.exitCode = cls.kind === 'net' ? EXIT.NET : EXIT.BIZ;
});

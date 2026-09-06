#!/usr/bin/env node
/**
 * wb-cli fin 财务命令族（任务包 B · dt_dod7ui · 2026-09-04）
 * ------------------------------------------------------------
 * 子命令：
 *   fin add "<自然语言>" [--date] [--account]   AI（百炼）/降级（正则）记账
 *   fin list [--month] [--cat] [--dir] [--account] [--limit]
 *   fin summary [--month|--since --until] [--cat]
 *   fin stat --month                            汇总+日均支出
 *   fin top [--month] [--n]                     支出 Top N
 *   fin account list / fin cat list / fin batch list
 *
 * 契约（TDD §1.1/§2.3）：
 *   - 经注册器调用：handler(flags, pos, ctx)，ctx 注入 { api, bailianKey, ... }
 *     （A 段 shared 公共层；本文件不 import wb-cli.mjs 主文件）
 *   - 独立自举：node lib/wb-cli/cmd-fin.mjs fin add "..." —— 自建 ctx（makeApi +
 *     本地 bailianKey 降级链），A 段未合并时亦可单独验收。
 *   - 写操作回显字段卡确认 + --yes 跳过；logCli(module='finance', action=fin_add)。
 *   - 全部支持 --json 机器可读输出。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve as pResolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  FIN_TABLES, TX_LIST_FIELDS, CATEGORY_SYNONYMS, INCOME_WORDS, SELF_TRANSFER_WORDS,
  AMOUNT_WITH_UNIT, AMOUNT_BARE, ACCOUNT_KEYWORDS,
  ACCOUNT_FIELDS, CATEGORY_FIELDS, BATCH_FIELDS,
} from './fin-fields.mjs';

export const command = 'fin';

export const usageLines = [
  '  fin add "<自然语言记账>" [--date YYYY-MM-DD] [--account 账户名/号] [--yes]   AI/降级记账',
  '  fin list [--month 2026-09] [--cat 餐饮] [--dir expense|income|neutral] [--account X] [--limit 20]',
  '  fin summary [--month 2026-09 | --since 2026-08-01 --until 2026-08-31] [--cat 餐饮]   汇总/分类小计',
  '  fin stat --month 2026-09                     汇总 + 日均支出',
  '  fin top [--month 2026-09] [--n 10]           支出金额 Top N',
  '  fin account list                             账户清单',
  '  fin cat list                                 分类树（两级）',
  '  fin batch list                               账单导入批次',
];

/* ============================================================
 * 本地小工具（独立自举用；ctx 提供同名能力时优先 ctx）
 * ============================================================ */

function localTodayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseArgsLocal(argv) {
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

async function confirmLocal(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => {
    rl.question(`${message} [y/N] `, (a) => { rl.close(); r(/^y(es)?$/i.test(a.trim())); });
  });
}

function outputLocal(flags, data, human) {
  if (flags.json) console.log(JSON.stringify(data, null, 2));
  else if (human) human();
}

function getBailianKeyLocal() {
  if (process.env.BAILIAN_API_KEY) return process.env.BAILIAN_API_KEY;
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  const paths = [pResolve(homedir(), '.workbuddy/bailian.env'), pResolve(homedir(), '.workbuddy/cloudbase.env')];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^\s*(?:export\s+)?(?:BAILIAN_API_KEY|DASHSCOPE_API_KEY)\s*=\s*['"]?([^\s'"]+)/m);
    if (m) return m[1];
  }
  return null;
}

/** logCli 本地等价（fire-and-forget，失败不阻断） */
function logCliLocal(api) {
  return async (action, module, targetId, detail) => {
    try {
      await api('POST', 'action_logs', {
        actor: 'liuqian', module, action,
        target_id: targetId || null,
        detail: { source: 'wb-cli-fin', ...detail },
      });
    } catch (e) {
      console.error(`ℹ️ [action-log] CLI 日志写入跳过：${String(e.message || e).slice(0, 120)}`);
    }
  };
}

const fmtAmt = (n) => Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DIR_CN = { expense: '支出', income: '收入', neutral: '中性' };
const ACC_TYPE_CN = { debit: '储蓄卡', credit: '信用卡', wallet: '钱包', wealth: '理财', mixed: '混合' };

/* ============================================================
 * 分类/账户/日期 解析与归一
 * ============================================================ */

/** 拉库内分类（含 L1/L2 两级）；失败返回 []（降级宽容） */
async function fetchCategories(ctx) {
  try {
    return await ctx.api('GET', `${FIN_TABLES.categories}?select=${CATEGORY_FIELDS}&order=sort_order.asc&limit=500`);
  } catch { return []; }
}

/** 同义词表归一（fin-fields CATEGORY_SYNONYMS：key 长度降序 includes） */
function synonymCategory(text) {
  const pairs = [];
  for (const [kws, name] of CATEGORY_SYNONYMS) {
    for (const kw of kws.split(',')) pairs.push([kw, name]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  for (const [kw, name] of pairs) {
    if (kw && text.includes(kw)) return name;
  }
  return null;
}

/** 候选分类归一到库内合法名：精确 → 同义词 → 模糊包含 → 方向兜底 */
function normalizeCategory(candidate, cats, text, direction) {
  const l1 = cats.filter((c) => !c.parent_id || c.level === 1);
  const dirDefault = direction === 'income' ? '其他收入' : direction === 'neutral' ? '自转' : '其他';
  const exact = (cand) => l1.find((c) => c.name === cand || c.id === cand);
  if (candidate) {
    const hit = exact(String(candidate).trim());
    if (hit) return { name: hit.name, via: '库内精确' };
    const fuzzy = l1.find((c) => c.name.includes(candidate) || candidate.includes(c.name));
    if (fuzzy) return { name: fuzzy.name, via: '库内模糊' };
  }
  if (text) {
    const syn = synonymCategory(text);
    if (syn) {
      const hit = exact(syn);
      if (hit) return { name: hit.name, via: candidate ? '同义词' : '同义词' };
    }
  }
  const fallback = exact(dirDefault);
  return { name: fallback ? fallback.name : dirDefault, via: '方向兜底' };
}

/** 口语日期解析（降级用）：今天/昨天/前天、YYYY-M-D、M月D[日号] */
function parseDateFromText(text, todayStr) {
  const t = String(text || '');
  if (/前天/.test(t)) return shiftDate(todayStr, -2);
  if (/昨天/.test(t)) return shiftDate(todayStr, -1);
  const mIso = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (mIso) return `${mIso[1]}-${String(mIso[2]).padStart(2, '0')}-${String(mIso[3]).padStart(2, '0')}`;
  const mCn = t.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (mCn) {
    const y = Number(todayStr.slice(0, 4));
    return `${y}-${String(mCn[1]).padStart(2, '0')}-${String(mCn[2]).padStart(2, '0')}`;
  }
  return null;
}

function shiftDate(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return localTodayStr(d);
}

/** 文本清洗：剥离日期/时间片段，供金额与分类解析 */
function stripDateFragments(text) {
  return String(text || '')
    .replace(/\d{4}-\d{1,2}-\d{1,2}/g, ' ')
    .replace(/\d{1,2}月\d{1,2}[日号]/g, ' ')
    .replace(/\d{4}年/g, ' ')
    .replace(/\d{1,2}[:：]\d{2}/g, ' ')
    .replace(/今天|昨天|前天/g, ' ');
}

/** 降级金额提取：单位优先 → 剥日期后裸数字 */
function parseAmountLocal(raw) {
  const m1 = String(raw).match(AMOUNT_WITH_UNIT);
  if (m1) return { amount: Number(m1[1]), via: '金额+单位' };
  const cleaned = stripDateFragments(raw);
  const m2 = cleaned.match(AMOUNT_BARE);
  if (m2) return { amount: Number(m2[1]), via: '裸金额' };
  // 再兜底：剥日期后任意数字（非年份）
  const nums = [...cleaned.matchAll(/\d+(?:\.\d{1,2})?/g)]
    .map((m) => Number(m[0]))
    .filter((n) => n > 0 && !(n >= 1900 && n <= 2100 && Number.isInteger(n)));
  if (nums.length) return { amount: nums[nums.length - 1], via: '末位数字' };
  return { amount: null, via: '未识别' };
}

/** 降级方向判断：自转词优先 → 收入词 → expense 默认 */
function parseDirectionLocal(raw) {
  const t = String(raw || '');
  if (SELF_TRANSFER_WORDS.test(t)) return 'neutral';
  if (INCOME_WORDS.test(t)) return 'income';
  return 'expense';
}

/** 账户解析：--account 参数 → fin_accounts 行（精确号 → 名称含 → 关键词表） */
async function resolveAccount(ctx, arg, accounts) {
  if (!arg) return null;
  const a = String(arg).trim();
  const list = accounts || [];
  let hit = list.find((x) => x.account_no === a)
    || list.find((x) => (x.account_name || '') === a)
    || list.find((x) => (x.account_name || '').includes(a) || a.includes(x.account_name || '￿'));
  if (!hit) {
    for (const [kws, no] of ACCOUNT_KEYWORDS) {
      for (const kw of kws.split(',')) {
        if (kw && (a.includes(kw) || kw.includes(a))) {
          hit = list.find((x) => x.account_no === no);
          if (hit) break;
        }
      }
      if (hit) break;
    }
  }
  return hit ? { no: hit.account_no, name: hit.account_name } : null;
}

/* ============================================================
 * AI 提取（百炼 qwen-flash；ctx.bailianKey 或本地降级链；失败返回 null）
 * ============================================================ */

const BAILIAN_MODEL = 'qwen-flash';
const BAILIAN_TIMEOUT_MS = 8000;

function buildFinPrompt(raw, cats, todayStr) {
  const l1 = cats.filter((c) => !c.parent_id || c.level === 1);
  const l2 = cats.filter((c) => c.parent_id || c.level === 2);
  const l1Line = l1.length
    ? l1.map((c) => `${c.name}|${c.direction || '-'}`).join('、')
    : '餐饮|expense、购物|expense、交通出行|expense、居住|expense、通讯|expense、数字服务|expense、工资收入|income、退款退货|income、投资理财|income、其他收入|income、自转|neutral、其他|expense';
  const l2ByL1 = new Map();
  for (const c of l2) {
    const key = c.parent_id || '';
    if (!l2ByL1.has(key)) l2ByL1.set(key, []);
    l2ByL1.get(key).push(c.name);
  }
  const l2Line = l1.slice(0, 12).map((c) => {
    const kids = (l2ByL1.get(c.id) || []).slice(0, 6);
    return kids.length ? `${c.name}: ${kids.join('/')}` : '';
  }).filter(Boolean).join('；');
  return `你是财务记账信息提取器。从一句中文记账口语中提取字段，只输出一个 JSON 对象，不要任何解释。

【今天是 ${todayStr}】

【库内一级分类】（名称|方向，category_l1 必须从此清单选择）：
${l1Line}
${l2Line ? `\n【二级分类参考】（category_l2 选最贴近的，不确定填 null）：\n${l2Line}` : ''}

【归一化规则】
- 吃饭/饭/餐/外卖/食堂/奶茶/咖啡/请客吃饭 → 餐饮；打车/地铁/公交/高铁/机票 → 交通出行；加油/停车费/洗车/ETC → 汽车交通；房租/水电燃气 → 居住；话费/宽带 → 通讯；会员/订阅/AI/云服务 → 数字服务；超市/京东/淘宝/买东西 → 购物；学费/兴趣班/文具 → 子女教育；红包/随礼/份子 → 人际往来
- 工资/奖金/年终奖 → 工资收入；退款/退货到账 → 退款退货；利息/理财收益 → 投资理财
- 自己账户间转账、还信用卡/花呗/白条 → direction=neutral、category_l1=自转 或 信用还款

【输出 JSON 字段】
{"amount": 数字(元,>0), "direction": "expense|income|neutral", "category_l1": "库内分类名", "category_l2": "二级分类名或null", "tx_date": "YYYY-MM-DD", "goods_desc": "≤16字摘要", "notes": "补充说明或null", "funding_account_name": "账户名或null"}
- 未提日期则 tx_date=今天；账户只在用户明确提到时填写

【用户输入】${raw}`;
}

async function aiExtractFin(raw, ctx, cats, todayStr) {
  const key = ctx.bailianKey || getBailianKeyLocal();
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BAILIAN_TIMEOUT_MS);
  try {
    const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: BAILIAN_MODEL,
        messages: [{ role: 'user', content: buildFinPrompt(raw, cats, todayStr) }],
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
    return JSON.parse(cleaned);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ============================================================
 * fin add：AI/降级记账
 * ============================================================ */

async function cmdFinAdd(flags, pos, ctx) {
  const raw = pos.join(' ').trim();
  if (!raw) {
    console.error('用法: fin add "<自然语言记账>" [--date YYYY-MM-DD] [--account 账户] [--yes]');
    process.exitCode = 1;
    return;
  }

  const todayStr = localTodayStr();
  const [cats, accounts] = await Promise.all([
    fetchCategories(ctx),
    ctx.api('GET', `${FIN_TABLES.accounts}?select=account_no,account_name,account_type&limit=100`).catch(() => []),
  ]);

  // ① AI 提取（不可用 → null，全降级）
  const ai = await aiExtractFin(raw, ctx, cats, todayStr);
  if (ai) console.error('ℹ️ AI 提取成功（百炼）');
  else console.error('ℹ️ AI 提取不可用（无 Key/超时），降级正则解析');

  // ② 逐字段合成（AI 优先，缺口降级补；每字段记来源）
  const via = {};
  let amount = null;
  if (ai && Number.isFinite(Number(ai.amount)) && Number(ai.amount) > 0) {
    amount = Number(ai.amount); via.amount = 'AI';
  } else {
    const f = parseAmountLocal(raw);
    amount = f.amount; via.amount = f.via;
  }
  if (amount == null || amount <= 0) {
    console.error('❌ 未能识别金额（尝试「…28元」或「…花了28」写法）');
    process.exitCode = 1;
    return;
  }

  let direction = ['expense', 'income', 'neutral'].includes(ai?.direction) ? ai.direction : null;
  if (direction) via.direction = 'AI';
  else { direction = parseDirectionLocal(raw); via.direction = '方向词'; }

  const catHit = normalizeCategory(ai?.category_l1, cats, raw, direction);
  const categoryL1 = catHit.name;
  via.category_l1 = ai?.category_l1 ? `AI→${catHit.via}` : catHit.via;

  let categoryL2 = null;
  if (ai?.category_l2 && typeof ai.category_l2 === 'string') {
    const hit2 = cats.find((c) => c.name === ai.category_l2 && (c.parent_id || c.level === 2));
    categoryL2 = hit2 ? hit2.name : null;
    via.category_l2 = categoryL2 ? 'AI' : 'AI(未命中库,弃)';
  }

  let txDate = typeof flags.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(flags.date)
    ? (via.tx_date = '--date', flags.date)
    : null;
  if (!txDate && ai?.tx_date && /^\d{4}-\d{2}-\d{2}$/.test(ai.tx_date)) { txDate = ai.tx_date; via.tx_date = 'AI'; }
  if (!txDate) {
    const d = parseDateFromText(raw, todayStr);
    txDate = d || todayStr; via.tx_date = d ? '日期词' : '默认今天';
  }

  const goodsDesc = (typeof ai?.goods_desc === 'string' && ai.goods_desc.trim())
    ? (via.goods_desc = 'AI', ai.goods_desc.trim().slice(0, 20))
    : (via.goods_desc = '原文截断', stripDateFragments(raw).replace(/(\d+(?:\.\d{1,2})?)\s*(?:元|块|圆|￥|¥)?/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20) || '手工记账');

  let funding = null;
  const accountArg = typeof flags.account === 'string' ? flags.account : null;
  if (accountArg) {
    funding = await resolveAccount(ctx, accountArg, accounts);
    if (!funding) console.error(`⚠️ 未匹配到账户「${accountArg}」，funding_account 留空（可用 fin account list 查看清单）`);
  } else if (typeof ai?.funding_account_name === 'string' && ai.funding_account_name) {
    funding = await resolveAccount(ctx, ai.funding_account_name, accounts);
    via.funding = funding ? 'AI→账户库' : 'AI(未匹配)';
  }

  // ③ 组装行（口径对齐 fin-manual.ts createManualTx + 任务包 FR1）
  const rand8 = Math.random().toString(36).slice(2, 10);
  const txId = `manual-${txDate.replace(/-/g, '')}-${rand8}`;
  const row = {
    tx_id: txId,
    match_status: 'manual',
    source_primary: 'cli-manual',
    // 对齐 Web 端 F01 口径（lib/fin-manual.ts）：source_kind='manual' 与历史导入账严格区分，
    // 前端「手工账」筛选与 F09/F10 编辑、删除守卫均依赖此标记
    source_kind: 'manual',
    tx_date: txDate,
    book_month: txDate.slice(0, 7),
    direction,
    amount: Math.round(amount * 100) / 100,
    currency: 'CNY',
    category_l1: categoryL1,
    category_l2: categoryL2,
    funding_account_no: funding?.no || null,
    funding_account_name: funding?.name || null,
    goods_desc: goodsDesc,
    notes: raw,
    is_consumption: direction === 'expense' ? true : null,
    reviewed: true,
  };

  // ④ 字段卡回显 + 确认
  console.log('将记账 · 字段卡');
  console.log(`  金额        ¥${fmtAmt(row.amount)}        [${via.amount}]`);
  console.log(`  方向        ${DIR_CN[direction]} ${direction}   [${via.direction}]`);
  console.log(`  一级分类    ${categoryL1}          [${via.category_l1}]`);
  if (categoryL2) console.log(`  二级分类    ${categoryL2}`);
  console.log(`  日期        ${txDate}（账月 ${row.book_month}）  [${via.tx_date}]`);
  if (funding) console.log(`  账户        ${funding.name}  [${via.funding || '--account'}]`);
  console.log(`  摘要        ${goodsDesc}  [${via.goods_desc}]`);
  console.log(`  备注        ${raw.slice(0, 40)}`);
  console.log(`  tx_id       ${txId}`);

  const confirm = ctx.confirm || confirmLocal;
  if (!flags.yes) {
    if (process.stdin.isTTY) {
      const ok = await confirm('确认写入 fin_transactions？');
      if (!ok) { console.log('已取消（加 --yes 跳过确认）'); return; }
    } else {
      console.log('⛔ 非 TTY 环境写操作需 --yes');
      process.exitCode = 2;
      return;
    }
  }

  // ⑤ 落库 + 日志 + 输出
  const [created] = await ctx.api('POST', FIN_TABLES.tx, row);
  const log = ctx.logCli || logCliLocal(ctx.api);
  await log('fin_add', 'finance', txId, {
    title: `${goodsDesc} ¥${fmtAmt(row.amount)}（${DIR_CN[direction]}·${categoryL1}）`,
    content: raw,
    tx_id: txId, tx_date: txDate, amount: row.amount, direction, category_l1: categoryL1,
  });
  const out = ctx.output || ((d, h) => outputLocal(flags, d, h));
  out({ ok: true, tx_id: txId, row: created || row }, () => {
    console.log(`✅ 已记账：${DIR_CN[direction]} ¥${fmtAmt(row.amount)} ${categoryL1}${categoryL2 ? '/' + categoryL2 : ''} ${txDate}`);
    console.log(`   tx_id=${txId}（前端 /finance/ 可见）`);
  });
}

/* ============================================================
 * fin list
 * ============================================================ */

async function cmdFinList(flags, ctx) {
  let q = `${FIN_TABLES.tx}?select=${TX_LIST_FIELDS}&order=tx_date.desc,tx_id.desc&limit=${Math.min(parseInt(flags.limit, 10) || 20, 500)}`;
  if (typeof flags.month === 'string') {
    if (!/^\d{4}-\d{2}$/.test(flags.month)) { console.error('❌ --month 需 YYYY-MM'); process.exitCode = 1; return; }
    q += `&book_month=eq.${flags.month}`;
  }
  if (typeof flags.dir === 'string') {
    if (!['expense', 'income', 'neutral'].includes(flags.dir)) { console.error('❌ --dir 仅 expense|income|neutral'); process.exitCode = 1; return; }
    q += `&direction=eq.${flags.dir}`;
  }
  if (typeof flags.cat === 'string') {
    const cats = await fetchCategories(ctx);
    const exact = cats.some((c) => c.name === flags.cat || c.id === flags.cat);
    q += exact ? `&category_l1=eq.${encodeURIComponent(flags.cat)}` : `&category_l1=ilike.*${encodeURIComponent(flags.cat)}*`;
  }
  if (typeof flags.account === 'string') {
    const accs = await ctx.api('GET', `${FIN_TABLES.accounts}?select=account_no&limit=100`).catch(() => []);
    const exactNo = accs.some((a) => a.account_no === flags.account);
    q += exactNo ? `&funding_account_no=eq.${encodeURIComponent(flags.account)}` : `&funding_account_name=ilike.*${encodeURIComponent(flags.account)}*`;
  }
  const rows = await ctx.api('GET', q);
  const out = ctx.output || ((d, h) => outputLocal(flags, d, h));
  out({ count: rows.length, transactions: rows }, () => {
    if (!rows.length) { console.log('（无交易明细）'); return; }
    console.log(`交易明细 ${rows.length} 笔（日期 | 方向 | 金额 | 分类 | 摘要）：\n`);
    for (const t of rows) {
      const cat = [t.category_l1, t.category_l2].filter(Boolean).join('/') || '—';
      const desc = String(t.goods_desc || t.notes || '').slice(0, 30);
      const acc = t.funding_account_name ? ` @${t.funding_account_name}` : '';
      console.log(`${t.tx_date}  ${DIR_CN[t.direction] || t.direction}  ¥${fmtAmt(t.amount).padStart(12)}  ${cat}${acc}`);
      if (desc) console.log(`   ${desc}  tx_id=${t.tx_id}`);
    }
  });
}

/* ============================================================
 * 范围过滤（summary/top 共用）
 * ============================================================ */

function rangeFilter(flags) {
  const today = localTodayStr();
  if (typeof flags.month === 'string') {
    if (!/^\d{4}-\d{2}$/.test(flags.month)) throw new Error('--month 需 YYYY-MM');
    return { q: `book_month=eq.${flags.month}`, label: flags.month, month: flags.month };
  }
  if (flags.since || flags.until) {
    const parts = [];
    if (typeof flags.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(flags.since)) parts.push(`tx_date=gte.${flags.since}`);
    if (typeof flags.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(flags.until)) parts.push(`tx_date=lte.${flags.until}`);
    if (!parts.length) throw new Error('--since/--until 需 YYYY-MM-DD');
    return { q: parts.join('&'), label: `${flags.since || '…'} ~ ${flags.until || '…'}`, month: null };
  }
  const m = today.slice(0, 7);
  return { q: `book_month=eq.${m}`, label: `${m}（默认当月）`, month: m };
}

/** 拉范围数据本地聚合 */
async function fetchRangeRows(ctx, rangeQ) {
  const q = `${FIN_TABLES.tx}?select=tx_date,direction,amount,category_l1,category_l2,goods_desc,notes,tx_id&${rangeQ}&limit=20000`;
  return ctx.api('GET', q);
}

function aggregate(rows) {
  const agg = { income: 0, expense: 0, neutral: 0, nIncome: 0, nExpense: 0, nNeutral: 0, byCat: new Map() };
  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    if (r.direction === 'income') { agg.income += amt; agg.nIncome++; }
    else if (r.direction === 'expense') {
      agg.expense += amt; agg.nExpense++;
      const k = r.category_l1 || '未分类';
      const cur = agg.byCat.get(k) || { total: 0, n: 0 };
      cur.total += amt; cur.n++;
      agg.byCat.set(k, cur);
    } else { agg.neutral += amt; agg.nNeutral++; }
  }
  return agg;
}

function renderSummary(label, agg, extraNote) {
  console.log(`📊 ${label} 财务汇总${extraNote ? `（${extraNote}）` : ''}`);
  console.log(`  总收入   ¥${fmtAmt(agg.income)}   （${agg.nIncome} 笔）`);
  console.log(`  总支出   ¥${fmtAmt(agg.expense)}   （${agg.nExpense} 笔）`);
  console.log(`  结余     ¥${fmtAmt(agg.income - agg.expense)}   （收入-支出）`);
  if (agg.nNeutral) console.log(`  自转/中性 ¥${fmtAmt(agg.neutral)}   （${agg.nNeutral} 笔，不计入结余）`);
  if (agg.nExpense) {
    console.log(`  支出分类构成（降序）：`);
    const sorted = [...agg.byCat.entries()].sort((a, b) => b[1].total - a[1].total);
    const max = sorted[0][1].total;
    for (const [cat, v] of sorted) {
      const bar = '█'.repeat(Math.max(1, Math.round((v.total / max) * 12)));
      console.log(`    ${cat.padEnd(6)} ¥${fmtAmt(v.total).padStart(12)}  ${v.n}笔  ${bar}`);
    }
  }
}

/* ============================================================
 * fin summary / fin stat / fin top
 * ============================================================ */

async function cmdFinSummary(flags, ctx) {
  const range = rangeFilter(flags);
  const rows = await fetchRangeRows(ctx, range.q);
  const out = ctx.output || ((d, h) => outputLocal(flags, d, h));

  if (typeof flags.cat === 'string') {
    // 单分类口径：合计+笔数+明细前5（金额降序）；空分类行不参与匹配（防 ''.includes 恒真）
    const kw = flags.cat;
    const hit = rows.filter((r) => {
      const c1 = r.category_l1;
      if (!c1) return false;
      return c1 === kw || c1.includes(kw) || kw.includes(c1);
    });
    if (!hit.length) {
      out({ range: range.label, cat: kw, count: 0, total: 0 }, () => console.log(`（${range.label} 无「${kw}」分类交易）`));
      return;
    }
    const total = hit.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const top5 = [...hit].sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 5);
    out({
      range: range.label, cat: hit[0].category_l1, count: hit.length,
      total: Math.round(total * 100) / 100, top5,
    }, () => {
      console.log(`📊 ${range.label} 「${hit[0].category_l1}」合计：¥${fmtAmt(total)}（${hit.length} 笔）`);
      console.log(`  明细前 5（金额降序）：`);
      for (const r of top5) {
        console.log(`    ${r.tx_date}  ¥${fmtAmt(r.amount).padStart(10)}  ${String(r.goods_desc || r.notes || '').slice(0, 24)}`);
      }
    });
    return;
  }

  const agg = aggregate(rows);
  out({
    range: range.label, count: rows.length,
    income: Math.round(agg.income * 100) / 100, expense: Math.round(agg.expense * 100) / 100,
    balance: Math.round((agg.income - agg.expense) * 100) / 100,
    nIncome: agg.nIncome, nExpense: agg.nExpense, nNeutral: agg.nNeutral,
    byCategory: [...agg.byCat.entries()].map(([cat, v]) => ({ cat, total: Math.round(v.total * 100) / 100, n: v.n })).sort((a, b) => b.total - a.total),
  }, () => renderSummary(range.label, agg, '口径：含自转/信用还款原始行，未剔除'));
}

async function cmdFinStat(flags, ctx) {
  if (typeof flags.month !== 'string' || !/^\d{4}-\d{2}$/.test(flags.month)) {
    console.error('用法: fin stat --month YYYY-MM（必填）');
    process.exitCode = 1;
    return;
  }
  const today = localTodayStr();
  const curMonth = today.slice(0, 7);
  const [y, m] = flags.month.split('-').map(Number);
  const daysTotal = new Date(y, m, 0).getDate();
  const days = flags.month === curMonth ? new Date().getDate() : daysTotal;
  const dayNote = flags.month === curMonth ? `当月已过 ${days} 天` : `整月 ${days} 天`;

  const rows = await fetchRangeRows(ctx, `book_month=eq.${flags.month}`);
  const agg = aggregate(rows);
  const daily = days > 0 ? agg.expense / days : 0;
  const out = ctx.output || ((d, h) => outputLocal(flags, d, h));
  out({
    month: flags.month, days, dayNote,
    income: Math.round(agg.income * 100) / 100, expense: Math.round(agg.expense * 100) / 100,
    balance: Math.round((agg.income - agg.expense) * 100) / 100,
    nIncome: agg.nIncome, nExpense: agg.nExpense,
    dailyExpense: Math.round(daily * 100) / 100,
    byCategory: [...agg.byCat.entries()].map(([cat, v]) => ({ cat, total: Math.round(v.total * 100) / 100, n: v.n })).sort((a, b) => b.total - a.total),
  }, () => {
    renderSummary(flags.month, agg, `日均按${dayNote}`);
    console.log(`  日均支出 ¥${fmtAmt(daily)} /天（${dayNote}）`);
  });
}

async function cmdFinTop(flags, ctx) {
  const range = rangeFilter(flags);
  const n = Math.min(Math.max(parseInt(flags.n, 10) || 10, 1), 100);
  const q = `${FIN_TABLES.tx}?select=tx_date,tx_id,amount,category_l1,category_l2,goods_desc,notes&${range.q}&direction=eq.expense&order=amount.desc&limit=${n}`;
  const rows = await ctx.api('GET', q);
  const out = ctx.output || ((d, h) => outputLocal(flags, d, h));
  out({ range: range.label, n, top: rows }, () => {
    if (!rows.length) { console.log(`（${range.label} 无支出交易）`); return; }
    console.log(`🏆 ${range.label} 支出 Top ${rows.length}：\n`);
    rows.forEach((r, i) => {
      const cat = [r.category_l1, r.category_l2].filter(Boolean).join('/');
      console.log(`${String(i + 1).padStart(2)}. ${r.tx_date}  ¥${fmtAmt(r.amount).padStart(12)}  ${cat}`);
      console.log(`    ${String(r.goods_desc || r.notes || '').slice(0, 30)}`);
    });
  });
}

/* ============================================================
 * fin account / cat / batch（只读查询）
 * ============================================================ */

async function cmdFinAccount(flags, pos, ctx) {
  if (pos[0] && pos[0] !== 'list') { console.error(`未知子命令：account ${pos[0]}（支持 fin account list）`); process.exitCode = 1; return; }
  const rows = await ctx.api('GET', `${FIN_TABLES.accounts}?select=${ACCOUNT_FIELDS}&order=account_type.asc,account_no.asc&limit=200`);
  const out = ctx.output || ((d, h) => outputLocal(flags, d, h));
  out({ count: rows.length, accounts: rows }, () => {
    if (!rows.length) { console.log('（fin_accounts 为空——建账后可用 fin account list 查看）'); return; }
    console.log(`账户共 ${rows.length} 个：\n`);
    for (const a of rows) {
      const type = ACC_TYPE_CN[a.account_type] || a.account_type || '—';
      const bal = a.balance_current == null ? '—' : `¥${fmtAmt(a.balance_current)}`;
      console.log(`  [${type}] ${a.account_name || a.account_no}`);
      console.log(`       ${a.account_no}  余额 ${bal}`);
    }
  });
}

async function cmdFinCat(flags, pos, ctx) {
  if (pos[0] && pos[0] !== 'list') { console.error(`未知子命令：cat ${pos[0]}（支持 fin cat list）`); process.exitCode = 1; return; }
  const cats = await fetchCategories(ctx);
  if (!cats.length) { console.error('❌ fin_categories 拉取失败或为空'); process.exitCode = 1; return; }
  const l1s = cats.filter((c) => !c.parent_id || c.level === 1).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const childrenOf = new Map();
  for (const c of cats) {
    const key = c.parent_id;
    if (!key) continue;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(c);
  }
  const out = ctx.output || ((d, h) => outputLocal(flags, d, h));
  out({ count: cats.length, l1: l1s.length, categories: cats }, () => {
    console.log(`分类树（${l1s.length} 个一级 / 共 ${cats.length} 个）：\n`);
    for (const l1 of l1s) {
      const dir = l1.direction ? `（${DIR_CN[l1.direction] || l1.direction}）` : '';
      const off = l1.is_active === false ? ' ⏸停用' : '';
      console.log(`▪ ${l1.name}${dir}${off}`);
      const kids = (childrenOf.get(l1.id) || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
      if (kids.length) console.log(`   ${kids.map((k) => k.name + (k.is_active === false ? '⏸' : '')).join(' · ')}`);
    }
  });
}

async function cmdFinBatch(flags, pos, ctx) {
  if (pos[0] && pos[0] !== 'list') { console.error(`未知子命令：batch ${pos[0]}（支持 fin batch list）`); process.exitCode = 1; return; }
  const rows = await ctx.api('GET', `${FIN_TABLES.batches}?select=${BATCH_FIELDS}&order=imported_at.desc&limit=100`);
  const out = ctx.output || ((d, h) => outputLocal(flags, d, h));
  out({ count: rows.length, batches: rows }, () => {
    if (!rows.length) { console.log('（无导入批次——账单导入走 scripts/fin-import.mjs）'); return; }
    console.log(`导入批次 ${rows.length} 个（新→旧）：\n`);
    for (const b of rows) {
      console.log(`  ${b.batch_id}  ${b.source || '—'}`);
      console.log(`       ${b.period || '—'}  ${b.rows ?? '?'} 行  ${String(b.imported_at || '').slice(0, 10)}`);
    }
  });
}

/* ============================================================
 * 入口：注册器 handler + 独立自举
 * ============================================================ */

export async function handler(flags, pos, ctx) {
  if (!ctx || !ctx.api) throw new Error('fin 命令需要 ctx.api（注册器未注入？独立运行：node lib/wb-cli/cmd-fin.mjs fin …）');
  const sub = pos[0] || 'list';
  const rest = pos.slice(1);
  switch (sub) {
    case 'add': return cmdFinAdd(flags, rest, ctx);
    case 'list': return cmdFinList(flags, ctx);
    case 'summary': return cmdFinSummary(flags, ctx);
    case 'stat': return cmdFinStat(flags, ctx);
    case 'top': return cmdFinTop(flags, ctx);
    case 'account': return cmdFinAccount(flags, rest, ctx);
    case 'cat': return cmdFinCat(flags, rest, ctx);
    case 'batch': return cmdFinBatch(flags, rest, ctx);
    default:
      console.error(`未知子命令：fin ${sub}\n支持：`);
      usageLines.forEach((l) => console.error(l));
      process.exitCode = 1;
  }
}

/** 注册器接入（A 段 registry.mjs：reg.register(cmd, handler)） */
export function register(reg) {
  if (reg && typeof reg.register === 'function') reg.register(command, handler);
}

export default { command, usageLines, handler, register };

/* ---- 独立自举：node lib/wb-cli/cmd-fin.mjs [fin] <sub> … ---- */
const __filename = fileURLToPath(import.meta.url);
if (pResolve(process.argv[1] || '') === __filename) {
  (async () => {
    const { makeApi } = await import('../../lib/wb-auth.mjs');
    const { api } = makeApi({ profile: process.env.WB_PROFILE });
    const argv = process.argv.slice(2);
    if (argv[0] === command) argv.shift();
    const { flags, pos } = parseArgsLocal(argv);
    const ctx = { api, bailianKey: getBailianKeyLocal(), logCli: logCliLocal(api) };
    await handler(flags, pos, ctx);
  })().catch((e) => { console.error('❌', e.message); process.exitCode = 1; });
}

/**
 * wb-cli · misc 杂项域查询命令族（三期 D 段 · dt_dod7ui）
 * ------------------------------------------------
 * 只读查询：canvas 画布 / artifact 产物 / log 操作日志 / decision 决策日志。
 *
 * 列名口径（2026-09-04 实测）：
 *   - action_logs 列为 actor/module/action/target_id/detail（detail 是 jsonb，取 detail.title 截断渲染）
 *   - html_artifacts 无 url 列，用 file_path（version_key/version 同步展示）
 *   - decision_logs 无 title，主列是 input_text（决策原文）
 */

/** @param {import('./shared.mjs').Ctx} ctx */
export function register(reg, ctx) {
  reg.register('canvas', {
    summary: '画布列表（canvases）',
    lines: ['  canvas list                     画布（id/标题/更新时间）'],
    handler: (flags, pos) => cmdCanvas(flags, pos, ctx),
  });
  reg.register('artifact', {
    summary: 'HTML 产物列表（html_artifacts）',
    lines: ['  artifact list                   产物域（标题/路径/版本/时间）'],
    handler: (flags, pos) => cmdArtifact(flags, pos, ctx),
  });
  reg.register('log', {
    summary: '操作日志（action_logs）',
    lines: ['  log list [--limit N] [--module M]  最近操作（默认 20 条）'],
    handler: (flags, pos) => cmdLog(flags, pos, ctx),
  });
  reg.register('decision', {
    summary: '决策日志（decision_logs）',
    lines: ['  decision list [--limit N]        决策记录（原文+引擎）'],
    handler: (flags, pos) => cmdDecision(flags, pos, ctx),
  });
}

async function cmdCanvas(flags, pos, ctx) {
  const sub = pos[0] || 'list';
  if (sub !== 'list') { console.error(`未知子命令：${sub}（仅支持 list）`); process.exitCode = 1; return; }
  const rows = await ctx.api('GET', 'canvases?select=id,title,status,tags,updated_at&order=updated_at.desc&limit=100');
  ctx.output({ count: rows.length, canvases: rows }, () => {
    if (!rows.length) { console.log('（无画布）'); return; }
    console.log(`画布共 ${rows.length} 张（按更新倒序）：\n`);
    for (const c of rows) {
      const tags = Array.isArray(c.tags) && c.tags.length ? `  #${c.tags.join(' #')}` : '';
      console.log(`🖼️  ${c.title}${c.status && c.status !== 'active' ? `（${c.status}）` : ''}${tags}`);
      console.log(`   id=${c.id}  更新=${String(c.updated_at || '').slice(0, 16).replace('T', ' ')}`);
    }
  });
}

async function cmdArtifact(flags, pos, ctx) {
  const sub = pos[0] || 'list';
  if (sub !== 'list') { console.error(`未知子命令：${sub}（仅支持 list）`); process.exitCode = 1; return; }
  const rows = await ctx.api('GET', 'html_artifacts?select=id,title,file_path,version,created_at&order=created_at.desc&limit=100');
  ctx.output({ count: rows.length, artifacts: rows }, () => {
    if (!rows.length) { console.log('（产物域为空）'); return; }
    console.log(`HTML 产物共 ${rows.length} 份（按时间倒序）：\n`);
    for (const a of rows) {
      console.log(`📄 v${a.version || 1} ${a.title}`);
      console.log(`   id=${a.id}  ${a.file_path || ''}  ${String(a.created_at || '').slice(0, 10)}`);
    }
  });
}

async function cmdLog(flags, pos, ctx) {
  const sub = pos[0] || 'list';
  if (sub !== 'list') { console.error(`未知子命令：${sub}（仅支持 list）`); process.exitCode = 1; return; }
  let q = 'action_logs?select=id,created_at,actor,module,action,target_id,detail&order=created_at.desc';
  const limit = Math.max(1, Math.min(100, parseInt(String(flags.limit ?? '20'), 10) || 20));
  q += `&limit=${limit}`;
  if (typeof flags.module === 'string') q += `&module=eq.${encodeURIComponent(flags.module)}`;
  const rows = await ctx.api('GET', q);
  ctx.output({ count: rows.length, logs: rows }, () => {
    if (!rows.length) { console.log('（无操作日志）'); return; }
    console.log(`操作日志最近 ${rows.length} 条：\n`);
    for (const l of rows) {
      const t = l.detail && typeof l.detail === 'object' ? (l.detail.title || '') : '';
      const line = t ? `「${String(t).slice(0, 30)}」` : '';
      console.log(`🕓 ${String(l.created_at || '').slice(0, 16).replace('T', ' ')} [${l.module}] ${l.action} ${line}${l.target_id ? ` → ${String(l.target_id).slice(0, 8)}` : ''}`);
    }
  });
}

async function cmdDecision(flags, pos, ctx) {
  const sub = pos[0] || 'list';
  if (sub !== 'list') { console.error(`未知子命令：${sub}（仅支持 list）`); process.exitCode = 1; return; }
  const limit = Math.max(1, Math.min(100, parseInt(String(flags.limit ?? '20'), 10) || 20));
  const rows = await ctx.api('GET', `decision_logs?select=id,input_text,engine,model,decision,refined,created_at&order=created_at.desc&limit=${limit}`);
  ctx.output({ count: rows.length, decisions: rows }, () => {
    if (!rows.length) { console.log('（无决策日志）'); return; }
    console.log(`决策日志最近 ${rows.length} 条：\n`);
    for (const d of rows) {
      /** 判类结果 jsonb（如 {tx:{...},dev:{problem...}}）→ 提取可读摘要 */
      const pick = (v) => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') return v;
        if (typeof v !== 'object') return '';
        if (typeof v.decision === 'string') return v.decision;
        if (typeof v.type === 'string') return `类型=${v.type}`;
        const parts = [];
        for (const [k, val] of Object.entries(v)) {
          if (val && typeof val === 'object') {
            const deep = Object.values(val).filter((x) => typeof x === 'string' && x.length > 3).sort((a, b) => b.length - a.length)[0];
            if (deep) parts.push(`${k}: ${deep.slice(0, 40)}`);
          } else if (typeof val === 'string' && val.length > 3) parts.push(`${k}=${val}`);
        }
        return parts.join('；').slice(0, 60);
      };
      const final = pick(d.decision);
      console.log(`⚖️  ${String(d.created_at || '').slice(0, 16).replace('T', ' ')} [${d.engine || '-'}]${d.refined ? ' 已精炼' : ''}`);
      console.log(`   问：${String(d.input_text || '').slice(0, 60)}`);
      if (final) console.log(`   决：${final}`);
    }
  });
}

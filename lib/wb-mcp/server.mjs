/**
 * wb-mcp · server 组装（dt_xbobex · dt_eaxp4w A段公开化改造）
 * ------------------------------------------------
 * 用官方 @modelcontextprotocol/sdk 组装 stdio MCP server：
 *   - 6 域 tool（readonly profile 只注册 wb_query）
 *   - tools/call 全部过串行队列（防 dev_tasks 打勾竞态）
 *   - confirm 写门（写动词命令须 confirm:true）
 *   - spawn 子进程执行 wb-cli，输出 strip ANSI + 8KB 截断
 *   - 全部 --yes（wb-cli 交互提示在 MCP 场景无法应答）
 *
 * 复用关系：零侵入 wb-cli——spawn scripts/wb-cli.mjs 子进程，
 * 与人敲命令完全同路径（switch 11 命令 + registry cmd-* 族全覆盖）。
 *
 * v5.6.0 公开化：
 *   - pickNode 改 process.execPath——任意机器 clone 即用，不再硬编码本机受管 node
 *   - tools/call 支持 args 数组——长文原样传 argv，不再被空白切分
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as os from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { runQueued } from './queue.mjs';
import {
  DOMAIN_DESC,
  DOMAIN_TIMEOUT,
  TIMEOUT_WRITE,
  buildToolDefs,
  commonInputSchema,
  isWriteCommand,
  domainOf,
  toArgv,
  displayOf,
  splitCommandString,
  WRITE_TOOL_SPECS,
  specToInputSchema,
  specDescription,
  buildSpecArgv,
} from './tools.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..', '..');
const WB_CLI = resolve(ROOT, 'scripts', 'wb-cli.mjs');

/**
 * node 探测链（B段 FR-4）：env WB_NODE → process.execPath → PATH node。
 * 逐级 spawnSync --version 验证可用性；全失败返回 null（不阻断启动，
 * spawn error 路径给三层排查指引）。结果进程内缓存，避免每次 spawn 前重复探测。
 */
export function resolveNode({ refresh = false } = {}) {
  if (!refresh && _nodeCache) return _nodeCache;
  const candidates = [
    { v: process.env.WB_NODE, src: 'env WB_NODE' },
    { v: process.execPath, src: 'process.execPath' },
    { v: 'node', src: 'PATH' },
  ];
  let picked = null;
  for (const c of candidates) {
    if (!c.v) continue;
    if (c.src !== 'PATH' && !existsSync(c.v)) continue;
    // PATH 兜底命中 = execPath 异常的降级信号（正常情况 execPath 恒命中在前）
    if (nodeWorks(c.v)) { picked = { node: c.v, source: c.src, degraded: c.src === 'PATH' }; break; }
  }
  _nodeCache = picked || { node: null, source: 'none', degraded: false };
  return _nodeCache;
}

/** 兼容旧名：execWbCli 内部取当前生效 node（探测链缓存，兜底 execPath） */
function pickNode() {
  return resolveNode().node || process.execPath;
}

/** node 可用性验证（--version 探测，5s 超时） */
function nodeWorks(p) {
  try {
    const r = spawnSync(p, ['--version'], { timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

let _nodeCache = null;

/** strip ANSI 转义码 */
export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

const MAX_OUT = 8 * 1024;

/**
 * spawn 执行 wb-cli 命令并收集输出（A段 FR-3：stdout/stderr 分池，不合并——
 * stderr 仅作诊断进 MCP 日志，返回正文恒为 wb-cli stdout）。
 * @param {string|string[]} command 命令串或 argv 数组（数组原样传，不切分——长文安全）
 * @param {object} [opts]
 * @param {boolean} [opts.json=true] D段修复：重试关 --json 用此开关——
 *   不得在 handler 对 argv 做 slice（会误删最后一个用户参数，A段遗留 bug 实锤）
 * @returns {Promise<{code:number, out:string, err:string}>}
 */
export function execWbCli(command, opts = {}) {
  return new Promise((resolveP) => {
    const node = pickNode();
    // 数组原样作为 argv（args 形态），字符串按 shell 引号规则切分（command 形态）
    const base = Array.isArray(command)
      ? command.map((a) => String(a))
      : splitCommandString(String(command || ''));
    const argv = [WB_CLI, ...base, '--yes', ...(opts.json === false ? [] : ['--json'])];
    const child = spawn(node, argv, { cwd: ROOT, env: { ...process.env } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const secs = Math.round((opts.timeoutMs || 30000) / 1000);
      const maybe = opts.mayHaveWritten
        ? '⏱ 超时但命令可能已部分执行——请用对应 list/show 命令核对实际写入结果（如 todo list --limit 5）'
        : '如需更长耗时请拆批或走异步任务通道（P1 FR-5 骨架）';
      resolveP({ code: 124, out, err: `${err ? `${err}\n` : ''}[wb-mcp] 执行超时（${secs}s，档位 ${opts.timeoutLabel || 'default'}），进程已终止。${maybe}` });
    }, opts.timeoutMs || 30000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      // B段 FR-4：spawn 失败不再裸文本——结构化错误附 node/key/网络 三层排查指引，
      // 放 out（JSON 正文）供 handler isError:true 透传，err 通道同步进日志。
      const { node: n, source: ns } = resolveNode();
      const guidance = [
        `node 路径：当前生效「${n || '探测全部失败'}」（来源 ${ns}）；异常时用 env WB_NODE 指向正确的 node 可执行文件后重启`,
        'key：确认 WB_PROFILE 对应 profile 的 wbk_ key 已配置（~/.workbuddy/agents/<profile>.env）；缺 key 到 liflow.cn/settings/ 站长密码自助签发',
        '网络：检查到 api.liflow.cn 的连通性，或用 WB_GATEWAY_URL 指向可达网关；也可运行 wb-cli doctor 一步定位',
      ];
      resolveP({
        code: 1,
        out: JSON.stringify({ success: false, error: { code: 'SPAWN_FAILED', message: e.message, guidance } }, null, 2),
        err: `[wb-mcp] spawn 失败：${e.message}（node=${n || 'none'}）`,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ code: code ?? 0, out, err });
    });
  });
}

/**
 * 输出净化（C段 FR-7：8KB 硬截退役）——超限时保留头部 2KB 预览 + 降载指引，
 * 不再砍尾丢数据；数据完整性由调用方按指引分页（--cursor）或裁列（--fields）取全量。
 * 注意：isParseableJson 校验用原始输出（handler 内先于本函数），此处仅影响展示文本。
 */
export function cleanOutput(raw) {
  const text = stripAnsi(raw).trim();
  if (text.length <= MAX_OUT) return text;
  const preview = text.slice(0, 2048);
  return `${preview}\n…[输出共 ${text.length} 字符，超出 MCP 单次传输 8KB 上限——以上为头部 2KB 预览（未砍尾丢数据）。请降载取全量：list 类命令加 --limit N 与 --fields 列裁剪，或用 --cursor 分页续取（取上一页返回的 next_cursor）]`;
}

/** stdout 是否为可解析的 JSON 对象/数组（FR-3.4 校验；纯标量与空串不算） */
export function isParseableJson(text) {
  try {
    const v = JSON.parse(String(text || '').trim());
    return v !== null && typeof v === 'object';
  } catch {
    return false;
  }
}

/**
 * 组装 McpServer。
 * @param {object} opts
 * @param {string} opts.version serverInfo.version（APP_VERSION）
 * @param {boolean} [opts.readonly=false] readonly profile（hermes）只注册 wb_query
 * @param {object} [opts.logger] { info, error } 可选日志器
 */
export async function buildServer({ version, readonly = false, logger } = {}) {
  const log = logger || { info: () => {}, error: () => {} };
  // B段 FR-4：启动自检 node 探测链——结果缓存 + 日志；异常只告警不阻断（spawn error 路径兜底）
  const nd = resolveNode();
  if (!nd.node) log.error('[wb-mcp] node 探测链全部失败（WB_NODE/execPath/PATH），spawn 将失败；请设 WB_NODE 后重启，或运行 wb-cli doctor 定位');
  else if (nd.degraded) log.error(`[wb-mcp] node 已降级为 PATH 查找「${nd.node}」（execPath 异常）；建议设 WB_NODE 固定路径`);
  else log.info(`[wb-mcp] node=${nd.node}（${nd.source}）`);
  // 低层 Server API（JSON Schema 直传，无 Zod 依赖，SDK 版本兼容面广）
  const server = new Server(
    { name: 'wb-mcp', version: String(version || '0.0.0') },
    {
      instructions: 'AI 工作台 wb-cli 的 MCP 壳。先用 wb_query 查数据；写操作可用细粒度工具（wb_todo_done/wb_note_add/wb_dev_task_stage 等，参数级 schema 校验）或域 tool 命令串；写必须传 confirm:true。v5.11 起支持 args 数组直传长文与细粒度写工具。',
      capabilities: { tools: {} },
    },
  );

  const defs = buildToolDefs({ readonly });
  // D段 FR-8：细粒度写工具（参数级 schema 校验）；readonly profile 不暴露写路径
  const writeSpecs = readonly ? [] : WRITE_TOOL_SPECS;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...defs.map((d) => ({
        name: d.name,
        description: `${DOMAIN_DESC[d.domain]}${d.readOnly ? '' : '（本域含写操作）'}`,
        inputSchema: commonInputSchema(),
      })),
      ...writeSpecs.map((spec) => ({
        name: spec.tool,
        description: specDescription(spec),
        inputSchema: specToInputSchema(spec),
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const toolName = req.params.name;
    // D段 FR-8：细粒度写工具分流——参数校验 + argv 组装后，走与域 tool 完全相同的
    // confirm 门/串行队列/纯净度路径；校验失败直接 isError 拦截，不发起子进程。
    const spec = writeSpecs.find((w) => w.tool === toolName);
    let command;
    let args;
    let confirm;
    let expectedDomain;
    let tmpFiles = [];
    if (spec) {
      const built = buildSpecArgv(spec, req.params.arguments || {}, { tmpDir: os.tmpdir() });
      if (!built.ok) {
        return {
          content: [{ type: 'text', text: `❌ ${spec.tool} 参数校验失败：\n${built.errors.map((e) => `  · ${e}`).join('\n')}\n（参数级拦截，未执行。可用参数见 tool description）` }],
          isError: true,
        };
      }
      tmpFiles = built.tmpFiles || [];
      command = built.argv.join(' ');
      confirm = req.params.arguments?.confirm === true;
      expectedDomain = spec.domain;
    } else {
      const def = defs.find((d) => d.name === toolName);
      if (!def) {
        return { content: [{ type: 'text', text: `❌ 未知 tool：${toolName}` }], isError: true };
      }
      ({ command, args, confirm } = req.params.arguments || {});
      expectedDomain = def.domain;
    }
    const argv = toArgv(command, args);
    if (!argv) {
      return {
        content: [{
          type: 'text',
          text: '❌ command 与 args 均为空。用法：{ command: "todo list", confirm?: true } 或 { command: "note add", args: ["note","add","正文"], confirm: true }',
        }],
        isError: true,
      };
    }
    // 域校验：tool 名与命令首词的域必须匹配
    const dom = domainOf(argv);
    if (dom !== expectedDomain) {
      return { content: [{ type: 'text', text: `❌ 该命令属 ${dom || '未知'} 域，请改用 wb_query/wb_todo/wb_fin/wb_note/wb_manage/wb_dev_task/wb_vault/wb_archive 对应 tool。收到："${displayOf(argv)}"` }], isError: true };
    }
    // confirm 写门（数组 join(' ') 判定，语义与字符串形态完全一致）
    if (isWriteCommand(argv) && confirm !== true) {
      return { content: [{ type: 'text', text: `🔒 写操作安全门：命令含写动词，须显式传 confirm:true 才执行。收到："${displayOf(argv)}"` }], isError: true };
    }
    // 串行队列执行（A段 FR-3：stderr 进日志不进正文；失败 isError+结构化 error；解析失败移除 --json 重试一次）
    try {
      // P1 FR-6 超时三档：按域查默认档，写调用抬到写档（60s）
      const baseTimeout = DOMAIN_TIMEOUT[dom] || 30000;
      const mayWrite = isWriteCommand(argv);
      const timeoutMs = mayWrite ? Math.max(baseTimeout, TIMEOUT_WRITE) : baseTimeout;
      const runOnce = (a, o) => runQueued(() => execWbCli(a, { mayHaveWritten: mayWrite, timeoutLabel: `${Math.round(timeoutMs / 1000)}s`, timeoutMs, ...o }));
      const logStderr = (r, tag) => {
        const s = String(r.err || '').trim();
        if (s) log.error(`[wb-mcp:stderr] ${tag}: ${s.slice(0, 500)}`);
      };
      let r = await runOnce(argv);
      let tag = displayOf(argv);
      logStderr(r, tag);
      let text = r.out;
      // FR-3.3：仅当 stdout 不可解析（空/人读输出）时关 --json 重试一次（兼容 fill 等无 --json 命令）。
      // D段修复：①重试经 opts.json:false 关闭——A段 argv.slice(0,-1) 会误删最后一个用户参数；
      // ②失败信封（exit≠0 但 stdout 已是结构化 JSON）直接透传，不再被重试结果覆盖。
      if (!isParseableJson(text)) {
        const r2 = await runOnce(argv, { json: false });
        logStderr(r2, tag);
        if (r2.code === 0) {
          r = r2;
          text = r2.out;
        } else if (!text.trim()) {
          r = r2;
          text = r2.out;
        }
        // 重试仍失败但第一次已有输出（错误信封/人读报错）→ 保留第一次
      }
      if (r.code === 0) {
        const shown = cleanOutput(text);
        return { content: [{ type: 'text', text: shown || '(无输出)' }] };
      }
      // 失败：stdout 若已是 wb-cli 失败信封 JSON 则原样透传；否则包结构化 error。
      // 不再加「⚠️ 退出码 N」文字前缀，不合并 stderr——机器可判定 isError 并 JSON.parse。
      let body = stripAnsi(text).trim();
      if (!isParseableJson(body)) {
        body = JSON.stringify({
          success: false,
          error: {
            code: r.code === 124 ? 'TIMEOUT' : 'CLI_FAIL',
            message: cleanOutput(text) || `wb-cli 退出码 ${r.code}（诊断见 MCP 日志）`,
            exit_code: r.code,
          },
        }, null, 2);
      }
      return { content: [{ type: 'text', text: body }], isError: true };
    } catch (e) {
      return { content: [{ type: 'text', text: `❌ 执行失败：${e.message}` }], isError: true };
    } finally {
      // P1 FR-3：长文中转临时文件用后即删
      for (const f of tmpFiles) { try { unlinkSync(f); } catch {} }
    }
  });

  log.info(`wb-mcp tools=${defs.length}${readonly ? '（readonly）' : ''}`);
  return server;
}

/** 启动（stdio transport） */
export async function startServer(opts) {
  const server = await buildServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

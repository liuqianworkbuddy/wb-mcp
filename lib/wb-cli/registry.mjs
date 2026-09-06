/**
 * wb-cli · 命令注册器（三期 A 段 · dt_dod7ui）
 * ------------------------------------------------
 * 主文件 scripts/wb-cli.mjs 只保留「解析 + 调度」壳：
 *   - 现有 11 命令保持 switch 不动（渐进债，后续外移）
 *   - 新命令族放 lib/wb-cli/cmd-*.mjs，启动时动态发现注册
 *
 * 命令模块契约（B/C/D 段同样遵守）：
 *   export function register(registry, ctx) {
 *     registry.register('fin', {
 *       summary: '一句话说明',
 *       lines: ['  fin tx list [--month 2026-08]   流水查询'],  // usage 聚合行
 *       handler: async (flags, pos, ctx) => { ... },
 *     });
 *   }
 * 已注册命令族（动态发现 cmd-*.mjs 自动挂载，此处仅登记备查）：
 *   vault（P1 C 段 dt_iy2eek）· archive（P4 C 段 dt_mkq335，注册逻辑在
 *   lib/wb-cli/cmd-archive.mjs 的 register 导出，本文件无需改动——此注释行
 *   为任务包 C 段登记位）
 *
 * ctx 由 shared.mjs makeCtx 注入（api/logCli/confirm/prompt/output/
 * todayCtx/ROOT），字段契约不得私自变更（TDD §1.1）。
 */

/** 创建注册器实例 */
export function createRegistry() {
  /** @type {Map<string, {name:string, summary:string, lines:string[], handler:Function}>} */
  const cmds = new Map();

  return {
    /** 注册命令；重名直接抛错（防多模块静默覆盖）。
     *  验收适配（2026-09-04 dt_dod7ui S6）：meta 兼容直接传 handler 裸函数（B 段形态）。
     *  B段（dt_o2ch2u FR-6 试点）：额外保留扩展元数据 domain/params/write/confirmNeed/
     *  resultFields/limits——存量模块缺省 undefined 不受影响，C 段 capabilities 单源消费。 */
    register(name, meta = {}) {
      if (cmds.has(name)) throw new Error(`wb-cli 命令重复注册：${name}`);
      if (typeof meta === 'function') meta = { handler: meta };  // 裸函数形态
      if (typeof meta.handler !== 'function') throw new Error(`注册命令 ${name} 缺少 handler`);
      cmds.set(name, {
        name,
        summary: String(meta.summary || ''),
        lines: Array.isArray(meta.lines) ? meta.lines : [],
        handler: meta.handler,
        domain: meta.domain,
        params: meta.params,
        write: meta.write,
        confirmNeed: meta.confirmNeed,
        resultFields: meta.resultFields,
        limits: meta.limits,
      });
    },

    has(name) {
      return cmds.has(name);
    },

    names() {
      return [...cmds.keys()];
    },

    /** C段 FR-6：全量契约条目（capabilities 单源遍历用） */
    entries() {
      return [...cmds.values()];
    },

    /** 调度执行；未注册返回 false（主文件回落 switch） */
    async dispatch(name, flags, pos, ctx) {
      const c = cmds.get(name);
      if (!c) return false;
      await c.handler(flags, pos, ctx);
      return true;
    },

    /** usage 聚合：各注册命令的说明行拼进主 usage */
    usageLines() {
      const out = [];
      for (const c of cmds.values()) {
        out.push(...(c.lines.length ? c.lines : [`  ${c.name}  ${c.summary}`.trimEnd()]));
      }
      return out;
    },
  };
}

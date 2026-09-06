/**
 * wb-cli · capabilities 命令注册（dt_o2ch2u C段 · FR-6）
 * ------------------------------------------------
 * `wb-cli capabilities [--json] [--md]`：输出逐命令机器契约。
 * handler 闭包捕获 registry 实例——契约从注册表单源生成（buildCapabilities）。
 * --md 输出 markdown（重定向入仓 docs/wb-cli-capabilities.md，DO NOT EDIT）。
 */

import { buildCapabilities, renderMd } from './capabilities.mjs';

export function register(registry, ctx) {
  registry.register('capabilities', {
    summary: '机器契约：逐命令域/参数/写边界/结果字段（registry 单源自动生成）',
    lines: ['  capabilities [--json] [--md]       机器契约输出（--md 生成 markdown 入仓文档）'],
    handler: cmdCapabilities,
    // FR-6 扩展元数据（自描述：capabilities 自身也进契约）
    domain: 'query',
    write: false,
    confirmNeed: false,
    params: [
      { name: 'json', type: 'boolean', required: false, desc: '机器可读输出（经 envelope）' },
      { name: 'md', type: 'boolean', required: false, desc: 'markdown 格式输出（重定向入 docs/）' },
    ],
    resultFields: ['contract_version', 'generated_at', 'commands'],
  });

  async function cmdCapabilities(flags) {
    const cap = buildCapabilities(registry);
    if (flags.md) {
      console.log(renderMd(cap));
      return;
    }
    ctx.output(cap, () => {
      console.log(`wb-cli 命令契约 contract v${cap.contract_version}（${cap.commands.length} 命令 = registry 动态 + switch legacy）：\n`);
      for (const c of cap.commands) {
        const meta = [
          c.domain || '—',
          c.write ? '写' : '读',
          c.confirmNeed ? '需confirm' : '',
          Array.isArray(c.params) ? `参数:${c.params.map((p) => p.name).join(' ')}` : '',
        ].filter(Boolean).join(' · ');
        console.log(`  ${c.name.padEnd(14)} ${meta}${c.legacy ? '  [legacy]' : ''}`);
        if (c.summary) console.log(`${' '.repeat(17)}${c.summary}`);
      }
    });
  }
}

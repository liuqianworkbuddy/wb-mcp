/**
 * wb-cli · 异步任务骨架（dt_r5j0rp D段 · FR-5，降级实现）
 * ------------------------------------------------
 * task list / task status [--id <task_id>]：查询 ~/.workbuddy/tasks/ 登记文件。
 * 启用条件（写入契约注释）：当前 wb-cli 无内置超 10s 操作；未来出现真实慢操作
 * （批量导入/构建/长查询）时，操作方先写任务登记文件立即返回
 * {task_id, status:"pending"}，后台执行完毕更新 status=done + result_file，
 * 调用方以 wb-cli task status 轮询取结果。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TASKS_DIR = () => `${(process.env.WB_HOME || `${homedir()}/.workbuddy`).replace(/[\\/]+$/, '')}/tasks`;

export function register(registry, ctx) {
  registry.register('task', {
    summary: '异步任务查询（骨架）：task list / task status --id（慢操作轮询语义，P1 FR-5）',
    lines: ['  task list                          异步任务清单（~/.workbuddy/tasks/）', '  task status --id <task_id>         查询任务状态与结果文件'],
    handler: cmdTask,
    domain: 'query',
    write: false,
    confirmNeed: false,
    params: [
      { name: 'id', type: 'string', required: false, desc: 'task_id（status 子命令用）' },
    ],
    resultFields: ['tasks'],
  });

  async function cmdTask(flags, pos) {
    const sub = pos[0] || 'list';
    const dir = TASKS_DIR();
    if (!existsSync(dir)) {
      ctx.output({ tasks: [], note: '尚无任务登记目录（骨架就绪：真实 >10s 慢操作出现后启用 pending+轮询语义）' }, () => console.log('（尚无异步任务记录——骨架就绪，启用条件见 docs/TDD-追平得到大脑P1 §1.10）'));
      return;
    }
    if (sub === 'status') {
      const id = flags.id || pos[1];
      if (!id) { console.error('用法: task status --id <task_id>'); process.exitCode = 1; return; }
      const f = join(dir, `${id}.json`);
      if (!existsSync(f)) throw new Error(`task 不存在：${id}`);
      const task = JSON.parse(readFileSync(f, 'utf8'));
      ctx.output(task, () => console.log(`[${task.status}] ${task.id} ${task.cmd || ''}\n  结果：${task.result_file || '（执行中或未产出）'}`));
      return;
    }
    const tasks = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
      try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return { id: f, status: 'unreadable' }; }
    });
    ctx.output({ tasks }, () => {
      if (!tasks.length) { console.log('（无异步任务）'); return; }
      for (const t of tasks) console.log(`[${t.status}] ${t.id}  ${t.cmd || ''}  ${t.created_at || ''}`);
    });
  }
}

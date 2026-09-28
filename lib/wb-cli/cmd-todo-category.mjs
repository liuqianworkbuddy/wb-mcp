/**
 * wb-cli · 待办分类管理命令
 * ------------------------------------------------------------
 * todo-category add/del：供 MCP 细粒度工具调用，也可直接在终端使用。
 * 删除规则与前端「管理待办分类」保持一致：内置五类不可删；有子分类先删
 * 子分类；仍被待办引用时先把待办归回「工作」，再删除分类。
 */

const PROTECTED_CATEGORY_NAMES = new Set(['工作', '生活', '个人', '家庭', '财务']);
const NAME_MAX = 60;
const DESCRIPTION_MAX = 200;
const CATEGORY_FIELDS = 'id,name,parent_id,description,sort_order';

function normalized(name) {
  return String(name ?? '').trim();
}

function exactMatches(rows, name) {
  const target = normalized(name);
  return rows.filter((row) => normalized(row.name) === target);
}

async function fetchCategories(ctx) {
  const rows = await ctx.api(
    'GET',
    `todo_categories?select=${CATEGORY_FIELDS}&order=sort_order.asc,created_at.asc&limit=1000`,
  );
  if (!Array.isArray(rows)) throw new Error('todo_categories 返回数据异常，已中止写入');
  return rows;
}

async function writeGuard(ctx, label, flags) {
  // --json 时回显走 stderr，避免 wb-mcp 把确认信息误判为结构化结果。
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
  console.error('⛔ 非 TTY 环境写操作需 --yes');
  process.exitCode = 2;
  return false;
}

function assertCategoryName(name) {
  const value = normalized(name);
  if (!value) throw new Error('分类名称不能为空');
  if (value.length > NAME_MAX) throw new Error(`分类名称不能超过 ${NAME_MAX} 字`);
  return value;
}

function assertDescription(description) {
  const value = normalized(description);
  if (value.length > DESCRIPTION_MAX) throw new Error(`分类描述不能超过 ${DESCRIPTION_MAX} 字`);
  return value || null;
}

export function register(registry, ctx) {
  registry.register('todo-category', {
    summary: '待办分类管理（add/del；删除时引用待办自动归回「工作」）',
    lines: [
      '  todo-category add <名称> [--parent 父分类] [--description 描述] [--yes]',
      '  todo-category del <名称> [--yes]                         删除分类（内置五类不可删）',
    ],
    handler: cmdTodoCategory,
    domain: 'todo',
    write: true,
    confirmNeed: true,
    params: [
      { name: 'name', type: 'string', required: true, positional: true, maxLen: NAME_MAX, desc: '分类名称' },
      { name: 'parent', type: 'string', desc: '父分类名称（可选，须唯一精确匹配）' },
      { name: 'description', type: 'string', maxLen: DESCRIPTION_MAX, desc: '分类描述，供 AI 判类参考' },
    ],
    resultFields: ['created', 'deleted', 'affected'],
  });

  async function cmdTodoCategory(flags, pos) {
    const sub = pos[0];
    if (sub === 'add') return await cmdAdd(flags, pos);
    if (sub === 'del') return await cmdDel(flags, pos);
    throw new Error('用法：todo-category add <名称> [--parent 父分类] [--description 描述] 或 todo-category del <名称>');
  }

  async function cmdAdd(flags, pos) {
    const name = assertCategoryName(pos[1]);
    const description = assertDescription(flags.description);
    const rows = await fetchCategories(ctx);

    if (exactMatches(rows, name).length) throw new Error(`待办分类「${name}」已存在`);

    let parentId = null;
    let parentName = null;
    if (typeof flags.parent === 'string' && normalized(flags.parent)) {
      parentName = assertCategoryName(flags.parent);
      const parents = exactMatches(rows, parentName);
      if (!parents.length) throw new Error(`父分类「${parentName}」不存在`);
      if (parents.length > 1) throw new Error(`父分类「${parentName}」有 ${parents.length} 个同名分类，请在网页端先用唯一名称整理`);
      parentId = parents[0].id;
    }

    const label = `新增待办分类「${name}」${parentName ? `（父级：${parentName}）` : ''}`;
    if (!(await writeGuard(ctx, label, flags))) return;

    const payload = {
      name,
      parent_id: parentId,
      description,
      sort_order: rows.length + 1,
    };
    const result = await ctx.api('POST', 'todo_categories?select=*', payload);
    const created = Array.isArray(result) ? result[0] : result;
    if (!created?.id) throw new Error('分类写入成功但返回数据异常，请用 table/search 复核');

    await ctx.logCli('cli_add', 'todo', created.id, {
      title: `新增待办分类「${name}」`,
      content: `父级：${parentName || '（一级分类）'}；描述：${description || '（空）'}`,
      type: '待办分类新增',
      table: 'todo_categories',
    });

    ctx.output({ created }, () => {
      console.log(`✅ 已新增待办分类「${created.name}」（id=${created.id}）`);
      console.log(`   父级：${parentName || '（一级分类）'}  排序：${created.sort_order ?? payload.sort_order}`);
      if (description) console.log(`   描述：${description}`);
    });
  }

  async function cmdDel(flags, pos) {
    const name = assertCategoryName(pos[1]);
    const rows = await fetchCategories(ctx);
    const matches = exactMatches(rows, name);
    if (!matches.length) throw new Error(`待办分类「${name}」不存在`);
    if (matches.length > 1) throw new Error(`待办分类「${name}」有 ${matches.length} 个同名行，请先用唯一名称整理`);
    const row = matches[0];

    if (PROTECTED_CATEGORY_NAMES.has(name)) {
      throw new Error(`「${name}」是内置分类，不允许删除`);
    }
    if (!rows.some((item) => normalized(item.name) === '工作')) {
      throw new Error('兜底分类「工作」不存在，已中止删除');
    }
    if (rows.some((item) => item.parent_id === row.id)) {
      throw new Error(`「${name}」下还有子分类，请先删除子分类`);
    }

    const affectedRows = await ctx.api(
      'GET',
      `todos?select=id&category=eq.${encodeURIComponent(name)}&limit=1000`,
    );
    if (!Array.isArray(affectedRows)) throw new Error('待办引用查询返回数据异常，已中止删除');
    const affected = affectedRows.length;

    const label = `删除待办分类「${name}」${affected ? `，${affected} 条待办将改为「工作」` : ''}`;
    if (!(await writeGuard(ctx, label, flags))) return;

    if (affected) {
      await ctx.api(
        'PATCH',
        `todos?category=eq.${encodeURIComponent(name)}&select=id`,
        { category: '工作' },
      );
    }
    await ctx.api('DELETE', `todo_categories?id=eq.${encodeURIComponent(row.id)}`);

    await ctx.logCli('cli_delete', 'todo', row.id, {
      title: `删除待办分类「${name}」`,
      content: `${affected} 条引用待办已改为「工作」`,
      type: '待办分类删除',
      table: 'todo_categories',
      affected,
    });

    const deleted = {
      id: row.id,
      name: row.name,
      parent_id: row.parent_id,
      description: row.description || null,
    };
    ctx.output({ deleted, affected }, () => {
      console.log(`✅ 已删除待办分类「${name}」（id=${row.id}）`);
      console.log(`   受影响待办：${affected} 条${affected ? '，已改为「工作」' : ''}`);
    });
  }
}

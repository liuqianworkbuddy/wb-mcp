# wb-mcp

AI 工作台 wb-cli 的 MCP server 壳（stdio transport）。把 wb-cli 命令族暴露为标准 MCP tool，
供 Codex / DeepSeek CLI / Claude Code / WorkBuddy 等 MCP 客户端直连。

> 版本：5.20.0 · 由主仓 \`scripts/release-wb-mcp.mjs\` 一键同步发布

## 三步安装（任意机器）

```bash
# 1. clone 本仓库（或从主仓跑 release 脚本生成）
git clone <repo-url> wb-mcp && cd wb-mcp

# 2. 安装唯一依赖
npm install

# 3. 验证（应输出 serverInfo name=wb-mcp 握手成功）
npm run probe
```

## 四端配置（mcp.json）

**WorkBuddy / Claude Code / Codex（stdio）**

```json
{
  "mcpServers": {
    "wb": {
      "command": "node",
      "args": ["<本仓库绝对路径>/scripts/wb-mcp.mjs"],
      "env": { "WB_PROFILE": "workbuddy" }
    }
  }
}
```

**DeepSeek CLI/TUI**

```json
{
  "mcp": {
    "wb": {
      "command": "node",
      "args": ["<本仓库绝对路径>/scripts/wb-mcp.mjs"],
      "env": { "WB_PROFILE": "workbuddy" }
    }
  }
}
```

## key 档位（WB_PROFILE）

| 档位 | 权限 | 说明 |
|------|------|------|
| workbuddy | 全权（admin key） | 默认；写操作仍需 confirm:true |
| openclaw | 读写 | 部分写权限 |
| hermes | 只读 | 双保险：只注册 wb_query tool + readonly key |

key 文件位置：\`~/.workbuddy/agents/<profile>.env\`（WB_API_KEY=wbk_xxx）。
新机器首次使用前，请在工作台网页「设置 → API Key」自助签发并写入该文件。

## 6 个 tool

| tool | 域 | 说明 |
|------|-----|------|
| wb_query | 只读调阅 | search/table/fill/growth/canvas/artifact/log/decision/orpt/people |
| wb_todo | 待办闪念 | todo/capsule/idea/bug/book/schedule |
| wb_note | 笔记 | note 命令族 |
| wb_fin | 财务 | fin 命令族 |
| wb_manage | 管理 | add/done/key |
| wb_dev_task | 流水线 | dev-task 命令族 |

### 调用形态（v5.6.0 起两种，args 优先）

```js
// 字符串形态（传统）
{ command: "todo list --open" }

// args 数组形态（长文安全：正文原样传，不按空白切分）
{ command: "note add", args: ["note", "add", "这里500+字正文…", "#工作笔记"], confirm: true }
```

写操作（add/done/edit/del/stage/item 等）必须传 \`confirm: true\`，否则被安全门拒绝。

## 安全

- 三层写防线：confirm 意图门 → 串行队列 → 网关 RLS + key scope
- 敏感串（wbk_ 前缀 key、密码）发布前自动扫描，命中即中止

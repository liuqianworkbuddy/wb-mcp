# wb-mcp

AI 工作台 wb-cli 的 MCP server 壳（stdio transport）。把 wb-cli 命令族暴露为标准 MCP tool，
供 Codex / DeepSeek CLI / Claude Code / WorkBuddy 等 MCP 客户端直连。

> 版本：5.10.1 · 由主仓 `scripts/release-wb-mcp.mjs` 一键同步发布

## 官方仓库与安装来源

本仓库是唯一官方源：**https://github.com/liuqianworkbuddy/wb-mcp**

- 建议固定到 release tag 安装（如 `v5.10.1`），不要使用第三方 fork —— 代码公开，
  授权不公开：数据访问一律凭服务端签发的 wbk_ key，克隆代码本身拿不到任何数据。
- 仓库内不含任何密钥；密钥只存在于每台机器的 `~/.workbuddy/` 目录或环境变量中。

## 三步安装（任意机器）

```bash
# 1. clone 本仓库（建议固定 tag）
git clone --depth 1 -b v5.10.1 https://github.com/liuqianworkbuddy/wb-mcp.git wb-mcp && cd wb-mcp

# 2. 安装唯一依赖
npm install

# 3. 验证（应输出 serverInfo name=wb-mcp 握手成功）
npm run probe
```

## 首次授权（没有 key 装了也连不上）

1. 在工作台网页 **liflow.cn/settings/** 用站长密码自助签发一把 API Key（`wbk_` 前缀）。
2. 写入渠道文件 `~/.workbuddy/agents/<渠道名>.env`（见下节，权限档位一并写在这里）。
3. 重启 MCP server，用 `wb-cli doctor` 自检。

## 权限档位（WB_SCOPE）

权限由 key 自身的档位决定，在渠道文件里**显式声明**，与渠道名无关：

| WB_SCOPE | 档位 | MCP 工具 | 说明 |
|----------|------|----------|------|
| `admin` | 全权 | 全部 6 域 tool + 写工具 | 写操作仍需 confirm:true；仅限本人主力设备 |
| `readwrite` | 读写 | 全部 6 域 tool + 写工具 | 服务端按 key scope 拦截越权写 |
| `readonly` | 只读 | 仅 wb_query | 双保险：客户端不注册写工具 + 服务端拒绝写 |

渠道文件 `~/.workbuddy/agents/<渠道名>.env`（完整字段见 `.env.example`）：

```bash
WB_API_KEY=wbk_xxxxxxxxxxxxxxxx
WB_SCOPE=readonly        # admin / readwrite / readonly
```

- **渠道名（WB_PROFILE）只是 env 文件名**，不再决定权限；给不同 agent 建不同渠道文件即可。
- 未写 `WB_SCOPE` 时兼容旧约定：渠道名 `hermes` 视为只读，其余视为全量工具（服务端仍按 key 真实 scope 拦截）。
- **安全边界**：客户端声明的 scope 只决定本地注册哪些工具（体验层）；越权操作真正被拦截在
  服务端——ai-proxy 网关按 key 的 scope 校验 + 数据库 RLS。声明写错了也不会放行越权操作。
- key 可随时在 liflow.cn/settings 吊销（`revoked_at` 立即生效），或设过期时间。

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

## 6 个 tool

| tool | 域 | 说明 |
|------|-----|------|
| wb_query | 只读调阅 | search/table/fill/growth/canvas/artifact/log/decision/orpt/people |
| wb_todo | 待办闪念 | todo/capsule/idea/bug/book/schedule |
| wb_note | 笔记 | note 命令族 |
| wb_fin | 财务 | fin 命令族 |
| wb_manage | 管理 | add/done/key |
| wb_dev_task | 流水线 | dev-task 命令族 |

readonly 档位只注册 wb_query，不暴露任何写路径。

### 调用形态（v5.6.0 起两种，args 优先）

```js
// 字符串形态（传统）
{ command: "todo list --open" }

// args 数组形态（长文安全：正文原样传，不按空白切分）
{ command: "note add", args: ["note", "add", "这里500+字正文…", "#工作笔记"], confirm: true }
```

写操作（add/done/edit/del/stage/item 等）必须传 `confirm: true`，否则被安全门拒绝。

## 安全

- 四层防线：confirm 意图门 → 串行队列 → 网关按 key scope 校验 + 数据库 RLS
- 权限看 key 的 scope 档位，不看渠道名/产品名；服务端校验是最终防线
- 每把 key 有独立限流（rate_limit），可设过期、可即时吊销（liflow.cn/settings）
- 敏感串（wbk_ 前缀 key、密码）发布前自动扫描，命中即中止；`.env*` 已进 .gitignore

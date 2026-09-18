# context-budget · 上下文预算

**只把答案倒进上下文，原料留在瓶底。**

工具输出才是撑爆上下文窗口的元凶。一个 50 KB 的文件大约 1.3 万 token，而且
一旦进入对话，之后**每一轮请求都要重发**，直到被压缩掉。这个项目把分析工作搬进
沙箱，并用索引代替对话记录。

支持 **Cline**（扩展 + CLI）以及任何 MCP 客户端。

---

## 它到底做什么

| 层 | 工具 | 效果 |
|---|---|---|
| **沙箱** | `ctx_execute` `ctx_execute_file` `ctx_batch` | 子进程里跑分析，**只有 stdout 回来**。文件内容、日志、HTML 从不进入对话。 |
| **索引** | `ctx_index` `ctx_search` | 文档和命令输出切块存进 SQLite **FTS5**，之后再查，而不是现在粘进来。 |
| **强制** | Cline hooks | `PreToolUse` 在调用发生前重定向网页抓取、提醒超大读取。这是 ~60% 和 ~98% 效果的差别。 |
| **连续性** | `PreCompact` + `TaskResume` | 压缩前抓取一张 ≤2 KB 工作状态卡，压缩后交回，让被压缩或恢复的任务不会从"我们刚才在干嘛"重新开始。 |
| **度量** | `ctx_stats` | 每次调用都记录有多少字节留在了沙箱里。是测出来的，不是吹出来的。 |

### 在本仓库上的实测

```
$ npm run bench -- src

A. 朴素读法（每个文件一次原生 read_file）
   载荷     61.8 KB  ≈ 15,828 tokens
   外加每个文件一次工具往返（8 次往返）

B. ctx_execute（一个脚本，只回 stdout）
   载荷        57 B  ≈ 15 tokens
   一次往返，179 ms
```

> 这是**只算载荷**的对比，没有计入工具 schema 开销、路由规则和 prompt 缓存，
> 所以应当把它当作上限。真实会话请用 `context-budget stats` 看。

---

## 环境要求

- **Node.js ≥ 22.5** —— 知识库用的是内置 `node:sqlite` + FTS5，**无需原生编译**，
  不需要 `better-sqlite3`。
- Python / bash / PowerShell 可选，`context-budget doctor` 会告诉你装了哪些。

---

## 安装

```bash
npm install -g context-budget
```

### 跑安装程序

```bash
cd /path/to/your/project
context-budget setup          # 默认是 DRY RUN，只打印将要做的改动
context-budget setup --yes    # 真正执行
```

`setup` 是**真正的安装程序**，不是让你复制粘贴的配置片段。它会：

1. **装四个钩子** —— `PreToolUse`、`PostToolUse`、`PreCompact`、`TaskResume` ——
   同时写入工作区（`.clinerules/hooks/`、`.cline/hooks/`），加 `--global` 则写入
   `~/Documents/Cline/Hooks/`。
2. **找出这台机器上所有 Cline 安装。** 做法是枚举 `<编辑器>/User/globalStorage`
   目录、再挑出其中属于 Cline 的存储目录，而**不是**检查一份硬编码的编辑器名单——
   所以各种 fork 也能被发现。在作者机器上它找到了 VS Code 扩展、一个
   `codearts-agent` 安装、以及 CLI 三处。
3. **注册 MCP server**：往每个 `cline_mcp_settings.json` 的 `mcpServers` 里
   **只合并一个键**。它绝不替换整个文件、绝不动别的 server 条目，
   并且写之前先落一个带时间戳的 `.backup-…` 备份。
4. **自检**：验证路由逻辑，并确认每个生成的启动器指向的入口文件真实存在。

dry run 长这样：

```
Cline installs detected
  [ext] Code · saoudrizwan.claude-dev   mcp settings found, global rules, global hooks
  [cli] Cline CLI                       mcp settings found, global rules, global hooks

Hook + rules files: 17 to create, 0 to update, 0 already current
  create    .clinerules/context-budget.md   (routing rules)
  ...

MCP server registration
  update    Code · saoudrizwan.claude-dev → …/settings/cline_mcp_settings.json
            1 other server(s) preserved: mcp-filesystem

DRY RUN — nothing was written. Re-run with --yes to apply.
```

```bash
context-budget setup --global      # 全局规则 + hooks，对所有工作区生效
context-budget setup --hooks-only  # 只装 hook，不注册 MCP
context-budget setup --mcp-only    # 只注册 MCP，不装 hook
```

### 然后做它替你做不了的那一步

**Cline → Settings → Features → 勾选 "Enable Hooks"。**

不开这个开关，hook 文件存在但永不触发，效果就从"强制"退回"劝说"——
大约 98% 和 60% 的差别。

### 验证

```bash
context-budget doctor          # 运行时、存储、检测到的 Cline 安装、hook 自检
context-budget doctor --fix    # 修复因包移动而失效的启动器
```

想不等 agent 触发就确认 hook 真的会跑：

```bash
echo '{"tool_call":{"name":"fetch_web_content","input":{"url":"https://example.com"}}}' \
  | node "$(npm root -g)/context-budget/hooks/pretooluse.mjs"
# → {"cancel":true,"errorMessage":"redirected to ctx_execute — ..."}
```

### 卸载

```bash
context-budget uninstall          # 先说明会删什么
context-budget uninstall --yes    # 精确回滚 setup 做过的事
```

每个生成的文件都带 `context-budget:generated` 标记。卸载**只删带标记的文件**——
你自己在同一个目录里写的 `PreToolUse` hook 会被原样保留——并且只从
`mcpServers` 里移除 `context-budget` 这一个键，同样带备份。

---

## 工具

| 工具 | 用途 |
|---|---|
| `ctx_execute(language, code)` | 从数据里算出答案，只有 `console.log()` 的输出回来。 |
| `ctx_execute_file(path, language, code)` | 分析单个文件，内容绑定到变量 `content`。 |
| `ctx_batch(tasks, queries)` | **一次调用**跑多条命令，输出自动索引并在同一次往返里回答问题。 |
| `ctx_index(source, content)` | 把文档存起来，而不是粘进来。 |
| `ctx_search(queries, source?)` | 检索已索引的一切。把所有问题打包成一个数组。 |
| `ctx_stats(session?)` | 按工具统计省下的字节和 token。 |
| `ctx_doctor()` | 运行时、FTS5、存储路径自检。 |

### 什么时候**不该**用沙箱

- **你要接着编辑这个文件** → 用原生读取工具。编辑器需要精确字节来匹配。
- **输出很短而且你已知**（`pwd`、干净的 `git status`）→ 直接跑，沙箱只是多一层开销。
- **命令会改变状态**（`git commit`、`npm install`）→ 用原生工具。沙箱内的写入会被丢弃。
- **你需要浏览器交互**而不是抓取页面 → 用原生浏览器工具。

---

## 原理

**不变量**：一次沙箱调用返回给模型的内容永远不超过 `CB_MAX_OUTPUT_BYTES`
（默认 8 KB）。其余的被截断、被索引、或被丢弃。

**度量**：Node 运行时会被注入一段计量前导代码，统计脚本从磁盘、子进程、以及**网络
响应体**读进来的每一个字节（包含 `import { readFileSync } from "node:fs"` 这种具名
导入——做法是在源码层面重写 import 说明符）。`ctx_stats` 取"脚本打印的量"和"脚本
实际读的量"的较大者，所以沙箱里抓一个网页会按整页计功，而不是按它打印的三行。

两个诚实的限制：这是**下界**（只观测 `node:fs` / `node:fs/promises` /
`node:child_process` 和 `Response` 的 body 读取，且只对 Node 生效）；网络大小按
**解压后**的 body 计，不用 `Content-Length`——因为服务器报的是压缩后大小，
gzip 页面会低报 3–4 倍。

**检索**：按 markdown 标题切块、代码块不切断，用 `porter unicode61` 建索引。
中文会按**单字空格分隔**再入库——否则 SQLite 会把一整串汉字当成一个 token，
中文搜索直接失效。

---

## 你让它读网页时会发生什么

一句话：**默认它会读。** 钩子只提醒，不拦。

这是对"显而易见的设计"的一次刻意反转，原因来自 Cline 自己的源码：

1. **取消是任务级的，不是调用级的。** `CombinedHookRunner` 的注释写着
   "if ANY hook requests cancellation, the task will be cancelled"。硬拦一次抓取
   可能直接终结你整个任务——而且如果模型没切到 `ctx_execute`，你让它读网页，
   结果什么也没读到。
2. **注入的上下文只影响未来的决策。** Cline 的钩子文档明确说明 `PreToolUse`
   改不了它正在跑的那次调用。所以提醒拦不住**这一次**的载荷，它影响的是下一次。
   一个抓 5 个页面的会话，其中 4 次会走沙箱。

想要硬拦就设 `CONTEXT_BUDGET_FETCH=cancel`。它带三个安全阀：

- **可用性闸门** —— 如果检测到的任何 Cline 安装里都没注册 context-budget，
  说明 `ctx_execute` 根本调不到，拦截会让模型无路可走。此时自动降级为提醒并说明原因。
- **重试阀** —— 同一 URL 在 10 分钟内被拦两次后，第三次放行。一直重试的模型不会被困住。
- **白名单** —— `CONTEXT_BUDGET_FETCH_ALLOW=docs.internal,example.com`，或在存储根目录放
  `fetch-allow.json`。适用于需要 JS 渲染的站点——沙箱里的裸 `fetch()` 只会拿到空壳。

---

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `CONTEXT_BUDGET_DIR` | `~/.context-budget` | 存储根目录 |
| `CONTEXT_BUDGET_PROJECT` | `cwd` | 沙箱边界所在的工作区 |
| `CONTEXT_BUDGET_HOOKS` | `on` | 设为 `off` 可关闭 hook 路由 |
| `CONTEXT_BUDGET_FETCH` | `nudge` | 网页抓取策略：`nudge` \| `cancel` \| `off`，见下文 |
| `CONTEXT_BUDGET_FETCH_ALLOW` | — | 永不拦截的域名，逗号分隔，如 `docs.internal,example.com` |
| `CONTEXT_BUDGET_MCP_ASSUME` | — | `registered` \| `missing`，强制指定"改道目标是否存在"（便于测试） |
| `CB_MAX_OUTPUT_BYTES` | `8192` | 单次沙箱调用返回的 stdout 上限 |
| `CB_TIMEOUT_MS` | `30000` | 沙箱墙钟预算 |
| `CB_INDEX_TTL_MS` | `86400000` | 索引源的新鲜度窗口 |
| `CB_KB_TTL_MS` | `1209600000` | 知识库回收期限（14 天） |

CLI：`context-budget setup | uninstall | doctor [--fix] | stats | sources | index | search | purge | reset | mcp`。

---

## 它**故意不做**什么

- **不管模型怎么说话。** 强行要求简短会拉低编码 benchmark。这里只决定*数据往哪走*。
- **不改你的文件。** 沙箱写入会被丢弃，这正是设计意图。
- **不动你的 Cline 配置。** `init` 只写它自己创建的文件。偷偷改写用户配置是 hook 类
  工具失去信任的最快方式。
- **不联网、不上报。** 没有遥测、没有账号。数据全在本地 SQLite 里，
  `context-budget purge` 一键清空。

---

## 已知限制（先读再评价）

1. **Cline CLI 的 `--yolo` 模式会禁用 hooks。** 用 `--act` 或 `--plan`。
2. **扩展的 hook 路径是 `.clinerules/hooks/PreToolUse`**（无扩展名），并且需要在
   设置里勾选 "Enable Hooks"。Cline 官方示例用的是 bash；Windows 上 `init` 会额外
   生成一个 `.cmd`。**先用上面那条 echo 命令验证再信任它。**
3. **Cline 钩子的输出字段是 `contextModification`，不是 `context`。** 扩展校验的是
   `{ cancel, contextModification, errorMessage }`
   （`apps/vscode/src/core/hooks/hook-factory.ts`）；SDK 的文件钩子读的是
   `context`。本项目的钩子两个都发——因为写错是**静默失败**：钩子退出码 0，
   模型却永远看不到那句话。
4. **PreCompact 给的是临时文件。** Cline 传入 `contextJsonPath` / `contextRawPath`，
   钩子一返回就删除，所以必须在钩子内部完成抓取。我们构建一张 ≤2 KB 的工作状态卡
   并把完整历史索引起来；**在这一刻故意不注入任何东西**——现在注入的内容几秒后就会
   被压缩掉。状态卡由之后第一个触发的钩子交回：`TaskResume`，或者自动压缩后同一任务
   继续时的 `PreToolUse` / `PostToolUse`。
5. **Cline 扩展官方不支持 Windows 钩子。** Cline 自己的钩子文档写明钩子通过
   shebang 感知的 shell 执行，且 Windows "not currently supported"。`setup` 仍然会写
   `.cmd` 和 Node 原生 `.mjs` 启动器，但在 Windows 上请把钩子当作 best-effort：
   先用下面的 echo 命令验证再依赖路由。**沙箱工具本身不受影响**，各平台都能用。
6. **Cline 子代理访问不到 MCP server**，所以 `use_subagents` 里用不了沙箱工具。
5. **只有 Node 运行时被计量**，Python/bash/PowerShell 只统计 stdout 量，收益被低估。
6. **沙箱是进程边界，不是安全边界。** 黑名单和路径边界是防"粗心的 agent"，不是监狱。
   环境变量是**故意继承**的，这样 `gh`/`aws`/`kubectl` 能正常工作，而密钥不进上下文。

---

## 开发

```bash
npm test          # 39 个单元测试
npm run test:e2e  # 用真实 MCP 协议跟真实 server 对话
npm run bench -- src
```

## 许可证

MIT

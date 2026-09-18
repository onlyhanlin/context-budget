# context-budget · 上下文预算

**只把答案倒进上下文，原料留在瓶底。**

工具输出才是撑爆上下文窗口的元凶。一个 50 KB 的文件大约 1.3 万 token，而且
一旦进入对话，之后**每一轮请求都要重发**。context-budget 把分析搬进沙箱，
用索引代替对话记录。

一个 MCP server + 一组 Cline 钩子。任何 MCP 客户端都能用；钩子部分针对 Cline。

---

## 快速开始

```bash
# 1. 拿到 CLI（还没发到 npm，从仓库装）
git clone https://github.com/onlyhanlin/context-budget.git
cd context-budget && npm install && npm link

# 2. 安装 —— 先 DRY RUN，它什么都不会写
context-budget setup          # 只显示将要做的改动

#    下面两个**二选一**：
context-budget setup --yes              # 只装当前项目
context-budget setup --global --yes     # 装一次，所有项目生效

# 3. 自检
context-budget doctor
```

**选哪个？** 两种方式下 **MCP server 都是全局注册的**——它待在 Cline 的配置里，
不在你的项目里。这个选择只影响路由规则和钩子文件：`--global` 会把它们写进
`~/Documents/Cline/`，之后每个工作区都自动生效，不用再跑 `setup`。想单独调某个
仓库就用按项目的形式；想处处都有就用 `--global`。**两者可以并存。**

然后做那件谁都替你做不了的事：

> **Cline → Settings → Features → 勾选 "Enable Hooks"**，然后重启 Cline。

安装就这些。不想跑安装程序，看
[手工配置 MCP server](#3-手工配置-mcp-server)。

---

## 如果你是 AI agent，按这个执行

这一节是**用来执行的，不是用来读的**。从上往下走，看到 STOP 就停。

### 第 0 步 —— 检查前置条件

```bash
node --version      # 必须 >= 22.5（知识库用的是内置 node:sqlite + FTS5）
```

Node 低于 22.5 就**停下告诉用户**，没有绕过的办法。

### 第 1 步 —— 安装 CLI

```bash
git clone https://github.com/onlyhanlin/context-budget.git /tmp/context-budget
cd /tmp/context-budget
npm install
npm link
```

验证——必须打印 `0.1.0`（或更高）：

```bash
context-budget version
```

如果提示找不到 `context-budget`，说明 `npm link` 没写到 PATH 里。要么修 npm
prefix，要么跳过 link，改用下面「手工配置」里的绝对路径写法。

### 第 2 步 —— 先选范围，再 dry run

有两种范围。**先决定**，因为它决定了你到底需不需要 `cd`。

| | 全局（优先） | 当前项目 |
|---|---|---|
| 命令 | `context-budget setup --global` | 先 `cd <项目>` 再 `context-budget setup` |
| 路由规则 | `~/Documents/Cline/Rules/context-budget.md` | `<项目>/.clinerules/context-budget.md` |
| 钩子 | `~/Documents/Cline/Hooks/` | `<项目>/.clinerules/hooks/` 和 `<项目>/.cline/hooks/` |
| 生效范围 | 所有工作区，立即 | 那一个工作区 |
| 每个项目都要再跑 | 不用 | 要 |

**用户没明确说"就这个仓库"时，选全局。** 对用户来说省事：装一次，处处生效。

两种范围下 **MCP server 都是全局注册的**——它在编辑器的配置文件里，不在项目里。
范围只决定路由规则和钩子文件写到哪里。

**全局 dry run 不需要 `cd`**，它完全不读当前目录：

```bash
context-budget setup --global        # 在任何目录都能跑
```

只有按项目安装才关心你在哪：

```bash
cd /path/to/the/users/project
context-budget setup
```

两种都会打印：

- 找到的每一处 Cline 安装，以及 `context-budget` 在其中是否已注册
- 将要创建 / 更新 / 保持不动的钩子和规则文件
- 将要合并进去的那段 MCP 配置

显示 `update` 而不是 `create`，说明文件本来就存在。显示 `CONFLICT`，说明用户
在我们需要的槽位里写了自己的钩子——**停下问清楚，别动它。**

### 第 3 步 —— 执行

用你刚才 dry run 的那个范围，**不要在一条指令里混用两种**。

```bash
context-budget setup --global --yes     # 装一次，所有项目生效
```

或者，已经 `cd` 进仓库之后：

```bash
context-budget setup --yes              # 只装当前项目
```

它只写自己拥有的文件（每个都带 `context-budget:generated` 标记），往每个
`cline_mcp_settings.json` 里只合并一个键，并且在改动前落一个带时间戳的
`.backup-…` 备份。

应该会看到自检块，全行必须是 `[x]`：

```
Verification
  [x] a page fetch is surfaced to the model
  [x] the editor tool is never interrupted
  [x] a noisy command is nudged toward ctx_batch
  [x] PostToolUse nudges an oversized tool result
  [x] CONTEXT_BUDGET_FETCH=cancel really blocks the fetch
  [x] hook entry exists: pretooluse
  ...
```

出现 `[ ]` 就**原样报给用户，停下**。不要自己去改生成的文件。

### 第 4 步 —— STOP。请用户去开钩子

这一步你做不到。用用户的语言告诉他：

> 请打开 **Cline → Settings → Features**，勾选 **"Enable Hooks"**，然后重启 Cline。

不开这个开关，钩子文件躺在磁盘上但永不触发。效果从"强制"退回"劝说"——大约
98% 掉到 60%。**其它功能照常工作**，只是沙箱工具不再被自动使用。

### 第 5 步 —— 不等 agent，直接验证

```bash
echo '{"hookName":"PreToolUse","preToolUse":{"toolName":"fetch_web_content","parameters":{"url":"https://example.com"}}}' | context-budget hook pretooluse
```

预期——`contextModification` 非空：

```json
{"cancel":false,"contextModification":"Page fetches are better routed through the sandbox: ...","context":"..."}
```

如果只输出 `{"cancel":false}` 而没有 `contextModification`，说明钩子跑了但判定
无事可做——对这个载荷来说不对。

### 第 6 步 —— 确认工具可达

```bash
context-budget doctor
```

看 `cline` 那一段。用户正在用的编辑器必须显示 `mcp: registered`。显示
`NOT registered` 就重跑 `context-budget setup --yes`；还不行就按
[手工配置 MCP server](#3-手工配置-mcp-server) 通过 Cline 面板加进去。

### 出问题怎么办

| 症状 | 处理 |
|---|---|
| `context-budget: command not found` | 回到第 1 步。或改用绝对路径形式的 MCP 配置。 |
| doctor 里 `[ ] node:sqlite + FTS5` | Node 低于 22.5。停。 |
| doctor 里 `[ ] knowledge` / `[ ] ledger` | 存储根目录不可写。把 `CONTEXT_BUDGET_DIR` 指到可写路径再跑。 |
| `mcp: NOT registered` | 重跑 `context-budget setup --yes`，或手工注册。 |
| 钩子从不触发 | "Enable Hooks" 没开；或者 CLI 在 `--yolo` 模式（该模式按设计禁用钩子）。 |
| 对话里没有 `ctx_*` 工具 | MCP 没注册，或 Cline 没重启。 |
| 本来好好的，突然不灵了 | 包被移动了。`context-budget doctor --fix`。 |

**回滚**：`context-budget uninstall --yes` 只删除带标记的文件，并且只从
`mcpServers` 里移除 `context-budget` 一个键，同样带备份。

---

## 它做什么

| 层 | 工具 | 效果 |
|---|---|---|
| **沙箱** | `ctx_execute` `ctx_execute_file` `ctx_batch` | 子进程里跑分析，**只有 stdout 回来**。文件内容、日志、HTML 从不进入对话。 |
| **索引** | `ctx_index` `ctx_search` | 文档和命令输出切块存进 SQLite **FTS5**，之后再查，而不是现在粘进来。 |
| **强制** | Cline 钩子 | `PreToolUse` 在调用发生前重定向网页抓取、提醒超大读取。这是 ~60% 和 ~98% 效果的差别。 |
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

## 安装（详细版）

### 环境要求

- **Node.js ≥ 22.5。** 知识库用内置 `node:sqlite` + FTS5，**无需原生编译**，
  不需要 `better-sqlite3`。
- Cline。**扩展**能通过钩子拿到自动路由；任何 MCP 客户端都能拿到工具，但没有钩子。
- Python / bash / PowerShell / Windows 批处理是 `ctx_execute` 的可选运行时，
  `context-budget doctor`
  会报告装了哪些。

### 1. 拿到 CLI

```bash
git clone https://github.com/onlyhanlin/context-budget.git
cd context-budget
npm install
npm link
```

`npm link` 会把 `context-budget` 放进 PATH。不做的话，下面所有命令都用
`node /path/to/context-budget/bin/cli.mjs` 代替。

将来会发到 npm，目前仓库是唯一来源。

### 2. 跑安装程序

```bash
cd /path/to/your/project
context-budget setup          # 默认 DRY RUN，只打印将要做的改动
context-budget setup --yes    # 只装当前项目（想全局生效见 2b）
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

MCP server config (what setup writes; paste it by hand if your file was not detected):
{ "mcpServers": { "context-budget": { ... } } }

DRY RUN — nothing was written. Re-run with --yes to apply.
```

```bash
context-budget setup --hooks-only  # 只装钩子，不注册 MCP
context-budget setup --mcp-only    # 只注册 MCP，不装钩子
```

### 2b. 全局安装 —— 装一次，所有项目生效

**MCP server 本来就是全局的。** 它待在**编辑器**的配置文件里，不在项目里，
所以注册一次就覆盖你之后打开的所有工作区。

按项目跑 `setup` 额外装的是路由规则和钩子文件。不想在每个仓库里都跑一遍：

```bash
context-budget setup --global --yes
```

它会写进 Cline 自己的全局目录，所有工作区都会读到：

| 内容 | 位置 |
|---|---|
| 路由规则 | `~/Documents/Cline/Rules/context-budget.md` |
| 钩子 | `~/Documents/Cline/Hooks/PreToolUse`、`PostToolUse`、`PreCompact`、`TaskResume`（Windows 下是 `.ps1`） |

全局钩子和工作区钩子**都会跑**——Cline 会执行它找到的每一个钩子目录。
所以项目只能给全局集合做加法，关不掉它。

> **一个钩子槽位只放一个文件。** Cline 只按一个确切文件名查找，所以如果
> `~/Documents/Cline/Hooks/PreToolUse` 已经是你自己写的钩子，`setup` 会报
> **CONFLICT** 并原样保留，绝不覆盖。合并或移走它，再重跑。

`context-budget uninstall --global --yes` 精确回滚，且只动带我们标记的文件。

### 3. 手工配置 MCP server

`setup` 会自动写入。下面这段是给它**写不了**的情况准备的——探测不到的编辑器、
便携版安装、被锁住不能改的配置文件、或者**根本不是 Cline** 的 MCP 客户端。
`context-budget mcp-config` 命令随时可以打印同一段内容；它是从安装程序写入的
同一份数据源生成的，不会漂移。

```json
{
  "mcpServers": {
    "context-budget": {
      "command": "context-budget",
      "args": ["mcp"],
      "disabled": false,
      "autoApprove": [
        "ctx_execute",
        "ctx_execute_file",
        "ctx_batch",
        "ctx_index",
        "ctx_search",
        "ctx_stats"
      ]
    }
  }
}
```

写到哪里：

| 客户端 | 位置 |
|---|---|
| Cline（VS Code / JetBrains） | Cline 面板里的 **MCP Servers → Configure MCP Servers**。它会自动打开正确的文件，比你自己猜路径稳。 |
| Cline CLI | `~/.cline/data/settings/cline_mcp_settings.json` |

几点说明：

- `"command": "context-budget"` 要求这个命令在 `PATH` 里
  （`npm install -g context-budget`，或在克隆目录里 `npm link`）。不想全局安装
  就用 `bin/cli.mjs` 的绝对路径：
  `"command": "node", "args": ["/abs/path/to/context-budget/bin/cli.mjs", "mcp"]`。
- `autoApprove` 是 **Cline** 的字段，别的客户端会忽略。不写进去也行，
  只是每次调用都会问你一下。
- `ctx_doctor` 故意没有放进自动批准：它是给人看的自检，不该让模型自己乱调。
- 这个 server 说的是标准 stdio MCP 协议，任何客户端都能用：

  ```json
  { "command": "context-budget", "args": ["mcp"] }
  ```

**两件事必须同时成立才生效**：

1. MCP server 已注册（就是上面那段），**并且**
2. **Cline → Settings → Features → 勾选 "Enable Hooks"**。

用 `context-budget doctor` 验证——它会列出找到的每一处 Cline 安装，以及
`context-budget` 在其中是否已注册。

### 4. 在 Cline 里打开钩子

> **Cline → Settings → Features → 勾选 "Enable Hooks"**，然后重启 Cline。

不开这个开关，钩子文件存在但永不触发，效果就从"强制"退回"劝说"——大约 98%
和 60% 的差别。**CLI 用户注意**：文件钩子在 `--yolo` 模式下按设计被禁用，
请用 `--act` 或 `--plan`。

### 5. 验证

```bash
context-budget doctor          # 运行时、存储、检测到的 Cline 安装、钩子自检
context-budget doctor --fix    # 修复因包移动而失效的启动器
```

想不等 agent 触发就确认钩子真的会跑：

```bash
echo '{"hookName":"PreToolUse","preToolUse":{"toolName":"fetch_web_content","parameters":{"url":"https://example.com"}}}' | context-budget hook pretooluse
# → {"cancel":false,"contextModification":"Page fetches are better routed through the sandbox: ..."}
```

### 6. 卸载

```bash
context-budget uninstall          # 先说明会删什么
context-budget uninstall --yes    # 精确回滚 setup 做过的事
```

每个生成的文件都带 `context-budget:generated` 标记。卸载**只删带标记的文件**——
你自己在同一个目录里写的 `PreToolUse` 钩子会被原样保留——并且只从
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
| `ctx_doctor()` | 运行时、FTS5、存储路径、检测到的 Cline 安装。 |

### 什么时候**不该**用沙箱

- **你要接着编辑这个文件** → 用原生读取工具。编辑器需要精确字节来匹配。
- **输出很短而且你已知**（`pwd`、干净的 `git status`）→ 直接跑，沙箱只是多一层开销。
- **命令会改变状态**（`git commit`、`npm install`）→ 用原生工具，这样用户看得见、
  也批准得了。**沙箱不是文件系统监狱**：它以你的权限、在你的项目目录里运行，
  写文件就是真的写了。
- **你需要浏览器交互**而不是抓取页面 → 用原生浏览器工具。

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
| `CONTEXT_BUDGET_HOOKS` | `on` | 设为 `off` 可关闭钩子路由 |
| `CONTEXT_BUDGET_FETCH` | `nudge` | 网页抓取策略：`nudge` \| `cancel` \| `off`，见下文 |
| `CONTEXT_BUDGET_FETCH_ALLOW` | — | 永不拦截的域名，逗号分隔，如 `docs.internal,example.com` |
| `CONTEXT_BUDGET_HOOK_ENTRY` | — | 覆盖生成启动器里写死的钩子入口路径 |
| `CONTEXT_BUDGET_MCP_ASSUME` | — | `registered` \| `missing`，强制指定"改道目标是否存在"（便于测试） |
| `CB_MAX_OUTPUT_BYTES` | `8192` | 单次沙箱调用返回的 stdout 上限 |
| `CB_TIMEOUT_MS` | `30000` | 沙箱墙钟预算 |
| `CB_INDEX_TTL_MS` | `86400000` | 索引源的新鲜度窗口 |
| `CB_KB_TTL_MS` | `1209600000` | 知识库回收期限（14 天） |

CLI：`context-budget mcp | setup | mcp-config | uninstall | doctor | stats | sources | index | search | purge | reset | hook | version`。

`setup` 参数：`--yes`（真正执行，默认是 dry run）· `--global`（规则和钩子写给所有工作区，
而不是当前这一个）· `--hooks-only` · `--mcp-only`。
`doctor` 参数：`--fix`。`uninstall` 参数：`--global`。

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
中文搜索直接失效。查询用 AND 匹配，无果时退到 OR，再退到子串扫描以支持部分标识符。

---

## 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| `context-budget: command not found` | `npm link` 没进 PATH | 修 npm prefix，或用 `node /path/bin/cli.mjs` |
| Cline 里没有 `ctx_*` 工具 | MCP 没注册，或 Cline 没重启 | `context-budget doctor` → `setup --yes` → 重启 |
| 钩子从不触发 | "Enable Hooks" 没开 | Settings → Features → 勾上 |
| CLI 里钩子不触发 | `--yolo` 按设计禁用钩子 | 用 `--act` 或 `--plan` |
| `[ ] node:sqlite + FTS5` | Node 低于 22.5 | 升级 Node |
| `[ ] knowledge` / `[ ] ledger`，提示 "unable to open database file" | 存储根目录不可写（网络盘、只读挂载、受限沙箱） | 把 `CONTEXT_BUDGET_DIR` 指到可写的本地路径 |
| `! could not enable WAL` | 该文件系统不支持 WAL | 无害；会自动退回到默认日志模式 |
| 中文检索查不到 | — | 不该发生（中文按单字分词）。真遇到就 `purge` 后重新索引 |
| 本来好好的，突然不灵了 | 升级后包被移动 | `context-budget doctor --fix` |
| `setup` 报某个文件 `SKIPPED` | 它要用的路径存在同名普通文件 | 把那个文件移开再跑 |

---

## 已知限制（先读再评价）

1. **钩子文件名是硬性契约，而且各平台不一样。** Cline 对每个钩子只找**一个**
   确切文件名（`apps/vscode/src/core/hooks/hook-factory.ts`）：

   | 平台 | 扩展钩子 | CLI 钩子 |
   |---|---|---|
   | Windows | `<名字>.ps1` —— **无扩展名文件会被忽略** | `<名字>.sh` |
   | macOS / Linux | 无扩展名的 `<名字>`，且必须有**可执行位** —— **`.ps1` 会被忽略** | `<名字>.sh` |

   写错那一个，钩子就永不触发，而且不会报任何错。`context-budget setup` 会按它运行的
   平台写正确的那个，`context-budget doctor` 会报告它找到了什么。Windows 上没有
   `chmod` 这回事，这正是需要 PowerShell 启动器的原因。
2. **Cline 钩子的输出字段是 `contextModification`，不是 `context`。** 扩展校验的是
   `{ cancel, contextModification, errorMessage }`
   （`apps/vscode/src/core/hooks/hook-factory.ts`）；SDK 的文件钩子读的是
   `context`。本项目的钩子两个都发——因为写错是**静默失败**：钩子退出码 0，
   模型却永远看不到那句话。
3. **PreCompact 给的是临时文件。** Cline 传入 `contextJsonPath` / `contextRawPath`，
   钩子一返回就删除，所以必须在钩子内部完成抓取。我们构建一张 ≤2 KB 的工作状态卡
   并把完整历史索引起来；**在这一刻故意不注入任何东西**——现在注入的内容几秒后就会
   被压缩掉。状态卡由之后第一个触发的钩子交回：`TaskResume`，或者自动压缩后同一任务
   继续时的 `PreToolUse` / `PostToolUse`。
4. **Cline 子代理访问不到 MCP server**，所以 `use_subagents` 里用不了沙箱工具。
5. **只有 Node 运行时被计量**，Python/bash/PowerShell/批处理 只统计 stdout 量，收益被低估。
6. **沙箱是进程边界，不是安全边界。** 黑名单和路径边界是防"粗心的 agent"，不是监狱。
   环境变量是**故意继承**的，这样 `gh`/`aws`/`kubectl` 能正常工作，而密钥不进上下文。

---

## 它**故意不做**什么

- **不管模型怎么说话。** 强行要求简短会拉低编码 benchmark。这里只决定*数据往哪走*。
- **它是上下文边界，不是文件系统监狱。** 沙箱脚本以你的权限在你的项目目录里运行，
  脚本写文件就是真的写了。这是**故意的**——沙箱得能 `readdir`、`readFile` 你的源码，
  否则毫无用处。它保证的是：**只有 `console.log()` 的输出进入对话**，原始字节一个都不进。
  真要改文件时用原生编辑工具，这样改动可见、可批准。
- **除一个键外不动你的 Cline 配置。** `init` 和 `setup` 只写自己拥有的文件，
  并且只往 `mcpServers` 合并一个条目。偷偷改写用户配置是钩子类工具失去信任的最快方式。
- **不联网、不上报。** 没有遥测、没有账号。数据全在本地 SQLite 里，
  `context-budget purge` 一键清空。

---

## 开发

```bash
npm test              # 69 个单元测试
npm run test:e2e      # 真实 MCP 协议 over stdio
npm run test:scenario # 钩子路由矩阵，真实进程
npm run test:workflow # 真实联网端到端
npm run test:audit    # 84 项：每个工具、每条 CLI 命令、每个钩子
npm run test:audit2   # 38 项：协议滥用、脏存储、并发
npm run test:audit3   # 30 项：数据丢失、检索质量、TTL
npm run test:recipe   # 53 项：把本文档里的安装步骤真跑一遍
npm run test:all      # 以上全部
npm run bench -- src  # 载荷对比
```

## 许可证

MIT

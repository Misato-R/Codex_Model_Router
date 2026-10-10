# Codex Model Router

TypeScript 模型路由器，默认使用本地规则做 dry-run。也可显式调用 TypeSafe Jev API 做语义分类，再把结果映射到 Codex 模型档位：

| 档位 | 默认模型 | reasoning effort |
| --- | --- | --- |
| cheap | `gpt-6-luna` | low |
| standard | `gpt-6.1-sol` | medium |
| hard | `gpt-6-astra` | high |

默认映射与当前机器 Codex CLI 暴露的模型目录相匹配。可用 `--model-cheap`、`--model-standard`、`--model-hard` 覆盖单次运行，或设置 `ROUTER_MODEL_CHEAP`、`ROUTER_MODEL_STANDARD`、`ROUTER_MODEL_HARD` 环境变量。CLI 的 `-m` 只覆盖该次调用，不写入全局配置。

## 使用

```powershell
cd "C:\Projects\Codex_Model_Router"
npm ci
npm test
npm run typecheck

# 仅显示分类、模型、参数，不启动 Codex
npm run dev -- --project "D:\MyProject" --task "解释 router.ts"

# 使用 Jev 做一次语义分类，只调用 Jev，不调用 Codex
npm run dev -- --project "D:\MyProject" --task "解释 router.ts" --router jev --classify

# 真正调用已登录的 Codex CLI / ChatGPT 会话
npm run dev -- --project "D:\MyProject" --task "检查项目结构" --mode balanced --run

# 使用官方 TypeScript SDK adapter 执行 Codex 任务
npm run dev -- --project "D:\MyProject" --task "分析项目" --adapter sdk --run

# 先让 Jev 选择档位，再由 Codex SDK 执行（会调用两个在线服务）
npm run dev -- --project "D:\MyProject" --task "分析项目" --router jev --adapter sdk --run
```

## 自动路由聊天入口（连续开发）

新入口直接连接 **Codex App Server**：每轮先用 Jev 分类，再在同一个 `threadId` 上调用 `turn/start`，传入所选的 `model` 和 `effort`。不经过外层 Codex 聊天、不创建 SDK 子会话、不额外调用模型生成交接摘要。已有 MCP 入口仍保留，两者是不同路径。

在普通 CMD 中运行（不要在 Codex 聊天输入框输入这些启动命令）：

```cmd
cd /d "C:\Projects\Codex_Model_Router"
npm run chat -- --check
npm run chat
```

PowerShell 切换目录用 `cd "C:\Projects\Codex_Model_Router"`，不加 `/d`；若阻止 `npm.ps1`，用 `npm.cmd`。本文所有示例项目路径均需替换为你本机实际的克隆目录或目标项目目录。

出现 `你 >` 后直接提问，例如先输入“解释 src/router.ts，不要修改文件”，下一轮输入“刚才说的 quality 模式具体怎么调整档位？”。默认使用 `jev / balanced / read-only`，会真实调用 Jev 与 Codex。需要已有 `codex login` 的 ChatGPT 登录，以及 `TYPESAFE_API_KEY`（支持 Windows setx 回退读取）。`--check` 只检查登录、Key 是否存在及模型目录，不验证 Key 有效性、不调用 Jev 或 Codex 推理。

允许项目内修改或指定其他项目：

```cmd
npm run chat -- --project "D:\MyProject" --sandbox workspace-write
```

`workspace-write` 授权后续项目内编辑，不是每次编辑都会询问。需要额外权限的命令/文件操作会显示确认，只有输入 `y` 才单次批准，其余拒绝。非交互 `--task` 模式拒绝所有权限确认。此简化入口不支持额外权限集合授权、密钥输入和 MCP 表单，这些请求会明确拒绝。不会写入全局 Codex 配置或自动切换为 OpenAI API Key 计费。

### 会话与上下文

- 默认使用项目下的 `default` 命名会话，重启入口会自动恢复；用 `--session feature-a` 区分不同工作。
- 模型变化仍使用相同会话。每轮显示最终模型、推理强度、来源、置信度及会话 ID。`quality` 可将 Jev 的 cheap 提升到 standard，`economy` 将 hard 限制到 standard。
- `.router-memory/chat/<名称>.json` 保存会话 ID、项目路径和最多三条近期问题片段。完整历史由 Codex 保存，退出不会删除。记录不含密钥，不应提交版本库。
- Jev 接收本轮问题、模式及最多三条近期用户问题片段（每条前 500 字符）。没有额外 LLM 总结，不自动向 TypeSafe 发送完整回答或源码。本地规则仍只根据本轮问题分类，可能误判含糊追问。
- **不会自动继承官方 CLI/桌面另一个聊天的历史。** 首次创建从空历史开始，此后持续保留。`--resume THREAD_ID` 可显式恢复已有同项目会话；此时 Codex 加载原历史，但 Jev 的近期问题片段起初为空。
- 历史受上下文窗口及压缩机制影响，不能无限逐字保留。模型切换可能影响缓存命中率，Token 统计不等于 ChatGPT 剩余额度或节省比例。
- 同一命名会话有文件锁，阻止两个入口同时写入。不要在官方客户端和此入口同时操作同一个 `threadId`。

| 命令 | 功能 |
| --- | --- |
| `/status` / `/models` | 查看当前会话设置 / 模型目录 |
| `/mode balanced` / `/mode economy` / `/mode quality` | 设置后续路由模式 |
| `/router jev` / `/router rules` | 选择在线分类 / 本地规则 |
| `/sandbox read-only` / `/sandbox workspace-write` | 设置后续任务权限 |
| `/paste` | 粘贴多行，单独一行 `/end` 提交 |
| `/new` | 下次输入创建新会话；显示旧 ID，旧历史不删除 |
| `/cancel` 或运行中 Ctrl+C | 取消本轮，仍可继续会话 |
| `/quit` | 取消未完成任务并退出 |

空闲时 Ctrl+C 退出。重启时模式、路由、权限按启动参数设置，默认 `balanced / jev / read-only`，不会自动恢复上次更宽的写权限。

```cmd
:: 为命名会话创建新历史
npm run chat -- --session feature-a --new
:: 恢复指定会话（ID 从 /status 获取）
npm run chat -- --session feature-a --resume THREAD_ID
:: 执行一轮后退出，下次继续同一个会话
npm run chat -- --session feature-a --task "解释刚才修改的目的"
:: 规则分类不调用 Jev，但 Codex 执行仍产生用量
npm run chat -- --router rules
```

支持 `--model-cheap/standard/hard` 及 `ROUTER_MODEL_*` 覆盖映射。模型或推理强度不在目录时会报错，不悄悄替换。Jev API 出错停止本轮；置信度低于 0.5 时使用本地规则。

入口使用 SDK 依赖中安装的原生 Codex 运行时，Windows 不经过 `.cmd` shell 拼接；支持 `CODEX_PATH` 指向原生可执行文件。回答实时显示，长任务每 30 秒提示等待，没有旧 MCP 工具的 300 秒等待上限。连接控制请求有 30 秒确认超时，超时不会自动重发任务。`/cancel` 用于取消任务。

`npm test` 模拟外部服务，覆盖同会话模型参数、恢复、提前完成事件、取消、断连、认证/模型校验、文件锁、stdio 通信及 0.5 边界，不产生模型用量；`npm run typecheck` 检查类型。

## 在 Codex CLI 和桌面版中使用 MCP

本机 `.codex/` 配置不进入版本库；仓库提供无密钥示例 `examples/codex.config.toml`。首次部署时，先将仓库克隆到本机并安装锁定依赖，再复制示例（以下为 PowerShell）：

```powershell
cd "C:\Projects\Codex_Model_Router"
npm ci
New-Item -ItemType Directory -Force .codex | Out-Null
# 仅首次配置时复制；已有配置请手动合并，避免覆盖。
Copy-Item examples/codex.config.toml .codex/config.toml
```

编辑 `.codex/config.toml` 的 `cwd`，将 `C:/Projects/Codex_Model_Router` 替换为本机克隆目录的绝对路径。Windows TOML 路径建议使用 `/`，若使用 `\` 则需转义。确保 `node` 在 PATH 中，启动 Codex 的进程能继承已配置的 `TYPESAFE_API_KEY`，并已完成所需的 Codex 登录。不要将实际密钥写入示例或配置。项目不会自动加载 `.env`；若自行使用此类文件，应由启动方式将变量注入进程环境。

在 Codex 信任此项目后，该配置为此工作区注册本地 MCP 工具 `jev_model_router.jev_route_and_run`。CLI 和 Codex 桌面版均可读取项目级 MCP 配置；重新打开项目/新建会话后，在工具列表确认此工具已连接。`AGENTS.md` 会指导 Codex 在此工作区收到实际任务时调用该工具。Codex 只会为已信任的项目加载 `.codex/` 配置。

工具会把任务文字发给 Jev 选择档位，再通过 Codex SDK 启动一个单独的 Codex 线程执行。默认 `sandboxMode` 为 `read-only`；只有确实要求改文件时才传 `workspace-write`。这不会改变当前对话线程的模型，也不会自动接管其他工作区的会话。若要在其他项目里使用，需要为那个项目也配置 MCP，或之后安装成用户级插件；本项目配置不修改全局 Codex 设置。

开始前，要确保启动 Codex 的进程能读取 `TYPESAFE_API_KEY`。如果刚用 `setx` 保存过变量，完全退出并重新打开 Codex 后，新进程才会继承它。密钥值不会写进 `.codex/config.toml`；该配置只允许 MCP 子进程继承这个环境变量名。

使用 Jev 前需要 TypeSafe API Key。PowerShell 当前窗口可临时设置：

```powershell
$env:TYPESAFE_API_KEY = "你的 TypeSafe API Key"
```

CMD 当前窗口可临时设置：

```cmd
set TYPESAFE_API_KEY=你的TypeSafeAPIKey
```

密钥只从环境变量读取，不能写进代码。`--router jev --classify` 会向 TypeSafe 发出一次计费 API 请求，但不会调用 Codex；`--router jev --run` 会先请求 Jev 分类，再调用选中的 Codex 模型。普通规则 dry-run 不联网。

Windows MCP 环境兼容：如果 Codex 宿主没有把变量传给 Router 子进程，Router 会回退读取 `setx` 保存的用户或系统环境变量注册表项。读取仅发生在 Jev 调用时，密钥不会输出到日志或写进项目配置。

模式说明：

- `--router rules`（默认）：按本地关键词和长度规则分类，不需要网络或 Jev API Key。
- `--router jev`：把任务描述提交给 Jev，在 cheap、standard、hard 中做语义选择。置信度低于 50% 时回退到本地规则；Jev API 错误会明确报错，不会悄悄改走其他路线。
- `balanced`：简单说明任务选择 cheap；普通开发选择 standard；复杂跨模块、架构、安全和并发任务选择 hard。
- `economy`：通常选 cheap，复杂任务最高到 standard。
- `quality`：普通任务选 standard，复杂任务选 hard。

## 执行与认证

- CLI adapter 是默认执行器，通过本机 Codex CLI 运行 `codex exec`，传入 `-C` 项目目录、`-s workspace-write`、实际 `-m` 模型及 reasoning effort。
- Windows 优先定位 `codex.exe` 并以 `shell: false` 启动，避免经过命令 shell 解释项目路径。若使用非标准安装位置，可设置 `CODEX_PATH` 指向 `codex.exe`。
- SDK adapter 延迟加载 `@openai/codex-sdk`，并通过 `Codex.startThread()` 执行；该 SDK 包装 Codex CLI，因此沿用 CLI 已有的 ChatGPT 登录态。Router 不读写 Codex 凭证，也不要求 OpenAI API Key。
- `--run` 才会发起模型调用并可能修改指定项目。运行记录写在目标项目的 `.router-memory` 目录中。
- 默认 dry-run 不启动 Codex、不调用 Jev，也不写入运行记录。使用 `--classify` 是显式请求一次 Jev API 判断。

## 扩展点

`TaskExecutor` 是 CLI 与 SDK 共用接口；`AgentRuntime` / `RuntimeExecutor` 保留 LangChain/LangGraph 扩展接口，路由与执行分离。单次执行入口的 Jev 只接收 `--task` 和模式，聊天入口额外传入有限近期问题片段；Jev 不自动读取源码。单次执行入口使用文件摘要记忆；新 `npm run chat` 入口通过 App Server 恢复 Codex 会话。`ChatSession` 使用可替换的 `RpcConnection`，分类与会话执行独立。

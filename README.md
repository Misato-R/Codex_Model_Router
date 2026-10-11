# Codex Model Router

Jev Router 会先判断任务适合哪个模型档位，再让 Codex 使用该档位回答。它提供原版 Codex CLI 中转、连续聊天入口、桌面版实验入口，也可以作为 Codex 的 MCP 工具使用。

| 档位 | 默认模型 | 推理强度 |
| --- | --- | --- |
| cheap | `gpt-6-luna` | low |
| standard | `gpt-6.1-sol` | medium |
| hard | `gpt-6-astra` | high |

## 开始之前

- 安装 Node.js 和 Codex CLI，并完成 `codex login`。Codex 登录负责执行任务。
- 在线路由还需要 TypeSafe API Key，变量名为 `TYPESAFE_API_KEY`。它只供 Jev 分类使用，与 Codex 登录分开。
- 把本仓库下载到本机，在 Router 项目目录安装依赖：

```powershell
cd "输入 Router 项目路径"
npm ci
```

## 配置 Jev API Key（Windows）

本地规则路由不需要 API Key；选择 Jev 在线判断时才需要。不要把 Key 发到聊天、提交到 Git，或写入代码、命令参数和项目配置。项目不会自动读取 `.env`。

### 临时用于当前 PowerShell 窗口

运行后会安全提示输入 Key，输入内容不会显示。然后在**同一个窗口**启动 Router：

```powershell
$env:TYPESAFE_API_KEY = [System.Net.NetworkCredential]::new("", (Read-Host "TypeSafe API Key" -AsSecureString)).Password
if ($env:TYPESAFE_API_KEY) { "已读取到 Jev Key" } else { "未读取到 Jev Key" }
npm run cli -- --project "输入目标项目路径"
```

也可以将最后一行换成 `npm run chat` 或 `npm run desktop -- --project "输入目标项目路径"`。关闭窗口后，临时变量会失效。

### 长期保存到当前 Windows 用户

1. 在 Windows 搜索并打开“编辑账户的环境变量”，在“用户变量”中选择“新建”。
2. 变量名填 `TYPESAFE_API_KEY`，变量值填你的 TypeSafe Key，然后保存。
3. 完全退出并重新打开终端或 Codex。已运行的程序不会自动读取新值。
4. 在新 PowerShell 窗口中安全检查变量是否存在：

```powershell
if ($env:TYPESAFE_API_KEY) { "已读取到 Jev Key" } else { "未读取到 Jev Key" }
```

变量存在不代表 Key 有效。运行以下命令可发出一次真实 Jev 分类请求验证；它只调用 Jev，不会调用 Codex：

```powershell
npm run dev -- --project "输入目标项目路径" --task "解释 router.ts" --router jev --classify
```

`npm run chat -- --check` 只检查 Key 是否存在，不验证它能否调用 Jev。

## 选择使用入口

先在终端进入 Router 项目目录，再按需要选择一个入口。把示例中的项目路径换成你希望 Codex 使用的项目目录。

### 原版 Codex CLI（推荐）

```powershell
npm run cli -- --project "输入目标项目路径"
```

保留 Codex 原版终端界面、命令和会话上下文。默认每个新问题先由 Jev 选档，再在同一会话中回答。可用原版 `/model`、`/status` 等命令；自动模式会为下一轮重新应用路由结果。若要由你手动选模型并停用 Jev：

```powershell
npm run cli -- --manual
```

恢复已有 Codex 会话：

```powershell
npm run cli -- --resume THREAD_ID
```

### 连续聊天入口

```powershell
npm run chat -- --project "输入目标项目路径"
```

默认使用 Jev、`balanced` 模式和只读权限。会话会保留在同一 Codex thread；再次启动可恢复命名会话。输入 `/help` 查看命令。常用命令：`/status`、`/mode economy`、`/mode balanced`、`/mode quality`、`/router jev`、`/router rules`、`/sandbox workspace-write`、`/paste`、`/new`、`/cancel` 和 `/quit`。

可以用 `--session 名称` 区分会话，用 `--resume THREAD_ID` 恢复项目内已有会话。若希望允许 Codex 修改项目：

```powershell
npm run chat -- --project "输入目标项目路径" --sandbox workspace-write
```

### ChatGPT/Codex 桌面版实验入口

先完全退出桌面应用（包括托盘），然后运行：

```powershell
npm run desktop -- --project "输入目标项目路径" --router jev
```

它会启动原版桌面界面，并路由指定项目中的**本地 Codex 会话**。普通 ChatGPT 云端聊天不会经过 Router。退出实验启动的桌面应用后，再从原快捷方式启动即可回到普通入口。桌面升级后若无法启动，可先运行 `npm run desktop -- --check` 查看环境检查结果。

### 单次任务或只查看路由结果

默认只用本地规则预览，不调用模型：

```powershell
npm run dev -- --project "输入目标项目路径" --task "解释 router.ts"
```

使用 Jev 分类一次，不调用 Codex：

```powershell
npm run dev -- --project "输入目标项目路径" --task "解释 router.ts" --router jev --classify
```

加 `--run` 才会执行任务。添加 `--router jev` 可在执行前调用 Jev；比如：

```powershell
npm run dev -- --project "输入目标项目路径" --task "分析项目" --router jev --adapter sdk --run
```

## 路由模式

Jev 根据任务内容选择 cheap、standard 或 hard；路由模式决定如何使用这个判断：

| 模式 | Jev 判断 cheap | Jev 判断 standard | Jev 判断 hard |
| --- | --- | --- | --- |
| `economy` 节省优先 | cheap | standard | standard |
| `balanced` 平衡 | cheap | standard | hard |
| `quality` 质量优先 | standard | standard | hard |

置信度低于 0.5 时，Router 改用本地规则判断。`--router rules` 完全使用本地规则，不请求 Jev；Jev 请求失败时当前任务会报错，不会自动提交给 Codex。

## 数据与常见问题

- Jev 会收到本轮问题用于分类。连续聊天和 CLI 中转还会提供最多三条近期用户问题片段；Jev 不会自动读取或发送整个项目源码和回答。请勿提交不适合发送到 TypeSafe 的内容。
- Codex 执行使用你的 ChatGPT 登录。Jev 在线分类会向 TypeSafe 发出 API 请求；本地规则分类不产生 Jev 请求。
- 模型路由日志保存在 `.router-memory`，不记录问题正文、回答或 API Key。不要提交本机配置文件或密钥。
- 提示找不到 Jev Key 时，确认变量名拼写为 `TYPESAFE_API_KEY`，然后重新打开启动 Router 的终端和应用。桌面中转需要从配置好变量的终端启动。
- 如果使用 `rules` 模式，系统不会调用 Jev；这是无需 API Key 的本地分类方式。

## Codex MCP（可选）

MCP 方式会把任务交给 Jev 分类，再由独立的 Codex 执行线程处理；它不会改变当前聊天正在使用的模型，也不会自动接续当前聊天上下文。只在需要此方式时配置：

1. 在 Router 项目目录运行 `npm ci`。
2. 将 `examples/codex.config.toml` 复制为 `.codex/config.toml`，把其中的 `cwd` 改成 Router 项目的实际路径。Windows 路径可使用 `/`。
3. 确保 `TYPESAFE_API_KEY` 已按上文配置，并让 Codex 重新打开此项目。
4. 在 Codex 的工具列表确认 `jev_model_router` 已连接。

不要覆盖已有的 `.codex/config.toml`；应将示例内容合并进去。项目级配置只对这个 Router 工作区生效。

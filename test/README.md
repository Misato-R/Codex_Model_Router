# 每轮耗时与 Token 用量记录

先完全退出桌面应用，在 Router 根目录运行：

```powershell
npm run record:timing -- desktop --project "输入项目路径"
```

脚本会启动桌面 Router。保持这个终端窗口打开，在该项目的本地 Codex 会话里提问。每轮结束后，`test/log/turn-<requestId>.json` 保存一份 JSON。按 Enter 或 Ctrl+C 停止记录，桌面应用仍可使用。关闭记录脚本后不会继续写入计时日志。已启动的普通桌面进程不能事后挂接计时，需要通过此脚本重新启动。

CLI 也可使用：

```powershell
npm run record:timing -- cli --project "输入项目路径"
```

CLI 退出时记录自动停止。启动选项与原来的 `desktop`、`cli` 一致，支持路由模式、模型覆盖和 CLI 会话恢复。普通 `npm run desktop` / `npm run cli` 不启用测试计时。

## JSON 字段

日志格式为 `schemaVersion: 2`，同一 JSON 同时保存耗时与 Codex Token 用量。启动和停止方式不变。

`durationsMs` 中的数值均为毫秒，使用单调时钟计算：

| 字段 | 边界 |
| --- | --- |
| `jevRequest` | Jev HTTP 请求开始到完整响应解析结束，包含网络与服务端等待；也记录失败请求的耗时 |
| `routing` | 中转接收新问题到转发 `turn/start`，包含预检、Jev 或规则判断和参数检查 |
| `codex` | 转发 `turn/start` 到收到 `turn/completed`，包含提交等待、生成、工具执行和人工审批等待 |
| `total` | 中转接收问题到完成事件；失败时为到失败检测点的耗时 |

Jev 请求是 routing 的子项，不能再重复加到总耗时。正常完成时 `total = routing + codex`（可能有小量四舍五入误差）。本地规则或手动模式的 `jevRequest` 为 `null`；尚未提交即失败的 `routing`、`codex` 为 `null`。断线记录 `disconnected-outcome-unknown`，不代表服务端任务已经停止。单独比较成功完成的任务，不把超时、取消和断线当成快速完成。

## Token 用量

`tokenUsage.counts` 表示本轮 Codex 用量，取同一会话累计值在提交前后的差值，不把每次通知相加。这样可包含一个问题中多次模型调用（如读取代码、调用工具后继续回答），也避免把历史会话的消耗算进本轮。

| 字段 | 含义 |
| --- | --- |
| `totalTokens` | 后端报告的本轮总 Token |
| `inputTokens` | 本轮各次模型调用的输入，包括重复携带的上下文 |
| `cachedInputTokens` | 输入中命中缓存的部分，已经包含在输入统计中 |
| `cacheWriteInputTokens` | 缓存写入用量；旧版本没有提供时为 `null` |
| `outputTokens` | 输出 Token |
| `reasoningOutputTokens` | 输出中的推理部分，不应再加到输出或总量中 |

`tokenUsage.availability` 为 `reported` 时有可靠起始值及后端统计；`baseline-unavailable` 表示恢复旧会话时未收到起始统计；`not-reported` 表示后端未提供用量；`counter-reset` 表示累计计数回退，无法可靠计算差值。无法确定时 `counts` 为 `null`，而不是假装用量为 0。单个未提供的字段也为 `null`。

`threadTotal` 保留会话累计用量供核对；`lastModelResponse` 是最近一次模型调用的用量，**不能视为整个问题的用量**。重复通知不会重复计数；完成事件之后的用量通知会更新同一份 JSON，原有耗时保持不变。建议在收到最终用量更新后收集日志。

这些数字只统计 Codex 后端报告的用量，不包含 Jev，也不代表 ChatGPT 额度百分比或实际费用。未在当前连接中报告的调用、独立子会话以及未知服务端消耗不能凭本日志补算。比较实验时同时检查状态和 `availability`，不要把缺失统计或中途失败与正常完成混算。

每份日志包含 `requestId`、`threadId`、`turnId`、时间戳、状态和模型参数，不保存提问正文、回答、源码或 API key。仅统计新的用户轮次；未管理项目、活动轮次中的追加输入和工具续接不单独计时。桌面点击发送前的排队、接收完成事件之后的界面渲染，以及应用启动耗时不在四项统计范围内。日志目录已加入 Git 忽略规则。

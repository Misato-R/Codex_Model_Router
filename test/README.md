# 每轮耗时记录

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

`durationsMs` 中的数值均为毫秒，使用单调时钟计算：

| 字段 | 边界 |
| --- | --- |
| `jevRequest` | Jev HTTP 请求开始到完整响应解析结束，包含网络与服务端等待；也记录失败请求的耗时 |
| `routing` | 中转接收新问题到转发 `turn/start`，包含预检、Jev 或规则判断和参数检查 |
| `codex` | 转发 `turn/start` 到收到 `turn/completed`，包含提交等待、生成、工具执行和人工审批等待 |
| `total` | 中转接收问题到完成事件；失败时为到失败检测点的耗时 |

Jev 请求是 routing 的子项，不能再重复加到总耗时。正常完成时 `total = routing + codex`（可能有小量四舍五入误差）。本地规则或手动模式的 `jevRequest` 为 `null`；尚未提交即失败的 `routing`、`codex` 为 `null`。断线记录 `disconnected-outcome-unknown`，不代表服务端任务已经停止。单独比较成功完成的任务，不把超时、取消和断线当成快速完成。

每份日志包含 `requestId`、`threadId`、`turnId`、时间戳、状态和模型参数，不保存提问正文、回答、源码或 API key。仅统计新的用户轮次；未管理项目、活动轮次中的追加输入和工具续接不单独计时。桌面点击发送前的排队、接收完成事件之后的界面渲染，以及应用启动耗时不在四项统计范围内。日志目录已加入 Git 忽略规则。

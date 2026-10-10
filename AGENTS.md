# Jev Model Router

The `npm run chat` App Server client performs routing before starting each turn in the same thread. When its developer instructions say routing has already happened, execute the task directly; do not call the MCP router or invoke the router through shell commands. The MCP guidance below applies to ordinary Codex host sessions, not this direct chat client.

When the user asks Codex to perform a task in this workspace, use the `jev_model_router.jev_route_and_run` MCP tool to classify it with Jev and execute it with the selected Codex model. Pass the user's complete task and this workspace's absolute path. Keep `sandboxMode` as `read-only` unless the user asks Codex to change files; use `workspace-write` only for those requested changes.

Do not call the routing tool for ordinary questions about the project that can be answered directly, or for requests that explicitly ask only for a dry-run/classification. Explain that tool execution uses Jev plus a separate Codex SDK thread and does not change the model of the current conversation. Never ask the user to reveal or paste the TypeSafe API key; it must be configured as `TYPESAFE_API_KEY` in the environment inherited by Codex.

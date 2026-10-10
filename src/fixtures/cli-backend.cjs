// Offline stdio peer. Never invokes Codex, Jev, or any model endpoint.
const { createInterface } = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "offline-fixture" } });
  else if (message.method === "account/read") send({ id: message.id, result: { account: { type: "chatgpt" } } });
  else if (message.method === "model/list") send({ id: message.id, result: { data: [{ model: "fixture", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: null } });
  else if (message.method === "fixture/env") send({ id: message.id, result: { keyPresent: !!process.env.TYPESAFE_API_KEY, tokenPresent: !!process.env.ROUTER_CLI_REMOTE_TOKEN, pid: process.pid } });
  else if (message.method === "turn/start") {
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: "fixture-turn", status: "inProgress" } } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "fixture-turn", status: "completed" } } });
    send({ id: message.id, result: { turn: { id: "fixture-turn", status: "completed" }, received: message.params } });
  } else send({ id: message.id, result: { method: message.method, received: message.params } });
});

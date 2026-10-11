const rl = require('node:readline').createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const results = {
    initialize: {}, 'account/read': { account: { type: 'chatgpt' } },
    'model/list': { data: [{ model: 'fixture', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] },
    'config/read': { config: {} }, 'thread/start': { thread: { id: 'fixture-thread' } },
    'turn/start': { turn: { id: 'fixture-turn', status: 'inProgress' } },
  };
  send({ id: m.id, result: results[m.method] ?? {} });
  if (m.method === 'turn/start') {
    const usage = { method: 'thread/tokenUsage/updated', params: { threadId: 'fixture-thread', turnId: 'fixture-turn',
      tokenUsage: { total: { totalTokens: 150, inputTokens: 100, cachedInputTokens: 20, outputTokens: 50, reasoningOutputTokens: 10 },
        last: { totalTokens: 40 } } } };
    send(usage); send(usage);
    send({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } } });
  }
});
rl.on('close', () => process.exit(0));

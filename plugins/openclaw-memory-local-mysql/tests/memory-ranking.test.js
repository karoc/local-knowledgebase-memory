const test = require('node:test');
const assert = require('node:assert/strict');

const pluginModule = require('../dist/index.js');
const plugin = pluginModule.default || pluginModule;

const TEST_PREFIX = `[phase3-ranking-${Date.now()}]`;

function fakeEmbedding(text) {
  const base = text.split('').reduce((acc, ch, idx) => acc + ch.charCodeAt(0) * (idx + 1), 0);
  return Array.from({ length: 8 }, (_, i) => ((base + i * 31) % 997) / 997);
}

function createApiStub() {
  const tools = new Map();
  const api = {
    pluginConfig: {
      mysql: {
        host: process.env.MEMORY_TEST_MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MEMORY_TEST_MYSQL_PORT || 3307),
        user: process.env.MEMORY_TEST_MYSQL_USER || 'root',
        password: process.env.MEMORY_TEST_MYSQL_PASSWORD || 'openclaw_root_2024',
        database: process.env.MEMORY_TEST_MYSQL_DB || 'openclaw_memory'
      },
      ollama: { baseUrl: 'http://fake-ollama.local', model: 'fake-embed', dimensions: 8 },
      autoRecall: false,
      autoCapture: false,
      minRecallScore: 0,
      rankingMode: 'hybrid',
      rankingDebug: true
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    registerTool(tool) { tools.set(tool.name, tool); },
    on() {}
  };
  return { api, tools };
}

test.before(async () => {
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body || '{}');
    return {
      ok: true,
      async json() { return { embedding: fakeEmbedding(body.prompt || '') }; }
    };
  };
});

test('hybrid ranking prefers higher confidence/importance on same similarity', async () => {
  const { api, tools } = createApiStub();
  await plugin.register(api);

  const store = tools.get('memory_store').execute;
  const list = tools.get('memory_list').execute;
  const update = tools.get('memory_update').execute;
  const recall = tools.get('memory_recall').execute;

  const content = `${TEST_PREFIX} 排序测试共同文本`;
  const sessionKey = `rank-sess-${Date.now()}`;
  await store('r1', { content, scope: 'session', sessionKey, source: 'manual', confidence: 0.1, importance: 1 });
  await store('r2', { content, scope: 'session', sessionKey, source: 'manual', confidence: 0.1, importance: 1 });

  const listed = await list('r3', { agentId: 'default', scope: 'session', sessionKey, limit: 20, offset: 0 });
  const obj = JSON.parse(listed.content[0].text);
  const items = obj.items.filter((x) => String(x.content || '').includes(TEST_PREFIX));
  assert.ok(items.length >= 2, 'should find inserted ranking test rows');

  const older = items[items.length - 1];
  const newer = items[0];

  await update('r4', { memoryId: older.id, confidence: 1, importance: 5 });
  await update('r5', { memoryId: newer.id, confidence: 0.1, importance: 1 });

  const recalled = await recall('r6', {
    query: `${TEST_PREFIX} 排序测试共同文本`,
    agentId: 'default',
    scope: 'session',
    sessionKey,
    minScore: 0,
    limit: 5
  });

  const text = recalled?.content?.[0]?.text || '';
  const firstBlock = text.split('\n\n')[0] || '';
  assert.ok(firstBlock.includes(TEST_PREFIX), 'top recalled block should be our test memory');
  assert.ok(firstBlock.includes('debug='), 'ranking debug should be included');
});

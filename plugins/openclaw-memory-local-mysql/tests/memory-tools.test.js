const test = require('node:test');
const assert = require('node:assert/strict');

const pluginModule = require('../dist/index.js');
const plugin = pluginModule.default || pluginModule;

const TEST_PREFIX = `[phase3-tools-${Date.now()}]`;

function fakeEmbedding(text) {
  const base = text
    .split('')
    .reduce((acc, ch, idx) => acc + ch.charCodeAt(0) * (idx + 1), 0);
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
      minRecallScore: 0
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
    const prompt = body.prompt || '';
    return {
      ok: true,
      async json() {
        return { embedding: fakeEmbedding(prompt) };
      }
    };
  };
});

test('phase3 tools: list/update/explain', async () => {
  const { api, tools } = createApiStub();
  await plugin.register(api);

  const store = tools.get('memory_store').execute;
  const list = tools.get('memory_list').execute;
  const update = tools.get('memory_update').execute;
  const explain = tools.get('memory_explain').execute;

  await store('t1', { content: `${TEST_PREFIX} 记录A`, memoryKey: 'phase3.tool.key', scope: 'global', source: 'manual' });

  const listed = await list('t2', { agentId: 'default', memoryKey: 'phase3.tool.key', limit: 5, offset: 0 });
  const listObj = JSON.parse(listed.content[0].text);
  assert.ok(Array.isArray(listObj.items) && listObj.items.length >= 1, 'memory_list should return items');

  const memoryId = listObj.items[0].id;
  const updated = await update('t3', { memoryId, content: `${TEST_PREFIX} 记录A-更新`, confidence: 0.7, tags: ['phase3', 'tools'] });
  assert.ok(updated.content[0].text.includes('更新成功'));

  const explained = await explain('t4', { memoryId });
  const expObj = JSON.parse(explained.content[0].text);
  assert.equal(expObj.mode, 'memoryId');
  assert.equal(expObj.memoryId, memoryId);
  assert.ok(Array.isArray(expObj.chain), 'explain should return chain');

  const explainedByQuery = await explain('t5', { query: `${TEST_PREFIX} 记录A-更新`, agentId: 'default' });
  const qObj = JSON.parse(explainedByQuery.content[0].text);
  assert.equal(qObj.mode, 'query');
});

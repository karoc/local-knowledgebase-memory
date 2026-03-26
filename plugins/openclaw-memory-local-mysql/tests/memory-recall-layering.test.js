const test = require('node:test');
const assert = require('node:assert/strict');

const pluginModule = require('../dist/index.js');
const plugin = pluginModule.default || pluginModule;

const TEST_PREFIX = `[phase3-layering-${Date.now()}]`;

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
      rankingMode: 'hybrid'
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
    return { ok: true, async json() { return { embedding: fakeEmbedding(body.prompt || '') }; } };
  };
});

test('recall layering: rule + project fact + vector', async () => {
  const { api, tools } = createApiStub();
  await plugin.register(api);

  const store = tools.get('memory_store').execute;
  const recall = tools.get('memory_recall').execute;

  const layeringSessionKey = `layer-sess-${Date.now()}`;

  await store('l1', {
    content: `${TEST_PREFIX} 规则：回复保持极简并包含验证命令`,
    category: 'workflow',
    memoryKey: 'workflow.reply.keep_concise',
    scope: 'session',
    sessionKey: layeringSessionKey,
    source: 'manual',
    confidence: 1,
    importance: 5
  });

  await store('l2', {
    content: `${TEST_PREFIX} 项目事实：memory 插件正式路径 /srv/project-openclaw-memory/plugins/openclaw-memory-local-mysql`,
    category: 'project_fact',
    memoryKey: 'project.openclaw_memory.official_path',
    scope: 'session',
    sessionKey: layeringSessionKey,
    source: 'manual',
    confidence: 1,
    importance: 5
  });

  await store('l3', {
    content: `${TEST_PREFIX} 向量补充：这是补充说明文本`,
    category: 'general',
    scope: 'session',
    sessionKey: layeringSessionKey,
    source: 'manual',
    confidence: 1,
    importance: 5
  });

  const res = await recall('l4', {
    query: `${TEST_PREFIX} 请按规则给出项目路径并附补充说明`,
    agentId: 'default',
    scope: 'session',
    sessionKey: layeringSessionKey,
    minScore: 0,
    limit: 12
  });

  const text = res?.content?.[0]?.text || '';
  assert.ok(text.includes('workflow.reply.keep_concise') || text.includes('规则：回复保持极简'), 'should include rule layer');
  assert.ok(text.includes('project.openclaw_memory.official_path') || text.includes('项目事实'), 'should include project fact layer');
  assert.ok(text.includes('向量补充'), 'should include vector supplement layer');
});

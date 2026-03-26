const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

const pluginModule = require('../dist/index.js');
const plugin = pluginModule.default || pluginModule;

const TEST_PREFIX = `[concurrency-test-${Date.now()}]`;
const KEY = 'user.output.style';

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
      ollama: {
        baseUrl: 'http://fake-ollama.local',
        model: 'fake-embed',
        dimensions: 8
      },
      autoRecall: false,
      autoCapture: false,
      minRecallScore: 0.0,
      sessionTtlDays: 7
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {}
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
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

test('concurrent store keeps single active for unique key', async () => {
  const { api, tools } = createApiStub();
  await plugin.register(api);

  const memoryStore = tools.get('memory_store').execute;

  const pool = await mysql.createPool({
    host: process.env.MEMORY_TEST_MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MEMORY_TEST_MYSQL_PORT || 3307),
    user: process.env.MEMORY_TEST_MYSQL_USER || 'root',
    password: process.env.MEMORY_TEST_MYSQL_PASSWORD || 'openclaw_root_2024',
    database: process.env.MEMORY_TEST_MYSQL_DB || 'openclaw_memory',
    waitForConnections: true,
    connectionLimit: 4
  });

  try {
    await pool.execute("DELETE FROM memories WHERE agent_id = 'default' AND content LIKE ?", [`${TEST_PREFIX}%`]);

    const payloads = [
      `${TEST_PREFIX} 并发写入A：极简`,
      `${TEST_PREFIX} 并发写入B：详细`,
      `${TEST_PREFIX} 并发写入C：极简`,
      `${TEST_PREFIX} 并发写入D：详细`
    ];

    await Promise.all(payloads.map((content, i) =>
      memoryStore(`cc-${i}`, {
        content,
        scope: 'global',
        memoryKey: KEY,
        source: 'manual'
      })
    ));

    const [rows] = await pool.query(
      `SELECT id, status, content
       FROM memories
       WHERE agent_id = 'default' AND memory_key = ? AND content LIKE ?
       ORDER BY id`,
      [KEY, `${TEST_PREFIX}%`]
    );

    const active = rows.filter((r) => r.status === 'active');
    assert.equal(active.length, 1, `expected single active row, got ${active.length}`);
  } finally {
    await pool.execute("DELETE FROM memories WHERE agent_id = 'default' AND content LIKE ?", [`${TEST_PREFIX}%`]);
    await pool.end();
  }
});

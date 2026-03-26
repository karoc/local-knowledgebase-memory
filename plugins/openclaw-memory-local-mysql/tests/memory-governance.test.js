const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

const pluginModule = require('../dist/index.js');
const plugin = pluginModule.default || pluginModule;

const MYSQL_HOST = process.env.MEMORY_TEST_MYSQL_HOST || '127.0.0.1';
const MYSQL_PORT = Number(process.env.MEMORY_TEST_MYSQL_PORT || 3307);
const MYSQL_USER = process.env.MEMORY_TEST_MYSQL_USER || 'root';
const MYSQL_PASSWORD = process.env.MEMORY_TEST_MYSQL_PASSWORD || 'openclaw_root_2024';
const MYSQL_DB = process.env.MEMORY_TEST_MYSQL_DB || 'openclaw_memory';
const TEST_AGENT = 'default';
const TEST_PREFIX = `[governance-test-${Date.now()}]`;

function fakeEmbedding(text) {
  const base = text
    .split('')
    .reduce((acc, ch, idx) => acc + ch.charCodeAt(0) * (idx + 1), 0);
  return Array.from({ length: 8 }, (_, i) => ((base + i * 31) % 997) / 997);
}

function createApiStub() {
  const tools = new Map();
  const handlers = new Map();
  const api = {
    pluginConfig: {
      mysql: {
        host: MYSQL_HOST,
        port: MYSQL_PORT,
        user: MYSQL_USER,
        password: MYSQL_PASSWORD,
        database: MYSQL_DB
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
    on(event, fn) {
      handlers.set(event, fn);
    },
    __tools: tools,
    __handlers: handlers
  };
  return api;
}

async function createPool() {
  return mysql.createPool({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DB,
    waitForConnections: true,
    connectionLimit: 4
  });
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

test('memory governance migration + store/recall flow', async () => {
  const api = createApiStub();
  await plugin.register(api);

  const memoryStore = api.__tools.get('memory_store').execute;
  const memoryRecall = api.__tools.get('memory_recall').execute;

  const pool = await createPool();
  const sessionKey = `sess-test-${Date.now()}`;
  try {
    await pool.execute('DELETE FROM memories WHERE agent_id = ? AND content LIKE ?', [TEST_AGENT, `${TEST_PREFIX}%`]);

    // 1) migration fields exist
    const [cols] = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'memories' AND column_name IN (
         'scope','memory_key','status','source','confidence','ttl_type','expires_at',
         'project_id','session_key','use_count','last_used_at','supersedes_id','replaced_by_id'
       )`,
      [MYSQL_DB]
    );
    assert.ok(cols.length >= 13, 'migration columns missing');

    // 2) session default TTL
    await memoryStore('tc-1', {
      content: `${TEST_PREFIX} 当前会话临时偏好：保持简短`,
      scope: 'session',
      sessionKey,
      memoryKey: 'tc.session.temp.pref',
      source: 'manual'
    });

    const [sessionRows] = await pool.query(
      `SELECT ttl_type, expires_at FROM memories
       WHERE agent_id = ? AND session_key = ? AND content LIKE ?
       ORDER BY id DESC LIMIT 1`,
      [TEST_AGENT, sessionKey, `${TEST_PREFIX}%`]
    );
    assert.equal(sessionRows.length, 1);
    assert.equal(sessionRows[0].ttl_type, 'expiring');
    assert.ok(sessionRows[0].expires_at, 'session expires_at should be auto-filled');

    // 3) duplicate / refine / conflict & unique active
    const styleSessionKey = `style-sess-${Date.now()}`;
    await memoryStore('tc-2', {
      content: `${TEST_PREFIX} [case] 输出风格：极简`,
      scope: 'session',
      sessionKey: styleSessionKey,
      memoryKey: 'user.output.style',
      source: 'manual',
      confidence: 1,
      importance: 5
    });

    await memoryStore('tc-3', {
      content: `${TEST_PREFIX} [case] 输出风格：极简`,
      scope: 'session',
      sessionKey: styleSessionKey,
      memoryKey: 'user.output.style',
      source: 'manual',
      confidence: 1,
      importance: 5
    });

    await memoryStore('tc-4', {
      content: `${TEST_PREFIX} [case] 输出风格：详细`,
      scope: 'session',
      sessionKey: styleSessionKey,
      memoryKey: 'user.output.style',
      source: 'manual',
      confidence: 1,
      importance: 5
    });

    const [keyRows] = await pool.query(
      `SELECT id, status, use_count, supersedes_id, replaced_by_id, content
       FROM memories
       WHERE agent_id = ? AND scope = 'session' AND session_key = ? AND memory_key = 'user.output.style' AND content LIKE ?
       ORDER BY id`,
      [TEST_AGENT, styleSessionKey, `${TEST_PREFIX}%`]
    );

    const activeRows = keyRows.filter((r) => r.status === 'active');
    const supersededRows = keyRows.filter((r) => r.status === 'superseded');

    assert.equal(activeRows.length, 1, 'must keep single active row for unique key');
    assert.ok(supersededRows.length >= 1, 'should supersede older rows');
    assert.ok(
      keyRows.some((r) => r.replaced_by_id !== null) || keyRows.some((r) => r.supersedes_id !== null),
      'supersede linkage missing'
    );

    // 4) recall active + unexpired only + usage update
    await pool.execute(
      `INSERT INTO memories
      (agent_id, content, vector, category, importance, valid, scope, memory_key, status, source, confidence, ttl_type, expires_at)
      VALUES (?, ?, ?, 'temporary', 1, 1, 'global', 'tc.expired', 'active', 'manual', 0.8, 'expiring', DATE_SUB(NOW(), INTERVAL 1 DAY))`,
      [TEST_AGENT, `${TEST_PREFIX} 这是一条已过期记忆`, JSON.stringify(fakeEmbedding(`${TEST_PREFIX} 这是一条已过期记忆`))]
    );

    const recallRes = await memoryRecall('tc-5', {
      query: `${TEST_PREFIX} 输出风格`,
      agentId: TEST_AGENT,
      scope: 'session',
      sessionKey: styleSessionKey,
      minScore: 0
    });

    const recallText = recallRes?.content?.[0]?.text || '';
    assert.ok(recallText.includes('输出风格'), 'recall should include active preference memory');
    assert.ok(!recallText.includes(`${TEST_PREFIX} 这是一条已过期记忆`), 'expired memory must not be recalled');

    const [usageRows] = await pool.query(
      `SELECT use_count, last_used_at FROM memories
       WHERE agent_id = ? AND scope = 'session' AND session_key = ? AND memory_key = 'user.output.style' AND status = 'active' AND content LIKE ?
       ORDER BY id DESC LIMIT 1`,
      [TEST_AGENT, styleSessionKey, `${TEST_PREFIX}%`]
    );
    assert.ok(usageRows[0].use_count >= 1, 'use_count should increase after recall');
    assert.ok(usageRows[0].last_used_at !== null, 'last_used_at should be updated after recall');
  } finally {
    await pool.execute('DELETE FROM memories WHERE agent_id = ? AND content LIKE ?', [TEST_AGENT, `${TEST_PREFIX}%`]);
    await pool.end();
  }
});

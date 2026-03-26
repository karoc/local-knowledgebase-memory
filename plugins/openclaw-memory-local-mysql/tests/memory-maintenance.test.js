const test = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const SCRIPT = '/srv/project-openclaw-memory/scripts/memory-maintenance.js';

function dbConfig() {
  return {
    host: process.env.MEMORY_TEST_MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MEMORY_TEST_MYSQL_PORT || 3307),
    user: process.env.MEMORY_TEST_MYSQL_USER || 'root',
    password: process.env.MEMORY_TEST_MYSQL_PASSWORD || 'openclaw_root_2024',
    database: process.env.MEMORY_TEST_MYSQL_DB || 'openclaw_memory'
  };
}

test('memory-maintenance dry-run and apply', async () => {
  const prefix = `[phase3-maint-${Date.now()}]`;
  const pool = await mysql.createPool({ ...dbConfig(), waitForConnections: true, connectionLimit: 2 });

  try {
    const sessionKey = `maint-sess-${Date.now()}`;
    await pool.execute(
      `INSERT INTO memories
      (agent_id, content, vector, category, importance, valid, scope, session_key, status, source, confidence, ttl_type, expires_at, created_at, updated_at)
      VALUES
      ('default', ?, '[]', 'temporary', 1, 1, 'session', ?, 'active', 'manual', 0.5, 'expiring', DATE_SUB(NOW(), INTERVAL 1 DAY), DATE_SUB(NOW(), INTERVAL 31 DAY), DATE_SUB(NOW(), INTERVAL 31 DAY)),
      ('default', ?, '[]', 'temporary', 1, 0, 'session', ?, 'superseded', 'manual', 0.5, 'permanent', NULL, DATE_SUB(NOW(), INTERVAL 40 DAY), DATE_SUB(NOW(), INTERVAL 40 DAY))`,
      [`${prefix} expired`, sessionKey, `${prefix} superseded-old`, sessionKey]
    );

    const dry = await execFileAsync('node', [SCRIPT, '--dry-run', '--expire-now', '--soft-prune']);
    const dryObj = JSON.parse(dry.stdout.trim());
    assert.ok(dryObj.actions.expire_now.matched >= 1, 'dry-run should match expired rows');
    assert.ok(dryObj.actions.soft_prune.matched >= 1, 'dry-run should match prune rows');

    const apply = await execFileAsync('node', [SCRIPT, '--expire-now', '--soft-prune']);
    const applyObj = JSON.parse(apply.stdout.trim());
    assert.ok(applyObj.actions.expire_now.affected >= 1, 'apply should expire rows');
    assert.ok(applyObj.actions.soft_prune.affected >= 1, 'apply should prune rows');

    const [rows] = await pool.query(
      `SELECT content, status, valid FROM memories WHERE content LIKE ? ORDER BY id DESC`,
      [`${prefix}%`]
    );
    const expired = rows.find((r) => String(r.content).includes('expired'));
    const pruned = rows.find((r) => String(r.content).includes('superseded-old'));

    assert.equal(expired.status, 'expired');
    assert.equal(Number(expired.valid), 0);
    assert.equal(pruned.status, 'deleted');
  } finally {
    await pool.execute(`DELETE FROM memories WHERE content LIKE ?`, [`${prefix}%`]);
    await pool.end();
  }
});

#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const path = require('path');

function resolveMysql() {
  try {
    return require('mysql2/promise');
  } catch (_) {
    const pluginMysql = path.join(__dirname, '..', 'plugins', 'openclaw-memory-local-mysql', 'node_modules', 'mysql2', 'promise.js');
    return require(pluginMysql);
  }
}

const mysql = resolveMysql();

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    dryRun: args.has('--dry-run'),
    expireNow: args.has('--expire-now'),
    softPrune: args.has('--soft-prune')
  };
}

async function main() {
  const { dryRun, expireNow, softPrune } = parseArgs(process.argv);

  if (!expireNow && !softPrune) {
    console.error('Usage: node scripts/memory-maintenance.js [--dry-run] [--expire-now] [--soft-prune]');
    process.exit(1);
  }

  const host = process.env.MEMORY_TEST_MYSQL_HOST || '127.0.0.1';
  const port = Number(process.env.MEMORY_TEST_MYSQL_PORT || 3307);
  const user = process.env.MEMORY_TEST_MYSQL_USER || 'root';
  const password = process.env.MEMORY_TEST_MYSQL_PASSWORD || 'openclaw_root_2024';
  const database = process.env.MEMORY_TEST_MYSQL_DB || 'openclaw_memory';

  const pool = await mysql.createPool({ host, port, user, password, database, waitForConnections: true, connectionLimit: 2 });

  try {
    const report = {
      dryRun,
      database,
      actions: {}
    };

    if (expireNow) {
      const [expiredRows] = await pool.query(
        `SELECT COUNT(*) AS c
         FROM memories
         WHERE status = 'active' AND valid = 1 AND expires_at IS NOT NULL AND expires_at <= NOW()`
      );
      const expireCount = Number(expiredRows[0]?.c || 0);
      report.actions.expire_now = { matched: expireCount, affected: 0 };

      if (!dryRun && expireCount > 0) {
        const [res] = await pool.execute(
          `UPDATE memories
           SET status = 'expired', valid = 0, updated_at = NOW()
           WHERE status = 'active' AND valid = 1 AND expires_at IS NOT NULL AND expires_at <= NOW()`
        );
        report.actions.expire_now.affected = Number(res.affectedRows || 0);
      }
    }

    if (softPrune) {
      const [pruneRows] = await pool.query(
        `SELECT COUNT(*) AS c
         FROM memories
         WHERE status = 'superseded'
           AND valid = 0
           AND COALESCE(use_count,0) <= 1
           AND COALESCE(last_used_at, updated_at, created_at) < DATE_SUB(NOW(), INTERVAL 30 DAY)`
      );
      const pruneCount = Number(pruneRows[0]?.c || 0);
      report.actions.soft_prune = { matched: pruneCount, affected: 0 };

      if (!dryRun && pruneCount > 0) {
        const [res2] = await pool.execute(
          `UPDATE memories
           SET status = 'deleted', updated_at = NOW()
           WHERE status = 'superseded'
             AND valid = 0
             AND COALESCE(use_count,0) <= 1
             AND COALESCE(last_used_at, updated_at, created_at) < DATE_SUB(NOW(), INTERVAL 30 DAY)`
        );
        report.actions.soft_prune.affected = Number(res2.affectedRows || 0);
      }
    }

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[memory-maintenance] failed:', err && err.message ? err.message : err);
  process.exit(1);
});

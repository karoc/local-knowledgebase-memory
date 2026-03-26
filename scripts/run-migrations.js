#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_ROOT = path.join(PROJECT_ROOT, 'infrastructure', 'mysql', 'migrations');
const ENV_PATH = path.join(PROJECT_ROOT, 'infrastructure', '.env');

const EXIT = {
    OK: 0,
    ERROR: 1
};

function readEnvFile(envPath) {
    const env = {};
    if (!fs.existsSync(envPath)) return env;
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1).trim();
        env[key] = value;
    }
    return env;
}

function getEnvVar(env, key, fallback) {
    if (process.env[key]) return process.env[key];
    if (env[key]) return env[key];
    return fallback;
}

function checksumSql(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function listSqlFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...listSqlFiles(fullPath));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.sql')) {
            files.push(fullPath);
        }
    }
    return files.sort((a, b) => a.localeCompare(b));
}

function fileVersion(filePath) {
    const base = path.basename(filePath);
    const match = base.match(/^(\d+)_/);
    return match ? match[1] : '000';
}

function relativeSqlPath(filePath) {
    return path.relative(MIGRATIONS_ROOT, filePath).replace(/\\/g, '/');
}

function listDatabaseDirs(rootDir) {
    if (!fs.existsSync(rootDir)) return [];
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
}

function execMysql(args, sql) {
    const fullArgs = ['exec', '-i', ...args, '-e', sql];
    try {
        const out = execFileSync('docker', fullArgs, { encoding: 'utf8' });
        return out.trim();
    } catch (err) {
        const stderr = err && err.stderr ? String(err.stderr) : '';
        const message = stderr || (err && err.message ? err.message : String(err));
        throw new Error(message);
    }
}

function execMysqlScript(container, user, password, database, sqlText) {
    const args = buildMysqlArgs(container, user, password, database);
    const fullArgs = ['exec', '-i', ...args];
    try {
        execFileSync('docker', fullArgs, { encoding: 'utf8', input: sqlText });
    } catch (err) {
        const stderr = err && err.stderr ? String(err.stderr) : '';
        const message = stderr || (err && err.message ? err.message : String(err));
        throw new Error(message);
    }
}

function buildMysqlArgs(container, user, password, database) {
    const args = [container, 'mysql', `-u${user}`];
    if (password) args.push(`-p${password}`);
    args.push('-N', '-B');
    if (database) args.push('-D', database);
    return args;
}

function execMysqlQuery(container, user, password, database, sql) {
    const args = buildMysqlArgs(container, user, password, database);
    return execMysql(args, sql);
}

function ensureStateTables(container, user, password, database) {
    execMysqlQuery(container, user, password, database, `
        CREATE TABLE IF NOT EXISTS migration_runs (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            finished_at DATETIME NULL,
            status VARCHAR(16) NOT NULL,
            runner_id VARCHAR(191) NULL,
            error_message TEXT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    execMysqlQuery(container, user, password, database, `
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            run_id BIGINT NULL,
            version VARCHAR(32) NOT NULL,
            name VARCHAR(255) NOT NULL,
            checksum VARCHAR(64) NOT NULL,
            started_at DATETIME NULL,
            finished_at DATETIME NULL,
            status VARCHAR(16) NOT NULL,
            error_message TEXT NULL,
            UNIQUE KEY uniq_migration_name (name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}

function withLock(container, user, password, lockName, timeoutSeconds, fn) {
    const res = execMysqlQuery(container, user, password, null, `SELECT GET_LOCK('${lockName}', ${timeoutSeconds}) AS got_lock`);
    const got = res && res.split(/\s+/)[0] === '1';
    if (!got) throw new Error(`Failed to acquire lock: ${lockName}`);
    try {
        return fn();
    } finally {
        execMysqlQuery(container, user, password, null, `SELECT RELEASE_LOCK('${lockName}')`);
    }
}

function loadApplied(container, user, password, database) {
    const output = execMysqlQuery(container, user, password, database, 'SELECT name, checksum, status FROM schema_migrations');
    const map = new Map();
    if (!output) return map;
    const lines = output.split('\n').filter(Boolean);
    for (const line of lines) {
        const [name, checksum, status] = line.split('\t');
        map.set(name, { checksum, status });
    }
    return map;
}

function insertRun(container, user, password, database, runnerId) {
    execMysqlQuery(
        container,
        user,
        password,
        database,
        `INSERT INTO migration_runs (status, runner_id) VALUES ('running', ${runnerId ? `'${runnerId.replace(/'/g, "''")}'` : 'NULL'})`
    );
    const out = execMysqlQuery(container, user, password, database, 'SELECT LAST_INSERT_ID()');
    return Number(out.split(/\s+/)[0]);
}

function finishRun(container, user, password, database, runId, status, errorMessage) {
    const msg = errorMessage ? `'${errorMessage.replace(/'/g, "''")}'` : 'NULL';
    execMysqlQuery(
        container,
        user,
        password,
        database,
        `UPDATE migration_runs SET status = '${status}', finished_at = NOW(), error_message = ${msg} WHERE id = ${runId}`
    );
}

function startMigration(container, user, password, database, runId, version, name, checksum) {
    const safeName = name.replace(/'/g, "''");
    execMysqlQuery(
        container,
        user,
        password,
        database,
        `INSERT INTO schema_migrations (run_id, version, name, checksum, started_at, status) VALUES (${runId}, '${version}', '${safeName}', '${checksum}', NOW(), 'running')`
    );
}

function updateMigration(container, user, password, database, name, status, errorMessage) {
    const safeName = name.replace(/'/g, "''");
    const msg = errorMessage ? `'${errorMessage.replace(/'/g, "''")}'` : 'NULL';
    execMysqlQuery(
        container,
        user,
        password,
        database,
        `UPDATE schema_migrations SET status = '${status}', finished_at = NOW(), error_message = ${msg} WHERE name = '${safeName}'`
    );
}

function applySql(container, user, password, database, sqlText) {
    execMysqlScript(container, user, password, database, sqlText);
}

function requireMigrationsRoot() {
    if (!fs.existsSync(MIGRATIONS_ROOT)) {
        throw new Error(`Migrations directory missing: ${MIGRATIONS_ROOT}`);
    }
}

function run() {
    const env = readEnvFile(ENV_PATH);
    const container = getEnvVar(env, 'MYSQL_CONTAINER', 'openclaw-mysql');
    const user = getEnvVar(env, 'MYSQL_USER', 'root');
    const rootPassword = getEnvVar(env, 'MYSQL_ROOT_PASSWORD', '');
    const userPassword = getEnvVar(env, 'MYSQL_PASSWORD', '');
    const password = user === 'root'
        ? (rootPassword || userPassword)
        : (userPassword || rootPassword);

    requireMigrationsRoot();
    const runnerId = `${process.pid}@${require('os').hostname()}`;

    withLock(container, user, password, 'openclaw_schema_migration', 60, () => {
        const dbDirs = listDatabaseDirs(MIGRATIONS_ROOT);
        if (dbDirs.length === 0) {
            throw new Error(`No database migration directories found in ${MIGRATIONS_ROOT}`);
        }

        for (const dbName of dbDirs) {
            const dbDir = path.join(MIGRATIONS_ROOT, dbName);
            const files = listSqlFiles(dbDir);

            execMysqlQuery(container, user, password, null, `CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
            ensureStateTables(container, user, password, dbName);

            const runId = insertRun(container, user, password, dbName, `${runnerId}:${dbName}`);
            const applied = loadApplied(container, user, password, dbName);

            for (const filePath of files) {
                const name = relativeSqlPath(filePath);
                const version = fileVersion(filePath);
                const sqlText = fs.readFileSync(filePath, 'utf8');
                const sum = checksumSql(sqlText);

                if (applied.has(name)) {
                    const existing = applied.get(name);
                    if (existing.checksum !== sum) {
                        throw new Error(`Migration checksum mismatch: ${name}`);
                    }
                    if (existing.status !== 'succeeded') {
                        throw new Error(`Migration previously failed: ${name}`);
                    }
                    continue;
                }

                console.log(`[migrate] applying ${name}`);
                try {
                    startMigration(container, user, password, dbName, runId, version, name, sum);
                    applySql(container, user, password, dbName, sqlText);
                    updateMigration(container, user, password, dbName, name, 'succeeded', null);
                } catch (err) {
                    const message = err && err.message ? err.message : String(err);
                    updateMigration(container, user, password, dbName, name, 'failed', message.slice(0, 2000));
                    finishRun(container, user, password, dbName, runId, 'failed', message.slice(0, 2000));
                    throw err;
                }
            }

            finishRun(container, user, password, dbName, runId, 'succeeded', null);
        }
    });
}

try {
    run();
    console.log('[migrate] done');
    process.exit(EXIT.OK);
} catch (err) {
    console.error('[migrate] failed:', err && err.message ? err.message : err);
    process.exit(EXIT.ERROR);
}

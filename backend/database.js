/**
 * LiveClaw — Database Abstraction Layer
 *
 * Supports two backends:
 *   - SQLite (better-sqlite3) — dev/test, in-memory or file-based
 *   - PostgreSQL (pg) — production, enabling horizontal scaling
 *
 * Switch via DATABASE_URL env var:
 *   - Not set → SQLite at DB_PATH (default: ./liveclaw.db)
 *   - Set → PostgreSQL connection string
 *
 * All methods are async (return Promises), regardless of backend.
 * This lets server.js use `await db.get(...)` uniformly.
 */

'use strict';

function parseIntEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolEnv(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

// ─── SQL Dialect Conversion ─────────────────────────────────────────────────

/**
 * Converts SQLite-flavored SQL to PostgreSQL-compatible SQL.
 * Called only when using the PostgreSQL backend.
 */
function sqliteToPostgres(sql) {
    let converted = sql;

    // Step 1: Handle datetime patterns with hardcoded modifiers (BEFORE param conversion)
    converted = converted.replace(
        /datetime\s*\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi,
        (_m, mod) => `NOW() + INTERVAL '${mod}'`
    );

    // Step 2: Handle datetime('now') → NOW() (BEFORE param conversion)
    converted = converted.replace(/datetime\s*\(\s*'now'\s*\)/gi, 'NOW()');

    // Step 3: Parameter conversion: ? → $1, $2, ...
    let paramIndex = 0;
    converted = converted.replace(/\?/g, () => `$${++paramIndex}`);

    // Step 4: Handle datetime('now', $N) — parametric modifiers (AFTER ? → $N)
    converted = converted.replace(
        /datetime\s*\(\s*'now'\s*,\s*(\$\d+)\s*\)/gi,
        (_m, param) => `NOW() + CAST(${param} AS INTERVAL)`
    );

    // Step 5: Named params: @name → $N (tracked by order of appearance)
    const namedParams = [];
    converted = converted.replace(/@(\w+)/g, (_match, name) => {
        const idx = namedParams.indexOf(name);
        if (idx >= 0) return `$${paramIndex + idx + 1}`;
        namedParams.push(name);
        return `$${paramIndex + namedParams.length}`;
    });

    // Step 6: INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
    converted = converted.replace(
        /INSERT\s+OR\s+IGNORE\s+INTO/gi,
        'INSERT INTO'
    );
    if (/INSERT\s+OR\s+IGNORE/i.test(sql) && !/ON\s+CONFLICT/i.test(converted)) {
        converted = converted.replace(
            /(\)\s*)(RETURNING|$)/i,
            '$1 ON CONFLICT DO NOTHING $2'
        );
    }

    // CURRENT_TIMESTAMP, COALESCE, COUNT(*), SUM(), date() work in both dialects

    return { sql: converted, namedParams };
}

/**
 * Extract named parameter values from an object in the order they appear in SQL.
 */
function extractNamedValues(params, namedParams, positionalCount) {
    if (!namedParams || namedParams.length === 0) return params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return params;

    const values = [];
    for (const name of namedParams) {
        values.push(params[name] !== undefined ? params[name] : null);
    }
    return values;
}

// ─── SQLite Backend ─────────────────────────────────────────────────────────

class SQLiteBackend {
    constructor(dbPath) {
        const Database = require('better-sqlite3');
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.type = 'sqlite';
    }

    async exec(sql) {
        this.db.exec(sql);
    }

    async get(sql, params = []) {
        if (params && !Array.isArray(params) && typeof params === 'object') {
            return this.db.prepare(sql).get(params) || null;
        }
        return this.db.prepare(sql).get(...(Array.isArray(params) ? params : [params])) || null;
    }

    async all(sql, params = []) {
        if (params && !Array.isArray(params) && typeof params === 'object') {
            return this.db.prepare(sql).all(params);
        }
        return this.db.prepare(sql).all(...(Array.isArray(params) ? params : [params]));
    }

    async run(sql, params = []) {
        let result;
        if (params && !Array.isArray(params) && typeof params === 'object') {
            result = this.db.prepare(sql).run(params);
        } else {
            result = this.db.prepare(sql).run(...(Array.isArray(params) ? params : [params]));
        }
        return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    }

    async transaction(fn) {
        return this.db.transaction(fn)();
    }

    async close() {
        this.db.close();
    }
}

// ─── PostgreSQL Backend ─────────────────────────────────────────────────────

class PostgresBackend {
    constructor(connectionString) {
        const { Pool } = require('pg');
        // pg-connection-string v3+ treats sslmode=require as verify-full, which
        // rejects DigitalOcean Managed PG's self-signed cert chain even when
        // ssl.rejectUnauthorized=false is set in poolConfig. Strip sslmode from
        // the URL so our explicit ssl config is the only source of truth.
        const cleanConnectionString = connectionString
            .replace(/[?&]sslmode=[^&]*/g, '')
            .replace(/\?$/, '');

        const poolMax = parseIntEnv('PG_POOL_MAX', 20);
        const idleTimeoutMillis = parseIntEnv('PG_POOL_IDLE_TIMEOUT_MS', 30000);
        const connectionTimeoutMillis = parseIntEnv('PG_POOL_CONNECTION_TIMEOUT_MS', 5000);
        const queryTimeoutMillis = parseIntEnv('PG_POOL_QUERY_TIMEOUT_MS', 15000);
        const rejectUnauthorized = parseBoolEnv('PG_SSL_REJECT_UNAUTHORIZED', false);

        const poolConfig = {
            connectionString: cleanConnectionString,
            max: poolMax,
            idleTimeoutMillis,
            connectionTimeoutMillis,
            query_timeout: queryTimeoutMillis,
            statement_timeout: queryTimeoutMillis,
            ssl: { rejectUnauthorized },
            application_name: process.env.PG_APP_NAME || 'liveclaw-orchestrator',
        };
        this.pool = new Pool(poolConfig);
        this.type = 'postgres';
    }

    async exec(sql) {
        // Convert SQLite DDL to PostgreSQL
        let pgSql = sql;

        // Handle multiple statements separated by semicolons
        pgSql = pgSql.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');
        pgSql = pgSql.replace(/datetime\s*\(\s*'now'\s*\)/gi, 'NOW()');
        pgSql = pgSql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO');
        // DATETIME is a SQLite type; PostgreSQL uses TIMESTAMPTZ
        pgSql = pgSql.replace(/\bDATETIME\b/gi, 'TIMESTAMPTZ');
        // TEXT CHECK constraints: PostgreSQL requires the column to exist in DDL
        // (no change needed, but drop unsupported SQLite-only modifiers if any)

        // Split by semicolons and execute each statement
        const statements = pgSql.split(';').map(s => s.trim()).filter(s => s.length > 0);
        const client = await this.pool.connect();
        try {
            for (const stmt of statements) {
                await client.query(stmt);
            }
        } finally {
            client.release();
        }
    }

    async get(sql, params = []) {
        const { sql: pgSql, namedParams } = sqliteToPostgres(sql);
        const values = Array.isArray(params)
            ? params
            : extractNamedValues(params, namedParams, 0);
        const result = await this.pool.query(pgSql, Array.isArray(values) ? values : []);
        return result.rows[0] || null;
    }

    async all(sql, params = []) {
        const { sql: pgSql, namedParams } = sqliteToPostgres(sql);
        const values = Array.isArray(params)
            ? params
            : extractNamedValues(params, namedParams, 0);
        const result = await this.pool.query(pgSql, Array.isArray(values) ? values : []);
        return result.rows;
    }

    async run(sql, params = []) {
        const { sql: pgSql, namedParams } = sqliteToPostgres(sql);
        const values = Array.isArray(params)
            ? params
            : extractNamedValues(params, namedParams, 0);
        const result = await this.pool.query(pgSql, Array.isArray(values) ? values : []);
        return { changes: result.rowCount, lastInsertRowid: null };
    }

    async transaction(fn) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async close() {
        await this.pool.end();
    }
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Creates the appropriate database backend based on environment.
 *
 * @param {object} options
 * @param {string} options.databaseUrl  - PostgreSQL connection string (optional)
 * @param {string} options.dbPath       - SQLite file path (default: ./liveclaw.db)
 * @returns {SQLiteBackend|PostgresBackend}
 */
function createDatabase({ databaseUrl, dbPath } = {}) {
    if (databaseUrl) {
        return new PostgresBackend(databaseUrl);
    }
    return new SQLiteBackend(dbPath || ':memory:');
}

module.exports = { createDatabase, sqliteToPostgres, extractNamedValues };

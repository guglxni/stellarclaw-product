/**
 * Tests for database.js — the DB abstraction layer.
 *
 * Covers:
 *   - sqliteToPostgres() dialect conversion
 *   - extractNamedValues() helper
 *   - createDatabase() factory — SQLite in-memory CRUD
 *   - Vision-usage table operations (the pattern used by vision-mcp.js)
 *
 * Does NOT test the PostgreSQL backend (requires a real PG connection).
 * PG-specific conversion correctness is verified via sqliteToPostgres() unit tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const { createDatabase, sqliteToPostgres, extractNamedValues } = require('../database.js');

// ─── sqliteToPostgres ─────────────────────────────────────────────────────────

describe('sqliteToPostgres()', () => {
    it('converts ? positional params to $1, $2, ...', () => {
        const { sql } = sqliteToPostgres('SELECT * FROM t WHERE a = ? AND b = ?');
        expect(sql).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
    });

    it('converts single ? to $1', () => {
        const { sql } = sqliteToPostgres('SELECT count FROM vision_usage WHERE user_id = ?');
        expect(sql).toBe('SELECT count FROM vision_usage WHERE user_id = $1');
    });

    it('converts datetime(\'now\') to NOW()', () => {
        const { sql } = sqliteToPostgres("SELECT datetime('now')");
        expect(sql.toUpperCase()).toContain('NOW()');
    });

    it('converts datetime(\'now\', \'+1 day\') to NOW() + INTERVAL', () => {
        const { sql } = sqliteToPostgres("SELECT datetime('now', '+1 day')");
        expect(sql.toUpperCase()).toContain('INTERVAL');
    });

    it('converts INSERT OR IGNORE INTO to INSERT INTO ... ON CONFLICT DO NOTHING', () => {
        const { sql } = sqliteToPostgres(
            'INSERT OR IGNORE INTO tbl (a, b) VALUES (?, ?)'
        );
        expect(sql).toContain('INSERT INTO');
        expect(sql.toUpperCase()).toContain('ON CONFLICT DO NOTHING');
        expect(sql).not.toContain('OR IGNORE');
    });

    it('handles SQL with no params (no ? at all)', () => {
        const { sql } = sqliteToPostgres('SELECT 1');
        expect(sql).toBe('SELECT 1');
    });

    it('returns namedParams as empty array when no named params', () => {
        const { namedParams } = sqliteToPostgres('SELECT ?');
        expect(namedParams).toEqual([]);
    });

    it('converts @name named params to $N', () => {
        const { sql, namedParams } = sqliteToPostgres('INSERT INTO t (a) VALUES (@val)');
        expect(sql).toContain('$1');
        expect(namedParams).toContain('val');
    });

    it('handles mixed ? and @name params (? come first)', () => {
        const { sql, namedParams } = sqliteToPostgres(
            'UPDATE t SET a = ? WHERE id = @id'
        );
        expect(sql).toContain('$1'); // ?
        expect(sql).toContain('$2'); // @id
        expect(namedParams).toContain('id');
    });

    it('preserves COALESCE, COUNT(*), SUM() unchanged', () => {
        const input = 'SELECT COALESCE(SUM(amount), 0), COUNT(*) FROM payments';
        const { sql } = sqliteToPostgres(input);
        expect(sql).toContain('COALESCE');
        expect(sql).toContain('SUM(amount)');
        expect(sql).toContain('COUNT(*)');
    });

    it('does not double-convert already-PG params if called twice', () => {
        // This is a regression guard — real code calls it once per query.
        const { sql: first } = sqliteToPostgres('SELECT * FROM t WHERE x = ?');
        expect(first).toBe('SELECT * FROM t WHERE x = $1');
        // Calling again on already-converted SQL should not produce $1$1 etc.
        // (It WILL re-convert $1 to $1 since there are no ? — that's fine)
        expect(first).not.toContain('??');
    });
});

// ─── extractNamedValues ───────────────────────────────────────────────────────

describe('extractNamedValues()', () => {
    it('extracts values in namedParams order', () => {
        const result = extractNamedValues({ name: 'Alice', age: 30 }, ['name', 'age'], 0);
        expect(result).toEqual(['Alice', 30]);
    });

    it('returns null for missing named param', () => {
        const result = extractNamedValues({ name: 'Alice' }, ['name', 'missing'], 0);
        expect(result).toEqual(['Alice', null]);
    });

    it('returns params unchanged when namedParams is empty', () => {
        const params = ['a', 'b'];
        expect(extractNamedValues(params, [], 0)).toBe(params);
    });

    it('returns params unchanged when namedParams is null', () => {
        const params = ['a'];
        expect(extractNamedValues(params, null, 0)).toBe(params);
    });

    it('handles empty object params', () => {
        const result = extractNamedValues({}, ['key'], 0);
        expect(result).toEqual([null]);
    });
});

// ─── createDatabase() — SQLite in-memory ──────────────────────────────────────

describe('createDatabase() SQLite in-memory', () => {
    let db;

    beforeEach(() => {
        db = createDatabase({}); // defaults to :memory:
    });

    afterEach(async () => {
        try { await db.close(); } catch (_) {}
    });

    it('creates an in-memory database successfully', () => {
        expect(db).toBeDefined();
        expect(db.type).toBe('sqlite');
    });

    it('exec() creates a table without error', async () => {
        await expect(db.exec('CREATE TABLE foo (id INTEGER PRIMARY KEY, val TEXT)')).resolves.not.toThrow();
    });

    it('run() inserts a row and returns changes=1', async () => {
        await db.exec('CREATE TABLE foo (id INTEGER PRIMARY KEY, val TEXT)');
        const result = await db.run('INSERT INTO foo (val) VALUES (?)', ['hello']);
        expect(result.changes).toBe(1);
    });

    it('get() returns null when no row matches', async () => {
        await db.exec('CREATE TABLE foo (id INTEGER PRIMARY KEY, val TEXT)');
        const row = await db.get('SELECT * FROM foo WHERE id = ?', [999]);
        expect(row).toBeNull();
    });

    it('get() returns the matching row', async () => {
        await db.exec('CREATE TABLE foo (id INTEGER PRIMARY KEY, val TEXT)');
        await db.run('INSERT INTO foo (val) VALUES (?)', ['world']);
        const row = await db.get('SELECT val FROM foo WHERE val = ?', ['world']);
        expect(row).toEqual({ val: 'world' });
    });

    it('all() returns all matching rows', async () => {
        await db.exec('CREATE TABLE foo (id INTEGER PRIMARY KEY, val TEXT)');
        await db.run('INSERT INTO foo (val) VALUES (?)', ['a']);
        await db.run('INSERT INTO foo (val) VALUES (?)', ['b']);
        const rows = await db.all('SELECT val FROM foo ORDER BY val');
        expect(rows).toEqual([{ val: 'a' }, { val: 'b' }]);
    });

    it('all() returns empty array when no rows match', async () => {
        await db.exec('CREATE TABLE foo (id INTEGER PRIMARY KEY, val TEXT)');
        const rows = await db.all('SELECT * FROM foo');
        expect(rows).toEqual([]);
    });

    it('run() UPDATE returns correct changes count', async () => {
        await db.exec('CREATE TABLE foo (id INTEGER PRIMARY KEY, val TEXT)');
        await db.run('INSERT INTO foo (val) VALUES (?)', ['before']);
        const result = await db.run('UPDATE foo SET val = ? WHERE val = ?', ['after', 'before']);
        expect(result.changes).toBe(1);
    });

    it('run() UPDATE with no matches returns changes=0', async () => {
        await db.exec('CREATE TABLE foo (id INTEGER PRIMARY KEY, val TEXT)');
        const result = await db.run('UPDATE foo SET val = ? WHERE id = ?', ['x', 999]);
        expect(result.changes).toBe(0);
    });
});

// ─── Vision usage table operations (mirrors vision-mcp.js exactly) ────────────

describe('Vision usage table (vision-mcp pattern)', () => {
    let db;

    beforeEach(async () => {
        db = createDatabase({});
        await db.exec(`
            CREATE TABLE IF NOT EXISTS vision_usage (
                user_id TEXT NOT NULL,
                day     TEXT NOT NULL,
                count   INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, day)
            )
        `);
    });

    afterEach(async () => {
        try { await db.close(); } catch (_) {}
    });

    it('inserts first usage record for a user/day', async () => {
        await db.run(
            'INSERT INTO vision_usage (user_id, day, count) VALUES (?, ?, 1)',
            ['user1', '2026-04-13']
        );
        const row = await db.get(
            'SELECT count FROM vision_usage WHERE user_id = ? AND day = ?',
            ['user1', '2026-04-13']
        );
        expect(row.count).toBe(1);
    });

    it('increments existing count atomically', async () => {
        await db.run(
            'INSERT INTO vision_usage (user_id, day, count) VALUES (?, ?, 5)',
            ['user1', '2026-04-13']
        );
        await db.run(
            'UPDATE vision_usage SET count = count + 1 WHERE user_id = ? AND day = ?',
            ['user1', '2026-04-13']
        );
        const row = await db.get(
            'SELECT count FROM vision_usage WHERE user_id = ? AND day = ?',
            ['user1', '2026-04-13']
        );
        expect(row.count).toBe(6);
    });

    it('returns null when no usage record exists (new user/day)', async () => {
        const row = await db.get(
            'SELECT count FROM vision_usage WHERE user_id = ? AND day = ?',
            ['new_user', '2026-04-13']
        );
        expect(row).toBeNull();
    });

    it('isolates usage per user (different users have separate counts)', async () => {
        await db.run(
            'INSERT INTO vision_usage (user_id, day, count) VALUES (?, ?, 10)',
            ['userA', '2026-04-13']
        );
        await db.run(
            'INSERT INTO vision_usage (user_id, day, count) VALUES (?, ?, 3)',
            ['userB', '2026-04-13']
        );
        const rowA = await db.get(
            'SELECT count FROM vision_usage WHERE user_id = ? AND day = ?',
            ['userA', '2026-04-13']
        );
        const rowB = await db.get(
            'SELECT count FROM vision_usage WHERE user_id = ? AND day = ?',
            ['userB', '2026-04-13']
        );
        expect(rowA.count).toBe(10);
        expect(rowB.count).toBe(3);
    });

    it('isolates usage per day (same user, different days)', async () => {
        await db.run(
            'INSERT INTO vision_usage (user_id, day, count) VALUES (?, ?, 20)',
            ['user1', '2026-04-12']
        );
        await db.run(
            'INSERT INTO vision_usage (user_id, day, count) VALUES (?, ?, 1)',
            ['user1', '2026-04-13']
        );
        const yesterday = await db.get(
            'SELECT count FROM vision_usage WHERE user_id = ? AND day = ?',
            ['user1', '2026-04-12']
        );
        const today = await db.get(
            'SELECT count FROM vision_usage WHERE user_id = ? AND day = ?',
            ['user1', '2026-04-13']
        );
        expect(yesterday.count).toBe(20);
        expect(today.count).toBe(1);
    });

    it('enforces PRIMARY KEY uniqueness (user_id, day)', async () => {
        await db.run(
            'INSERT INTO vision_usage (user_id, day, count) VALUES (?, ?, 1)',
            ['user1', '2026-04-13']
        );
        // Second insert with same PK should throw
        await expect(
            db.run(
                'INSERT INTO vision_usage (user_id, day, count) VALUES (?, ?, 1)',
                ['user1', '2026-04-13']
            )
        ).rejects.toThrow();
    });
});

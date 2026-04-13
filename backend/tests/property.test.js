/**
 * Property-based tests using fast-check.
 *
 * Property tests generate hundreds of random inputs to verify invariants that
 * unit tests with hand-picked values cannot exhaustively cover. Key properties:
 *
 *   - resolveWorkspacePath()   — NEVER returns a path outside the workspace (path traversal)
 *   - sqliteToPostgres()       — ALWAYS converts every ? to a $N, no ? remain
 *   - validateImageUrl()       — NEVER allows private RFC1918 IPs or dangerous schemes
 *   - vision cap logic         — count invariants hold under random increments
 *   - utcDay()                 — always returns valid YYYY-MM-DD format
 *
 * Run with: npm test (included in vitest suite)
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import path from 'path';

const { sqliteToPostgres } = require('../database.js');

// ─── Helpers replicated from MCP servers ─────────────────────────────────────

function resolveWorkspacePath(workspace, relOrAbs) {
    const resolved = path.isAbsolute(relOrAbs)
        ? relOrAbs
        : path.resolve(workspace, relOrAbs);
    const normal   = path.normalize(resolved);
    const wsNormal = path.normalize(workspace);
    if (!normal.startsWith(wsNormal + path.sep) && normal !== wsNormal) {
        throw new Error(`Path escapes workspace: ${relOrAbs}`);
    }
    return normal;
}

function validateImageUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') throw new Error('Only HTTPS URLs allowed');
        if (url.includes('@')) throw new Error('URLs with credentials not allowed');
        const host = parsed.hostname.toLowerCase();
        if (host === 'localhost' || host === 'metadata.google.internal') throw new Error('Internal hostname blocked');
        if (parsed.port && parsed.port !== '443') throw new Error('Non-standard port blocked');
        const parts = host.split('.').map(Number);
        if (parts.length === 4 && parts.every(n => !isNaN(n))) {
            if (parts[0] === 10) throw new Error('Private IP blocked');
            if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) throw new Error('Private IP blocked');
            if (parts[0] === 192 && parts[1] === 168) throw new Error('Private IP blocked');
            if (parts[0] === 127) throw new Error('Loopback blocked');
            if (parts[0] === 169 && parts[1] === 254) throw new Error('Link-local blocked');
        }
        if (host === '::1' || host === '::' || host.startsWith('[') ||
            host.startsWith('fe80') || host.startsWith('fc00') || host.startsWith('fd00') ||
            host.startsWith('2001:db8')) throw new Error('IPv6 private/reserved blocked');
        if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
            host.includes('nip.io') || host.includes('sslip.io') || host.includes('xip.io') ||
            host.includes('localtest.me') || host.includes('lvh.me')) throw new Error('DNS rebinding hostname blocked');
        return parsed.href;
    } catch (e) {
        throw new Error(`Invalid image URL: ${e.message}`);
    }
}

// ─── Property: resolveWorkspacePath never escapes workspace ──────────────────

describe('Property: resolveWorkspacePath() path confinement', () => {
    const workspace = '/opt/liveclaw/bots/user123/.picobot/workspace';

    it('safe filenames (no slashes, no dots) always resolve inside workspace', () => {
        fc.assert(fc.property(
            // Generate simple alphanumeric filenames (no path separators)
            fc.stringMatching(/^[a-zA-Z0-9_\-]{1,30}\.[a-z]{1,5}$/),
            (filename) => {
                const resolved = resolveWorkspacePath(workspace, filename);
                expect(resolved.startsWith(workspace)).toBe(true);
            }
        ), { numRuns: 200 });
    });

    it('any input with ../ always throws (path traversal blocked)', () => {
        fc.assert(fc.property(
            // Generate strings containing ../
            fc.constantFrom(
                '../etc/passwd',
                '../../root/.ssh/id_rsa',
                'subdir/../../../etc/shadow',
                '../' + 'a'.repeat(20),
                '..' + path.sep + 'sibling',
            ),
            (traversal) => {
                expect(() => resolveWorkspacePath(workspace, traversal)).toThrow(/escapes/);
            }
        ), { numRuns: 5 }); // small since we use constantFrom
    });

    it('absolute paths outside workspace always throw', () => {
        fc.assert(fc.property(
            // Generate absolute paths that are NOT inside our workspace
            fc.oneof(
                fc.constant('/etc/passwd'),
                fc.constant('/root/.ssh/authorized_keys'),
                fc.constant('/tmp/evil'),
                fc.constant('/opt/liveclaw/bots/other_user/secret'),
                // Same-prefix-but-sibling attack
                fc.constant(workspace + '_evil/file.txt'),
            ),
            (absPath) => {
                expect(() => resolveWorkspacePath(workspace, absPath)).toThrow(/escapes/);
            }
        ), { numRuns: 5 });
    });

    it('valid nested paths inside workspace always resolve correctly', () => {
        fc.assert(fc.property(
            fc.stringMatching(/^[a-zA-Z0-9]{1,10}$/),
            fc.stringMatching(/^[a-zA-Z0-9]{1,10}$/),
            fc.stringMatching(/^[a-zA-Z0-9_]{1,15}\.json$/),
            (dir1, dir2, file) => {
                const relativePath = `${dir1}/${dir2}/${file}`;
                const resolved = resolveWorkspacePath(workspace, relativePath);
                expect(resolved.startsWith(workspace)).toBe(true);
                expect(resolved).toContain(dir1);
                expect(resolved).toContain(dir2);
            }
        ), { numRuns: 100 });
    });
});

// ─── Property: sqliteToPostgres converts ALL ? to $N ─────────────────────────

describe('Property: sqliteToPostgres() ? → $N conversion', () => {
    it('output never contains bare ? (all converted)', () => {
        fc.assert(fc.property(
            // Generate SQL-like strings with varying numbers of ?
            fc.array(
                fc.oneof(
                    fc.constant('SELECT * FROM t WHERE a = ?'),
                    fc.constant('AND b = ?'),
                    fc.constant('INSERT INTO t VALUES (?, ?)'),
                    fc.constant('UPDATE t SET x = ?'),
                    fc.constant('SELECT 1'),
                ),
                { minLength: 1, maxLength: 5 }
            ),
            (parts) => {
                const sql = parts.join(' ');
                const { sql: pgSql } = sqliteToPostgres(sql);
                // After conversion, no bare ? should remain
                expect(pgSql).not.toMatch(/(?<!\$)\?/);
            }
        ), { numRuns: 300 });
    });

    it('number of $N placeholders equals number of ? in original', () => {
        fc.assert(fc.property(
            fc.nat({ max: 10 }), // 0..10 params
            (paramCount) => {
                const sql = 'SELECT ' + Array.from({ length: paramCount }, () => '?').join(', ');
                const { sql: pgSql } = sqliteToPostgres(sql);
                const placeholders = pgSql.match(/\$\d+/g) || [];
                expect(placeholders.length).toBe(paramCount);
            }
        ), { numRuns: 200 });
    });

    it('$N values are sequential starting from $1', () => {
        fc.assert(fc.property(
            fc.integer({ min: 1, max: 8 }),
            (paramCount) => {
                const sql = 'INSERT INTO t VALUES (' + Array(paramCount).fill('?').join(', ') + ')';
                const { sql: pgSql } = sqliteToPostgres(sql);
                for (let i = 1; i <= paramCount; i++) {
                    expect(pgSql).toContain(`$${i}`);
                }
            }
        ), { numRuns: 100 });
    });

    it('SQL with no ? passes through with namedParams=[]', () => {
        fc.assert(fc.property(
            fc.stringMatching(/^[A-Z ]+$/),
            (sql) => {
                const { namedParams } = sqliteToPostgres(sql);
                expect(namedParams).toEqual([]);
            }
        ), { numRuns: 100 });
    });
});

// ─── Property: validateImageUrl() always blocks private IPs ──────────────────

describe('Property: validateImageUrl() always blocks RFC1918 and loopback', () => {
    it('always blocks 10.x.x.x', () => {
        fc.assert(fc.property(
            fc.nat({ max: 255 }),
            fc.nat({ max: 255 }),
            fc.nat({ max: 255 }),
            (b, c, d) => {
                const url = `https://10.${b}.${c}.${d}/img`;
                expect(() => validateImageUrl(url)).toThrow(/blocked/);
            }
        ), { numRuns: 100 });
    });

    it('always blocks 192.168.x.x', () => {
        fc.assert(fc.property(
            fc.nat({ max: 255 }),
            fc.nat({ max: 255 }),
            (c, d) => {
                const url = `https://192.168.${c}.${d}/img`;
                expect(() => validateImageUrl(url)).toThrow(/blocked/);
            }
        ), { numRuns: 100 });
    });

    it('always blocks 172.16.0.0/12 (172.16-31.x.x)', () => {
        fc.assert(fc.property(
            fc.integer({ min: 16, max: 31 }),
            fc.nat({ max: 255 }),
            fc.nat({ max: 255 }),
            (b, c, d) => {
                const url = `https://172.${b}.${c}.${d}/img`;
                expect(() => validateImageUrl(url)).toThrow(/blocked/);
            }
        ), { numRuns: 80 });
    });

    it('always blocks 127.x.x.x loopback', () => {
        fc.assert(fc.property(
            fc.nat({ max: 255 }),
            fc.nat({ max: 255 }),
            fc.nat({ max: 255 }),
            (b, c, d) => {
                const url = `https://127.${b}.${c}.${d}/img`;
                expect(() => validateImageUrl(url)).toThrow(/blocked/);
            }
        ), { numRuns: 100 });
    });

    it('always blocks 169.254.x.x link-local (metadata services)', () => {
        fc.assert(fc.property(
            fc.nat({ max: 255 }),
            fc.nat({ max: 255 }),
            (c, d) => {
                const url = `https://169.254.${c}.${d}/metadata`;
                expect(() => validateImageUrl(url)).toThrow(/blocked/);
            }
        ), { numRuns: 80 });
    });

    it('always blocks http:// (non-HTTPS)', () => {
        fc.assert(fc.property(
            fc.domain(),
            (domain) => {
                const url = `http://${domain}/img.jpg`;
                expect(() => validateImageUrl(url)).toThrow(/HTTPS/);
            }
        ), { numRuns: 100 });
    });
});

// ─── Property: utcDay() format invariants ─────────────────────────────────────

describe('Property: utcDay() always returns valid YYYY-MM-DD', () => {
    function utcDay() {
        return new Date().toISOString().slice(0, 10);
    }

    it('always returns exactly YYYY-MM-DD format', () => {
        // Call multiple times to verify consistency
        fc.assert(fc.property(
            fc.constant(null),
            () => {
                const day = utcDay();
                expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
                expect(day.length).toBe(10);
            }
        ), { numRuns: 50 });
    });

    it('month is always 01-12', () => {
        const day = utcDay();
        const month = parseInt(day.slice(5, 7), 10);
        expect(month).toBeGreaterThanOrEqual(1);
        expect(month).toBeLessThanOrEqual(12);
    });

    it('day of month is always 01-31', () => {
        const day = utcDay();
        const d = parseInt(day.slice(8, 10), 10);
        expect(d).toBeGreaterThanOrEqual(1);
        expect(d).toBeLessThanOrEqual(31);
    });
});

// ─── Property: Vision daily cap invariants ────────────────────────────────────

describe('Property: Vision cap counter invariants', () => {
    /**
     * Simulates N increments and verifies monotonicity + cap enforcement.
     */
    async function simulateVisionUsage(limit, requestCount) {
        const { createDatabase } = require('../database.js');
        const db = createDatabase({});
        await db.exec(`
            CREATE TABLE vision_usage (
                user_id TEXT NOT NULL,
                day TEXT NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, day)
            )
        `);

        const day = '2026-04-13';
        const userId = 'test_user';
        let allowed = 0, denied = 0;

        for (let i = 0; i < requestCount; i++) {
            const row = await db.get(
                'SELECT count FROM vision_usage WHERE user_id = ? AND day = ?',
                [userId, day]
            );
            const used = row ? row.count : 0;

            if (used >= limit) {
                denied++;
                continue;
            }

            if (row) {
                await db.run(
                    'UPDATE vision_usage SET count = count + 1 WHERE user_id = ? AND day = ?',
                    [userId, day]
                );
            } else {
                await db.run(
                    'INSERT INTO vision_usage (user_id, day, count) VALUES (?, ?, 1)',
                    [userId, day]
                );
            }
            allowed++;
        }

        const finalRow = await db.get(
            'SELECT count FROM vision_usage WHERE user_id = ? AND day = ?',
            [userId, day]
        );
        await db.close();

        return { allowed, denied, finalCount: finalRow ? finalRow.count : 0 };
    }

    it('total allowed never exceeds the daily limit', async () => {
        await fc.assert(fc.asyncProperty(
            fc.integer({ min: 1, max: 10 }),   // limit
            fc.integer({ min: 0, max: 25 }),   // requests
            async (limit, requestCount) => {
                const { allowed } = await simulateVisionUsage(limit, requestCount);
                expect(allowed).toBeLessThanOrEqual(limit);
            }
        ), { numRuns: 30 }); // 30 runs × DB ops — keep fast
    });

    it('allowed + denied always equals total requests', async () => {
        await fc.assert(fc.asyncProperty(
            fc.integer({ min: 1, max: 10 }),
            fc.integer({ min: 0, max: 20 }),
            async (limit, requestCount) => {
                const { allowed, denied } = await simulateVisionUsage(limit, requestCount);
                expect(allowed + denied).toBe(requestCount);
            }
        ), { numRuns: 30 });
    });

    it('DB count equals allowed count (no phantom increments)', async () => {
        await fc.assert(fc.asyncProperty(
            fc.integer({ min: 1, max: 10 }),
            fc.integer({ min: 0, max: 20 }),
            async (limit, requestCount) => {
                const { allowed, finalCount } = await simulateVisionUsage(limit, requestCount);
                expect(finalCount).toBe(allowed);
            }
        ), { numRuns: 30 });
    });
});

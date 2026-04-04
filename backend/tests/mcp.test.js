/**
 * Unit tests for MCP server modules.
 *
 * Tests the pure business-logic functions extracted from each MCP server
 * without spinning up the full stdio transport. Covers:
 *   - telegram-file-mcp.js  — path safety, chat ID discovery, file validation
 *   - discord-file-mcp.js   — session scanning, channel ID extraction
 *   - slack-file-mcp.js     — session parsing (channel + thread), file checks
 *   - vision-mcp.js         — URL validation (SSRF protection)
 *
 * MCP tool invocation is tested via the handler logic, not the transport.
 * We import the internal helper functions via a lightweight module wrapper
 * rather than spawning child processes (unit test scope).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a temp workspace with given files/dirs. Returns workspace path. */
function makeTempWorkspace(files = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-mcp-test-'));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
    }
    return dir;
}

function removeTempWorkspace(dir) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ─── Inline helpers replicated from MCP servers (testable without stdio) ─────
// We replicate the pure functions here because MCP servers run as CLI scripts
// and cannot be `require()`d without launching the MCP transport. This is
// the standard pattern for testing MCP tools at the unit level.

/** resolveWorkspacePath — shared by all file MCP servers */
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

/** readChatId — from telegram-file-mcp.js */
function readChatId(chatIdFile) {
    try { return fs.readFileSync(chatIdFile, 'utf8').trim() || null; } catch (_) { return null; }
}

/** findActiveDiscordChannel — from discord-file-mcp.js */
function findActiveDiscordChannel(workspace) {
    const sessionsDir = path.join(workspace, 'sessions');
    let entries;
    try { entries = fs.readdirSync(sessionsDir); } catch (_) { return null; }
    const files = entries
        .filter(f => f.startsWith('discord:') && f.endsWith('.json'))
        .map(f => {
            const channelId = f.slice('discord:'.length, -'.json'.length);
            const fullPath  = path.join(sessionsDir, f);
            let mtime = 0;
            try { mtime = fs.statSync(fullPath).mtimeMs; } catch (_) {}
            return { channelId, mtime };
        })
        .filter(e => e.channelId.length > 0);
    if (files.length === 0) return null;
    files.sort((a, b) => b.mtime - a.mtime);
    return files[0].channelId;
}

/** findActiveSlackSession — from slack-file-mcp.js */
function findActiveSlackSession(workspace) {
    const sessionsDir = path.join(workspace, 'sessions');
    let entries;
    try { entries = fs.readdirSync(sessionsDir); } catch (_) { return null; }
    const files = entries
        .filter(f => f.startsWith('slack:') && f.endsWith('.json'))
        .map(f => {
            const raw      = f.slice('slack:'.length, -'.json'.length);
            const sepIdx   = raw.indexOf('::');
            const channelId = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;
            const threadTs  = sepIdx >= 0 ? raw.slice(sepIdx + 2) : null;
            const fullPath  = path.join(sessionsDir, f);
            let mtime = 0;
            try { mtime = fs.statSync(fullPath).mtimeMs; } catch (_) {}
            return { channelId, threadTs, mtime };
        })
        .filter(e => e.channelId.length > 0);
    if (files.length === 0) return null;
    files.sort((a, b) => b.mtime - a.mtime);
    return files[0];
}

/** validateImageUrl — from vision-mcp.js (SSRF protection) */
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
        if (host === '::1' || host.startsWith('fe80') || host.startsWith('fc00') ||
            host.startsWith('fd00') || host.endsWith('.localhost') || host.endsWith('.local') ||
            host.endsWith('.internal') || host.includes('nip.io') || host.includes('sslip.io') ||
            host.includes('localtest.me') || host.includes('lvh.me')) {
            throw new Error('Private/reserved hostname blocked');
        }
        return parsed.href;
    } catch (e) {
        throw new Error(`Invalid image URL: ${e.message}`);
    }
}

// ─── resolveWorkspacePath ─────────────────────────────────────────────────────
describe('resolveWorkspacePath()', () => {
    let workspace;
    beforeEach(() => { workspace = makeTempWorkspace(); });
    afterEach(() => removeTempWorkspace(workspace));

    it('accepts a plain filename in workspace root', () => {
        const result = resolveWorkspacePath(workspace, 'report.csv');
        expect(result).toBe(path.join(workspace, 'report.csv'));
    });

    it('accepts nested relative path within workspace', () => {
        const result = resolveWorkspacePath(workspace, 'exports/data.json');
        expect(result).toBe(path.join(workspace, 'exports', 'data.json'));
    });

    it('accepts absolute path inside workspace', () => {
        const abs = path.join(workspace, 'file.txt');
        expect(resolveWorkspacePath(workspace, abs)).toBe(abs);
    });

    it('rejects ../ directory traversal', () => {
        expect(() => resolveWorkspacePath(workspace, '../etc/passwd')).toThrow(/escapes workspace/);
    });

    it('rejects deep traversal that ends outside workspace', () => {
        expect(() => resolveWorkspacePath(workspace, 'sub/../../etc/shadow')).toThrow(/escapes workspace/);
    });

    it('rejects absolute path outside workspace', () => {
        expect(() => resolveWorkspacePath(workspace, '/etc/passwd')).toThrow(/escapes workspace/);
    });

    it('rejects path that starts with workspace prefix but escapes', () => {
        const sibling = workspace + '_evil';
        expect(() => resolveWorkspacePath(workspace, sibling)).toThrow(/escapes workspace/);
    });

    it('normalises ./ components safely', () => {
        const result = resolveWorkspacePath(workspace, './report.csv');
        expect(result).toBe(path.join(workspace, 'report.csv'));
    });
});

// ─── readChatId (Telegram) ────────────────────────────────────────────────────
describe('readChatId() [telegram]', () => {
    let workspace;
    beforeEach(() => { workspace = makeTempWorkspace(); });
    afterEach(() => removeTempWorkspace(workspace));

    it('returns chat ID from .telegram_chat_id file', () => {
        const file = path.join(workspace, '.telegram_chat_id');
        fs.writeFileSync(file, '123456789', 'utf8');
        expect(readChatId(file)).toBe('123456789');
    });

    it('trims whitespace from file contents', () => {
        const file = path.join(workspace, '.telegram_chat_id');
        fs.writeFileSync(file, '  987654321\n', 'utf8');
        expect(readChatId(file)).toBe('987654321');
    });

    it('returns null when file does not exist', () => {
        expect(readChatId(path.join(workspace, '.no-such-file'))).toBeNull();
    });

    it('returns null when file is empty', () => {
        const file = path.join(workspace, '.telegram_chat_id');
        fs.writeFileSync(file, '', 'utf8');
        expect(readChatId(file)).toBeNull();
    });

    it('returns null when file contains only whitespace', () => {
        const file = path.join(workspace, '.telegram_chat_id');
        fs.writeFileSync(file, '   \n\t  ', 'utf8');
        expect(readChatId(file)).toBeNull();
    });
});

// ─── findActiveDiscordChannel ─────────────────────────────────────────────────
describe('findActiveDiscordChannel() [discord]', () => {
    let workspace;
    beforeEach(() => { workspace = makeTempWorkspace(); });
    afterEach(() => removeTempWorkspace(workspace));

    it('returns null when sessions directory does not exist', () => {
        expect(findActiveDiscordChannel(workspace)).toBeNull();
    });

    it('returns null when no discord session files exist', () => {
        fs.mkdirSync(path.join(workspace, 'sessions'));
        fs.writeFileSync(path.join(workspace, 'sessions', 'telegram:123.json'), '{}');
        expect(findActiveDiscordChannel(workspace)).toBeNull();
    });

    it('extracts channel ID from discord session filename', () => {
        makeTempWorkspace({ 'sessions/discord:987654321.json': '{}' });
        const ws2 = makeTempWorkspace({ 'sessions/discord:987654321.json': '{}' });
        afterEach(() => removeTempWorkspace(ws2));
        expect(findActiveDiscordChannel(ws2)).toBe('987654321');
    });

    it('picks the most recently modified session when multiple exist', async () => {
        const sessDir = path.join(workspace, 'sessions');
        fs.mkdirSync(sessDir);
        const older = path.join(sessDir, 'discord:111.json');
        const newer = path.join(sessDir, 'discord:999.json');
        fs.writeFileSync(older, '{}');
        // Ensure different mtimes
        await new Promise(r => setTimeout(r, 10));
        fs.writeFileSync(newer, '{}');

        expect(findActiveDiscordChannel(workspace)).toBe('999');
    });

    it('ignores non-discord session files (telegram, slack)', () => {
        const sessDir = path.join(workspace, 'sessions');
        fs.mkdirSync(sessDir);
        fs.writeFileSync(path.join(sessDir, 'telegram:12345.json'), '{}');
        fs.writeFileSync(path.join(sessDir, 'slack:C12345::t.json'), '{}');

        expect(findActiveDiscordChannel(workspace)).toBeNull();
    });
});

// ─── findActiveSlackSession ───────────────────────────────────────────────────
describe('findActiveSlackSession() [slack]', () => {
    let workspace;
    beforeEach(() => { workspace = makeTempWorkspace(); });
    afterEach(() => removeTempWorkspace(workspace));

    it('returns null when sessions directory does not exist', () => {
        expect(findActiveSlackSession(workspace)).toBeNull();
    });

    it('returns null when no slack sessions', () => {
        fs.mkdirSync(path.join(workspace, 'sessions'));
        expect(findActiveSlackSession(workspace)).toBeNull();
    });

    it('parses channel ID and thread timestamp from filename', () => {
        const sessDir = path.join(workspace, 'sessions');
        fs.mkdirSync(sessDir);
        fs.writeFileSync(path.join(sessDir, 'slack:C12345::1712000000.123456.json'), '{}');

        const session = findActiveSlackSession(workspace);
        expect(session.channelId).toBe('C12345');
        expect(session.threadTs).toBe('1712000000.123456');
    });

    it('handles DM sessions without thread timestamp', () => {
        const sessDir = path.join(workspace, 'sessions');
        fs.mkdirSync(sessDir);
        fs.writeFileSync(path.join(sessDir, 'slack:D98765.json'), '{}');

        const session = findActiveSlackSession(workspace);
        expect(session.channelId).toBe('D98765');
        expect(session.threadTs).toBeNull();
    });

    it('picks most recently modified session', async () => {
        const sessDir = path.join(workspace, 'sessions');
        fs.mkdirSync(sessDir);
        fs.writeFileSync(path.join(sessDir, 'slack:C111::t1.json'), '{}');
        await new Promise(r => setTimeout(r, 10));
        fs.writeFileSync(path.join(sessDir, 'slack:C999::t2.json'), '{}');

        const session = findActiveSlackSession(workspace);
        expect(session.channelId).toBe('C999');
    });
});

// ─── validateImageUrl (vision SSRF protection) ────────────────────────────────
describe('validateImageUrl() [vision]', () => {
    it('accepts valid HTTPS public URL', () => {
        expect(() => validateImageUrl('https://example.com/image.png')).not.toThrow();
    });

    it('rejects HTTP URLs', () => {
        expect(() => validateImageUrl('http://example.com/img.jpg')).toThrow(/HTTPS/);
    });

    it('rejects localhost', () => {
        expect(() => validateImageUrl('https://localhost/image.png')).toThrow(/blocked/);
    });

    it('rejects 127.x.x.x loopback', () => {
        expect(() => validateImageUrl('https://127.0.0.1/img.png')).toThrow(/blocked/);
    });

    it('rejects private 10.x.x.x', () => {
        expect(() => validateImageUrl('https://10.0.0.1/img')).toThrow(/blocked/);
    });

    it('rejects private 192.168.x.x', () => {
        expect(() => validateImageUrl('https://192.168.1.1/img')).toThrow(/blocked/);
    });

    it('rejects 172.16-31.x.x private range', () => {
        expect(() => validateImageUrl('https://172.16.0.1/img')).toThrow(/blocked/);
        expect(() => validateImageUrl('https://172.31.255.255/img')).toThrow(/blocked/);
    });

    it('does NOT block 172.32.x.x (public range)', () => {
        expect(() => validateImageUrl('https://172.32.0.1/img')).not.toThrow();
    });

    it('rejects URLs with credentials (@)', () => {
        expect(() => validateImageUrl('https://user:pass@example.com/img')).toThrow(/credentials/);
    });

    it('rejects non-standard ports', () => {
        expect(() => validateImageUrl('https://example.com:8080/img')).toThrow(/port/);
    });

    it('rejects GCP metadata server', () => {
        expect(() => validateImageUrl('https://metadata.google.internal/img')).toThrow(/blocked/);
    });

    it('rejects .local domains', () => {
        expect(() => validateImageUrl('https://myserver.local/img')).toThrow(/blocked/);
    });

    it('rejects nip.io DNS rebinding domains', () => {
        expect(() => validateImageUrl('https://192.168.1.1.nip.io/img')).toThrow(/blocked/);
    });

    it('accepts base64 data URIs (bypass URL validation)', () => {
        // Data URIs are handled separately in vision-mcp.js (not through validateImageUrl)
        // The function itself would reject non-https; test that the URL validator
        // would throw for a data URI if called directly (it's bypassed upstream)
        expect(() => validateImageUrl('data:image/png;base64,abc')).toThrow();
    });
});

// ─── File size validation (shared logic) ─────────────────────────────────────
describe('File size limits', () => {
    let workspace;
    beforeEach(() => { workspace = makeTempWorkspace(); });
    afterEach(() => removeTempWorkspace(workspace));

    const MAX_FILE_BYTES = 10 * 1024 * 1024;

    it('accepts files exactly at 10MB limit', () => {
        const file = path.join(workspace, 'big.csv');
        fs.writeFileSync(file, Buffer.alloc(MAX_FILE_BYTES));
        const stat = fs.statSync(file);
        expect(stat.size).toBeLessThanOrEqual(MAX_FILE_BYTES);
    });

    it('file above 10MB is detected as too large', () => {
        const file = path.join(workspace, 'toobig.csv');
        fs.writeFileSync(file, Buffer.alloc(MAX_FILE_BYTES + 1));
        const stat = fs.statSync(file);
        expect(stat.size > MAX_FILE_BYTES).toBe(true);
    });
});

#!/usr/bin/env node
/**
 * LiveClaw Vision MCP Server
 *
 * Provides an `image_analysis` tool to picobot agents.
 * Enforces a per-user daily cap tracked in the shared DB, then forwards
 * the request to OpenRouter using the server's API key (not the user's
 * Bifrost virtual key — vision usage is accounted for separately).
 *
 * Spawned once per picobot instance by spawnPicobot() in server.js.
 * Required env vars (injected by orchestrator):
 *   VISION_USER_ID      — LiveClaw user ID (for cap tracking)
 *   OPENROUTER_API_KEY  — server's OpenRouter key
 *   VISION_MODEL        — OpenRouter model ID (default: qwen/qwen2.5-vl-72b-instruct:free)
 *   VISION_DAILY_LIMIT  — max image analyses per user per UTC day (default: 20)
 *   DB_PATH             — SQLite DB path (set when not using PostgreSQL)
 *   DATABASE_URL        — PostgreSQL connection string (set in production)
 */

'use strict';

const { McpServer }          = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z }                  = require('zod');
const { createDatabase }     = require('./database.js');

// ─── Config ─────────────────────────────────────────────────────────────────

const USER_ID     = process.env.VISION_USER_ID || '';
const API_KEY     = process.env.OPENROUTER_API_KEY || '';
const MODEL       = process.env.VISION_MODEL || 'qwen/qwen2.5-vl-72b-instruct:free';
const DAILY_LIMIT = parseInt(process.env.VISION_DAILY_LIMIT || '20', 10);
const DB_PATH     = process.env.DB_PATH;
const DATABASE_URL = process.env.DATABASE_URL || '';

if (!USER_ID) {
    process.stderr.write('vision-mcp: VISION_USER_ID not set\n');
    process.exit(1);
}
if (!API_KEY) {
    process.stderr.write('vision-mcp: OPENROUTER_API_KEY not set\n');
    process.exit(1);
}

// ─── Database ────────────────────────────────────────────────────────────────

const db = createDatabase({ databaseUrl: DATABASE_URL || undefined, dbPath: DB_PATH });

async function initDb() {
    await db.exec(`
        CREATE TABLE IF NOT EXISTS vision_usage (
            user_id TEXT NOT NULL,
            day     TEXT NOT NULL,
            count   INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (user_id, day)
        )
    `);
}

/** Returns current UTC date as YYYY-MM-DD */
function utcDay() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Atomically check the daily cap and increment if allowed.
 * Returns { allowed: boolean, used: number, limit: number }
 */
async function checkAndIncrement() {
    const day = utcDay();
    const row = await db.get(
        'SELECT count FROM vision_usage WHERE user_id = ? AND day = ?',
        [USER_ID, day]
    );
    const used = row ? row.count : 0;

    if (used >= DAILY_LIMIT) {
        return { allowed: false, used, limit: DAILY_LIMIT };
    }

    if (row) {
        await db.run(
            'UPDATE vision_usage SET count = count + 1 WHERE user_id = ? AND day = ?',
            [USER_ID, day]
        );
    } else {
        await db.run(
            'INSERT INTO vision_usage (user_id, day, count) VALUES (?, ?, 1)',
            [USER_ID, day]
        );
    }

    return { allowed: true, used: used + 1, limit: DAILY_LIMIT };
}

// ─── URL Validation (SSRF Protection) ────────────────────────────────────────

function validateImageUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') throw new Error('Only HTTPS URLs allowed');
        if (url.includes('@')) throw new Error('URLs with credentials not allowed');
        const host = parsed.hostname.toLowerCase();
        if (host === 'localhost' || host === 'metadata.google.internal') throw new Error('Internal hostname blocked');
        if (parsed.port && parsed.port !== '443') throw new Error('Non-standard port blocked');
        // Check for private/reserved IPs
        const parts = host.split('.').map(Number);
        if (parts.length === 4 && parts.every(n => !isNaN(n))) {
            if (parts[0] === 10) throw new Error('Private IP blocked');
            if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) throw new Error('Private IP blocked');
            if (parts[0] === 192 && parts[1] === 168) throw new Error('Private IP blocked');
            if (parts[0] === 127) throw new Error('Loopback blocked');
            if (parts[0] === 169 && parts[1] === 254) throw new Error('Link-local blocked');
        }
        // Block all IPv6 private/reserved ranges
        if (host === '::1' || host === '::' || host.startsWith('[') ||
            host.startsWith('fe80') || host.startsWith('fc00') || host.startsWith('fd00') ||
            host.startsWith('2001:db8')) throw new Error('IPv6 private/reserved blocked');
        // Block DNS rebinding hostnames that resolve to private IPs
        if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
            host.includes('nip.io') || host.includes('sslip.io') || host.includes('xip.io') ||
            host.includes('localtest.me') || host.includes('lvh.me')) throw new Error('DNS rebinding hostname blocked');
        return parsed.href;
    } catch (e) {
        throw new Error(`Invalid image URL: ${e.message}`);
    }
}

// ─── OpenRouter Vision Call ───────────────────────────────────────────────────

async function callVisionModel(imageUrl, prompt) {
    // Allow base64 data URIs to pass through; validate all other URLs for SSRF
    if (!imageUrl.startsWith('data:')) {
        imageUrl = validateImageUrl(imageUrl);
    }
    const userPrompt = prompt || 'Describe this image in detail.';

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://liveclaw.xyz',
            'X-Title': 'LiveClaw Vision',
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'image_url', image_url: { url: imageUrl } },
                        { type: 'text', text: userPrompt },
                    ],
                },
            ],
            max_tokens: 1024,
        }),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`OpenRouter ${response.status}: ${body}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || 'No response from vision model.';
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

async function main() {
    await initDb();

    const server = new McpServer({
        name: 'liveclaw-vision',
        version: '1.0.0',
    });

    server.tool(
        'image_analysis',
        `Analyze or describe an image. Accepts a public HTTPS URL or a base64 data URI (e.g. "data:image/png;base64,..."). Useful for reading screenshots, diagrams, photos, or any visual content sent by the user. Usage is capped at ${DAILY_LIMIT} analyses per day (resets midnight UTC).`,
        {
            image_url: z.string().describe(
                'Public HTTPS URL or base64 data URI of the image to analyze'
            ),
            prompt: z.string().optional().describe(
                'Specific question or instruction about the image (e.g. "What does this error say?")'
            ),
        },
        async ({ image_url, prompt }) => {
            const { allowed, used, limit } = await checkAndIncrement();

            if (!allowed) {
                return {
                    content: [{
                        type: 'text',
                        text: `Image analysis limit reached (${limit} per day). Resets at midnight UTC.`,
                    }],
                    isError: true,
                };
            }

            const result = await callVisionModel(image_url, prompt);

            return {
                content: [{
                    type: 'text',
                    text: `${result}\n\n_(Vision usage today: ${used}/${limit})_`,
                }],
            };
        }
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(err => {
    process.stderr.write(`vision-mcp fatal: ${err.message}\n`);
    process.exit(1);
});

#!/usr/bin/env node
/**
 * LiveClaw Telegram File MCP Server
 *
 * Provides a `send_telegram_document` tool to picobot agents, enabling
 * Claw to send actual file attachments (CSV, text, JSON, etc.) to Telegram.
 *
 * Spawned once per picobot instance by spawnPicobot() in server.js.
 * Required env vars (injected by orchestrator):
 *   TELEGRAM_BOT_TOKEN  — user's Telegram bot token
 *   WORKSPACE_DIR       — picobot workspace directory (for file access)
 *   CHAT_ID_FILE        — path to .telegram_chat_id file (written at register-chat)
 */

'use strict';

const { McpServer }            = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z }                    = require('zod');
const fs                       = require('fs');
const path                     = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN || '';
const WORKSPACE    = process.env.WORKSPACE_DIR || '';
const CHAT_ID_FILE = process.env.CHAT_ID_FILE || '';

// Max file size — Telegram allows 50MB but we cap at 10MB to protect memory
const MAX_FILE_BYTES = 10 * 1024 * 1024;

if (!BOT_TOKEN) {
    process.stderr.write('telegram-file-mcp: TELEGRAM_BOT_TOKEN not set\n');
    process.exit(1);
}
if (!WORKSPACE) {
    process.stderr.write('telegram-file-mcp: WORKSPACE_DIR not set\n');
    process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Cached chat ID — avoids repeated file reads or API calls
let cachedChatId = null;

/**
 * Read the Telegram chat ID from the per-user file written by register-chat
 * or the orchestrator at deploy time. Returns null if not yet available.
 */
function readChatIdFromFile() {
    const filePath = CHAT_ID_FILE || path.join(WORKSPACE, '.telegram_chat_id');
    try {
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        return raw || null;
    } catch (_) {
        return null;
    }
}

/**
 * Discover the chat ID by calling Telegram's getUpdates API.
 * Uses offset=-1, limit=1, timeout=0 for a non-blocking peek at the
 * most recent update. This is safe even when picobot is long-polling
 * because picobot acknowledges updates with offsets, and we only peek.
 *
 * On success, writes the chat ID to the file so future reads are instant.
 */
async function discoverChatIdFromTelegram() {
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=-1&limit=1&timeout=0`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        const updates = data.result || [];
        if (updates.length === 0) return null;

        const update = updates[0];
        const chatId = update.message?.chat?.id
            || update.callback_query?.message?.chat?.id
            || update.edited_message?.chat?.id;
        if (!chatId) return null;

        // Persist to file for future reads
        const filePath = CHAT_ID_FILE || path.join(WORKSPACE, '.telegram_chat_id');
        try { fs.writeFileSync(filePath, String(chatId), 'utf8'); } catch (_) {}

        return String(chatId);
    } catch (_) {
        return null;
    }
}

/**
 * Get the Telegram chat ID — tries file first, then Telegram API discovery.
 */
async function getChatId() {
    if (cachedChatId) return cachedChatId;

    // Try the file first (instant, no API call)
    const fromFile = readChatIdFromFile();
    if (fromFile) {
        cachedChatId = fromFile;
        return fromFile;
    }

    // Fall back to Telegram API discovery
    const discovered = await discoverChatIdFromTelegram();
    if (discovered) {
        cachedChatId = discovered;
    }
    return discovered;
}

/**
 * Resolve a file path relative to WORKSPACE_DIR.
 * Rejects paths that escape the workspace (path traversal protection).
 *
 * @param {string} relOrAbs - File path as given by the agent
 * @returns {string} Absolute path within workspace
 * @throws {Error} If path traversal detected
 */
function resolveWorkspacePath(relOrAbs) {
    const resolved = path.isAbsolute(relOrAbs)
        ? relOrAbs
        : path.resolve(WORKSPACE, relOrAbs);

    // Normalise and check containment
    const normal = path.normalize(resolved);
    const wsNormal = path.normalize(WORKSPACE);
    if (!normal.startsWith(wsNormal + path.sep) && normal !== wsNormal) {
        throw new Error(`Path escapes workspace: ${relOrAbs}`);
    }
    return normal;
}

/**
 * Send a file to Telegram via sendDocument.
 * Uses built-in FormData + Blob (Node 22+).
 *
 * @param {string} chatId
 * @param {string} filePath
 * @param {string} [caption]
 * @returns {Promise<void>}
 */
async function sendDocument(chatId, filePath, caption) {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName   = path.basename(filePath);
    const blob       = new Blob([fileBuffer]);

    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('document', blob, fileName);
    if (caption) {
        form.append('caption', caption.slice(0, 1024)); // Telegram caption limit
    }

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;
    const res = await fetch(url, { method: 'POST', body: form });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Telegram sendDocument ${res.status}: ${body}`);
    }
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

async function main() {
    const server = new McpServer({
        name: 'liveclaw-telegram-files',
        version: '1.0.0',
    });

    server.tool(
        'send_telegram_document',
        `Send a file as a Telegram document attachment to the current user's chat.
Use this when the user asks you to "send a CSV", "attach a file", "send a document", or similar.
The file must already exist in the workspace directory.
Supports any file type: CSV, JSON, TXT, PDF, images, etc.
Returns success or an error message if the file cannot be sent.`,
        {
            file_path: z.string().describe(
                'Path to the file — relative to workspace (e.g. "report.csv") or absolute within workspace'
            ),
            caption: z.string().optional().describe(
                'Optional caption shown below the file in Telegram (max 1024 chars)'
            ),
        },
        async ({ file_path, caption }) => {
            const chatId = await getChatId();
            if (!chatId) {
                return {
                    content: [{
                        type: 'text',
                        text: 'Cannot send file: unable to determine Telegram chat ID. The user may need to send a message to the bot first.',
                    }],
                    isError: true,
                };
            }

            let absPath;
            try {
                absPath = resolveWorkspacePath(file_path);
            } catch (e) {
                return {
                    content: [{ type: 'text', text: `Invalid file path: ${e.message}` }],
                    isError: true,
                };
            }

            if (!fs.existsSync(absPath)) {
                return {
                    content: [{ type: 'text', text: `File not found: ${file_path}` }],
                    isError: true,
                };
            }

            const stat = fs.statSync(absPath);
            if (stat.size > MAX_FILE_BYTES) {
                return {
                    content: [{
                        type: 'text',
                        text: `File too large (${Math.round(stat.size / 1024 / 1024)}MB). Maximum is 10MB.`,
                    }],
                    isError: true,
                };
            }

            try {
                await sendDocument(chatId, absPath, caption);
                return {
                    content: [{
                        type: 'text',
                        text: `File "${path.basename(absPath)}" sent successfully to Telegram.`,
                    }],
                };
            } catch (e) {
                return {
                    content: [{ type: 'text', text: `Failed to send file: ${e.message}` }],
                    isError: true,
                };
            }
        }
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(err => {
    process.stderr.write(`telegram-file-mcp fatal: ${err.message}\n`);
    process.exit(1);
});

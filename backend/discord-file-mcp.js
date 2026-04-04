#!/usr/bin/env node
/**
 * LiveClaw Discord File MCP Server
 *
 * Provides a `send_discord_file` tool to picobot agents, enabling
 * Claw to send actual file attachments to Discord channels.
 *
 * Channel ID discovery: picobot writes session files at
 *   {WORKSPACE_DIR}/sessions/discord:<channelID>.json
 * We scan these to find the most recently active channel.
 *
 * Spawned by spawnPicobot() in server.js. Env vars are inherited
 * from the picobot process (picobot has no MCPServerConfig.env field —
 * all creds are passed via the picobot spawn env).
 *
 * Required env vars (inherited from picobot):
 *   DISCORD_BOT_TOKEN  — user's Discord bot token
 *   WORKSPACE_DIR      — picobot workspace directory
 */

'use strict';

const { McpServer }            = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z }                    = require('zod');
const fs                       = require('fs');
const path                     = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const BOT_TOKEN  = process.env.DISCORD_BOT_TOKEN || '';
const WORKSPACE  = process.env.WORKSPACE_DIR || '';

const MAX_FILE_BYTES = 10 * 1024 * 1024; // Discord allows 25MB but cap at 10MB

if (!BOT_TOKEN) {
    process.stderr.write('discord-file-mcp: DISCORD_BOT_TOKEN not set\n');
    process.exit(1);
}
if (!WORKSPACE) {
    process.stderr.write('discord-file-mcp: WORKSPACE_DIR not set\n');
    process.exit(1);
}

// ─── Channel ID Discovery ─────────────────────────────────────────────────────

/**
 * Scan workspace/sessions/ for discord:*.json files.
 * Returns the channel ID from the most recently modified session.
 *
 * Picobot writes session files named:  sessions/discord:<channelID>.json
 * The most recently modified one is the active channel.
 */
function findActiveChannel() {
    const sessionsDir = path.join(WORKSPACE, 'sessions');
    let entries;
    try {
        entries = fs.readdirSync(sessionsDir);
    } catch (_) {
        return null;
    }

    const discordFiles = entries
        .filter(f => f.startsWith('discord:') && f.endsWith('.json'))
        .map(f => {
            const channelId = f.slice('discord:'.length, -'.json'.length);
            const fullPath  = path.join(sessionsDir, f);
            let mtime = 0;
            try { mtime = fs.statSync(fullPath).mtimeMs; } catch (_) {}
            return { channelId, mtime };
        })
        .filter(e => e.channelId.length > 0);

    if (discordFiles.length === 0) return null;

    // Most recently modified session = active channel
    discordFiles.sort((a, b) => b.mtime - a.mtime);
    return discordFiles[0].channelId;
}

// ─── Path Safety ─────────────────────────────────────────────────────────────

function resolveWorkspacePath(relOrAbs) {
    const resolved = path.isAbsolute(relOrAbs)
        ? relOrAbs
        : path.resolve(WORKSPACE, relOrAbs);
    const normal  = path.normalize(resolved);
    const wsNormal = path.normalize(WORKSPACE);
    if (!normal.startsWith(wsNormal + path.sep) && normal !== wsNormal) {
        throw new Error(`Path escapes workspace: ${relOrAbs}`);
    }
    return normal;
}

// ─── Discord API ──────────────────────────────────────────────────────────────

/**
 * Send a file to a Discord channel via the REST API.
 * Uses multipart/form-data with files[0] field.
 */
async function sendFile(channelId, filePath, caption) {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName   = path.basename(filePath);
    const blob       = new Blob([fileBuffer]);

    const form = new FormData();
    // payload_json sets the message content (caption)
    if (caption) {
        form.append('payload_json', JSON.stringify({ content: caption.slice(0, 2000) }));
    }
    form.append('files[0]', blob, fileName);

    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bot ${BOT_TOKEN}` },
        body: form,
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Discord API ${res.status}: ${body}`);
    }
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

async function main() {
    const server = new McpServer({
        name: 'liveclaw-discord-files',
        version: '1.0.0',
    });

    server.tool(
        'send_discord_file',
        `Send a file as a Discord attachment to the current user's channel.
Use this when a Discord user asks you to "send a CSV", "attach a file", "send a document", or similar.
The file must already exist in the workspace directory.
Supports any file type: CSV, JSON, TXT, PDF, images, etc. (max 10MB).
Returns success or an error message.`,
        {
            file_path: z.string().describe(
                'Path to the file — relative to workspace (e.g. "report.csv") or absolute within workspace'
            ),
            caption: z.string().optional().describe(
                'Optional message text shown with the file (max 2000 chars)'
            ),
        },
        async ({ file_path, caption }) => {
            const channelId = findActiveChannel();
            if (!channelId) {
                return {
                    content: [{
                        type: 'text',
                        text: 'Cannot send file: no active Discord channel found. The user needs to send at least one message first.',
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
                await sendFile(channelId, absPath, caption);
                return {
                    content: [{
                        type: 'text',
                        text: `File "${path.basename(absPath)}" sent successfully to Discord.`,
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
    process.stderr.write(`discord-file-mcp fatal: ${err.message}\n`);
    process.exit(1);
});

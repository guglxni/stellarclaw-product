#!/usr/bin/env node
/**
 * LiveClaw Slack File MCP Server
 *
 * Provides a `send_slack_file` tool to picobot agents, enabling
 * Claw to send actual file attachments to Slack channels/DMs.
 *
 * Channel ID discovery: picobot writes session files at
 *   {WORKSPACE_DIR}/sessions/slack:<channelID>::<threadTS>.json
 * We scan these to find the most recently active channel.
 *
 * File upload uses Slack's v2 upload API:
 *   1. files.getUploadURLExternal — get a presigned upload URL
 *   2. PUT <upload_url>           — upload file bytes
 *   3. files.completeUploadExternal — publish to channel (optionally in thread)
 *
 * Spawned by spawnPicobot() in server.js. Env vars are inherited
 * from the picobot process (no MCPServerConfig.env support in picobot).
 *
 * Required env vars (inherited from picobot):
 *   SLACK_BOT_TOKEN  — user's Slack bot token (xoxb-...)
 *   WORKSPACE_DIR    — picobot workspace directory
 */

'use strict';

const { McpServer }            = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z }                    = require('zod');
const fs                       = require('fs');
const path                     = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const WORKSPACE = process.env.WORKSPACE_DIR || '';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SLACK_API = 'https://slack.com/api';

if (!BOT_TOKEN) {
    process.stderr.write('slack-file-mcp: SLACK_BOT_TOKEN not set\n');
    process.exit(1);
}
if (!WORKSPACE) {
    process.stderr.write('slack-file-mcp: WORKSPACE_DIR not set\n');
    process.exit(1);
}

// ─── Channel/Thread Discovery ────────────────────────────────────────────────

/**
 * Scan workspace/sessions/ for slack:*.json files.
 * Picobot names them:  sessions/slack:<channelID>::<threadTS>.json
 *
 * Returns { channelId, threadTs } from the most recently modified session.
 */
function findActiveSession() {
    const sessionsDir = path.join(WORKSPACE, 'sessions');
    let entries;
    try {
        entries = fs.readdirSync(sessionsDir);
    } catch (_) {
        return null;
    }

    const slackFiles = entries
        .filter(f => f.startsWith('slack:') && f.endsWith('.json'))
        .map(f => {
            // slack:<channelID>::<threadTS>.json  OR  slack:<channelID>.json (DM without thread)
            const raw       = f.slice('slack:'.length, -'.json'.length);
            const sepIdx    = raw.indexOf('::');
            const channelId = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;
            const threadTs  = sepIdx >= 0 ? raw.slice(sepIdx + 2) : null;
            const fullPath  = path.join(sessionsDir, f);
            let mtime = 0;
            try { mtime = fs.statSync(fullPath).mtimeMs; } catch (_) {}
            return { channelId, threadTs, mtime };
        })
        .filter(e => e.channelId.length > 0);

    if (slackFiles.length === 0) return null;

    slackFiles.sort((a, b) => b.mtime - a.mtime);
    return slackFiles[0];
}

// ─── Path Safety ─────────────────────────────────────────────────────────────

function resolveWorkspacePath(relOrAbs) {
    const resolved = path.isAbsolute(relOrAbs)
        ? relOrAbs
        : path.resolve(WORKSPACE, relOrAbs);
    const normal   = path.normalize(resolved);
    const wsNormal = path.normalize(WORKSPACE);
    if (!normal.startsWith(wsNormal + path.sep) && normal !== wsNormal) {
        throw new Error(`Path escapes workspace: ${relOrAbs}`);
    }
    return normal;
}

// ─── Slack File Upload (v2 API) ───────────────────────────────────────────────

/**
 * Step 1: Get a presigned upload URL from Slack.
 */
async function getUploadUrl(filename, fileSize) {
    const params = new URLSearchParams({ filename, length: String(fileSize) });
    const res = await fetch(`${SLACK_API}/files.getUploadURLExternal?${params}`, {
        headers: { 'Authorization': `Bearer ${BOT_TOKEN}` },
    });
    if (!res.ok) throw new Error(`getUploadURLExternal HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(`getUploadURLExternal: ${data.error}`);
    return { uploadUrl: data.upload_url, fileId: data.file_id };
}

/**
 * Step 2: Upload the file bytes to the presigned URL.
 */
async function uploadBytes(uploadUrl, fileBuffer) {
    const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: fileBuffer,
    });
    if (!res.ok) throw new Error(`File upload HTTP ${res.status}`);
}

/**
 * Step 3: Complete the upload and publish to channel (optionally in thread).
 */
async function completeUpload(fileId, title, channelId, threadTs, caption) {
    const body = {
        files: [{ id: fileId, title }],
        channel_id: channelId,
        ...(caption ? { initial_comment: caption.slice(0, 3000) } : {}),
        ...(threadTs ? { thread_ts: threadTs } : {}),
    };
    const res = await fetch(`${SLACK_API}/files.completeUploadExternal`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${BOT_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`completeUploadExternal HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(`completeUploadExternal: ${data.error}`);
}

/**
 * Orchestrate the full 3-step Slack file upload flow.
 */
async function sendFile(channelId, threadTs, filePath, caption) {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName   = path.basename(filePath);
    const fileSize   = fileBuffer.length;

    const { uploadUrl, fileId } = await getUploadUrl(fileName, fileSize);
    await uploadBytes(uploadUrl, fileBuffer);
    await completeUpload(fileId, fileName, channelId, threadTs, caption);
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

async function main() {
    const server = new McpServer({
        name: 'liveclaw-slack-files',
        version: '1.0.0',
    });

    server.tool(
        'send_slack_file',
        `Send a file as a Slack attachment to the current user's channel or DM.
Use this when a Slack user asks you to "send a CSV", "attach a file", "send a document", or similar.
The file must already exist in the workspace directory.
Supports any file type: CSV, JSON, TXT, PDF, images, etc. (max 10MB).
File is posted in the same thread/channel where the user is chatting.
Returns success or an error message.`,
        {
            file_path: z.string().describe(
                'Path to the file — relative to workspace (e.g. "report.csv") or absolute within workspace'
            ),
            caption: z.string().optional().describe(
                'Optional message shown with the file upload (max 3000 chars)'
            ),
        },
        async ({ file_path, caption }) => {
            const session = findActiveSession();
            if (!session) {
                return {
                    content: [{
                        type: 'text',
                        text: 'Cannot send file: no active Slack channel found. The user needs to send at least one message first.',
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
                await sendFile(session.channelId, session.threadTs, absPath, caption);
                return {
                    content: [{
                        type: 'text',
                        text: `File "${path.basename(absPath)}" sent successfully to Slack.`,
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
    process.stderr.write(`slack-file-mcp fatal: ${err.message}\n`);
    process.exit(1);
});

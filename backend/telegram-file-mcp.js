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
const { execFile }             = require('child_process');

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

// ─── Telegram file download helpers ─────────────────────────────────────────

/**
 * Get the most recent document/file sent by the user.
 *
 * Two sources, tried in order:
 * 1. .incoming_files.json — written by the orchestrator's file interceptor,
 *    which polls Telegram updates in parallel with picobot and saves file
 *    metadata before picobot acknowledges (consumes) the updates.
 * 2. Telegram getUpdates — fallback for cases where the interceptor hasn't
 *    saved the file yet (e.g. first message after boot).
 *
 * picobot uses long-polling on the same bot token, so getUpdates alone
 * is unreliable — picobot typically acknowledges updates within 1-2s,
 * making them invisible to subsequent getUpdates calls.
 */
async function peekLatestDocument() {
    // Source 1: Read from orchestrator's file interceptor (most reliable)
    const metadataPath = path.join(WORKSPACE, '.incoming_files.json');
    try {
        const raw = fs.readFileSync(metadataPath, 'utf8');
        const files = JSON.parse(raw);
        if (Array.isArray(files) && files.length > 0) {
            // Return the most recent file
            const latest = files[files.length - 1];
            // Remove it from the list so it's not re-processed
            const remaining = files.slice(0, -1);
            fs.writeFileSync(metadataPath, JSON.stringify(remaining, null, 2), 'utf8');
            return latest;
        }
    } catch (_) {
        // File doesn't exist or is invalid — fall through to getUpdates
    }

    // Source 2: Fallback — peek at Telegram updates (may fail if picobot already consumed)
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=-10&limit=10&timeout=0`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json();
        const updates = (data.result || []).reverse();
        for (const update of updates) {
            const msg = update.message || update.edited_message;
            if (!msg) continue;
            if (msg.document) return { type: 'document', file_id: msg.document.file_id, file_name: msg.document.file_name, mime_type: msg.document.mime_type, file_size: msg.document.file_size };
            if (msg.photo) {
                const largest = msg.photo[msg.photo.length - 1];
                return { type: 'photo', file_id: largest.file_id, file_name: 'photo.jpg', mime_type: 'image/jpeg', file_size: largest.file_size };
            }
        }
    } catch (_) {}

    return null;
}

/**
 * Download a Telegram file by file_id to the workspace directory.
 * Returns the local path where the file was saved.
 */
async function downloadTelegramFile(fileId, fileName) {
    // Step 1: Get the file path from Telegram
    const infoRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
    if (!infoRes.ok) throw new Error(`getFile failed: ${infoRes.status}`);
    const info = await infoRes.json();
    if (!info.ok) throw new Error(`getFile error: ${JSON.stringify(info)}`);
    const filePath = info.result.file_path;

    // Step 2: Download the actual file
    const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    const fileRes = await fetch(downloadUrl);
    if (!fileRes.ok) throw new Error(`Download failed: ${fileRes.status}`);

    // Sanitize filename
    const safeName = (fileName || 'received_file').replace(/[^a-zA-Z0-9._-]/g, '_');
    const localPath = path.join(WORKSPACE, safeName);
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    fs.writeFileSync(localPath, buffer);
    return localPath;
}

// Vision model config — inherited from picobot spawn env
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
// OCR_MODEL: dedicated document understanding model (Qwen3-VL, purpose-built for OCR/text extraction)
// VISION_MODEL: general image analysis (used by vision-mcp.js for photos)
const OCR_MODEL    = process.env.OCR_MODEL    || 'qwen/qwen3-vl-32b-instruct';
// VISION_MODEL fallback here matches vision-mcp.js — used only if OCR_MODEL isn't set
const VISION_MODEL = process.env.VISION_MODEL || 'bytedance-seed/seed-1.6-flash';

/**
 * Convert first N pages of a PDF to PNG images via pdftoppm (poppler-utils).
 * Returns array of absolute file paths for each page image.
 */
function pdfToImages(pdfPath, maxPages = 3, dpi = 150) {
    return new Promise((resolve) => {
        const prefix = pdfPath.replace(/\.pdf$/i, '') + '_page';
        // -r DPI, -png, -l maxPages (last page), -f 1 (first page)
        execFile('pdftoppm', ['-r', String(dpi), '-png', '-f', '1', '-l', String(maxPages), pdfPath, prefix],
            { timeout: 30000 },
            (err) => {
                if (err) { resolve([]); return; }
                // pdftoppm creates files like prefix-1.png, prefix-01.png, etc.
                try {
                    const dir = path.dirname(prefix);
                    const base = path.basename(prefix);
                    const files = fs.readdirSync(dir)
                        .filter(f => f.startsWith(base) && f.endsWith('.png'))
                        .sort()
                        .slice(0, maxPages)
                        .map(f => path.join(dir, f));
                    resolve(files);
                } catch (_) { resolve([]); }
            });
    });
}

/**
 * OCR PDF page images via Qwen3-VL-32B (OCR_MODEL env var).
 * Qwen3-VL is purpose-built for document understanding — handles scanned pages,
 * dense tables, mixed layouts, and multi-language content correctly.
 *
 * Implements exponential backoff retry (3 attempts: immediate → 1s → 2s) for
 * transient failures (rate limits, gateway timeouts). Throws on permanent failure
 * so the caller can surface a clear error rather than silently returning garbage.
 *
 * Pages sent as base64 data URLs — no external hosting required.
 */
async function ocrImagesViaVision(imagePaths) {
    if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY not configured');
    if (imagePaths.length === 0) throw new Error('No page images to OCR');

    const imageContent = imagePaths.slice(0, 3).map(imgPath => {
        const ext = path.extname(imgPath).slice(1).toLowerCase() || 'png';
        const mimeType = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        const b64 = fs.readFileSync(imgPath).toString('base64');
        return { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } };
    });

    const messages = [{
        role: 'user',
        content: [
            ...imageContent,
            { type: 'text', text: 'Extract all text from these PDF page images. Output only the raw text, preserving structure (headings, tables, lists) where present. No commentary.' },
        ],
    }];

    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS   = [0, 1000, 2000]; // immediate, 1s, 2s

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (BACKOFF_MS[attempt] > 0) {
            await new Promise(r => setTimeout(r, BACKOFF_MS[attempt]));
        }
        try {
            const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'X-Title': 'LiveClaw PDF OCR',
                },
                body: JSON.stringify({ model: OCR_MODEL, messages, max_tokens: 4096 }),
                signal: AbortSignal.timeout(30000), // hard 30s timeout per attempt
            });

            // Retry on transient server errors (429 rate limit, 5xx gateway errors)
            if (res.status === 429 || res.status >= 500) {
                if (attempt < MAX_ATTEMPTS - 1) continue;
                throw new Error(`OCR API returned ${res.status} after ${MAX_ATTEMPTS} attempts`);
            }

            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error(`OCR API error ${res.status}: ${body.slice(0, 200)}`);
            }

            const data = await res.json();
            const text = data.choices?.[0]?.message?.content?.trim();
            if (!text) throw new Error('OCR model returned empty response');
            return text;

        } catch (err) {
            if (attempt === MAX_ATTEMPTS - 1) throw err; // re-throw on final attempt
            // Retry on network errors and timeouts
        }
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

    server.tool(
        'get_telegram_document',
        `Retrieve the most recent document or file that the user sent to you in Telegram.
Use this when the user's message appears empty or they mention sending a file/document/PDF.
Picobot cannot pass document contents directly — this tool fetches and processes them.
For PDFs: runs full vision OCR via Qwen3-VL-32B (handles text, scanned, tables, mixed layouts).
For other files: downloads to workspace and returns the file path.
Always call this tool first before telling the user you cannot read their file.`,
        {},
        async () => {
            try {
                const doc = await peekLatestDocument();
                if (!doc) {
                    return {
                        content: [{ type: 'text', text: 'No recent document found. The user may not have sent a file, or the file was sent too long ago. Ask the user to resend the document.' }],
                        isError: true,
                    };
                }

                if (doc.file_size && doc.file_size > MAX_FILE_BYTES) {
                    return {
                        content: [{ type: 'text', text: `File is too large (${Math.round(doc.file_size / 1024 / 1024)}MB). Maximum supported size is 10MB.` }],
                        isError: true,
                    };
                }

                const localPath = await downloadTelegramFile(doc.file_id, doc.file_name);
                const fileName = path.basename(localPath);

                // PDF path — vision OCR only (Qwen3-VL-32B).
                // No parallel pdftotext: OCR is strictly superior in quality for all PDF types
                // (scanned, text-embedded, mixed layouts, tables). pdftotext degrades quality.
                // Resilience is handled via retry/backoff inside ocrImagesViaVision, not fallback.
                const isPdf = (doc.mime_type || '').includes('pdf') || fileName.toLowerCase().endsWith('.pdf');
                if (isPdf) {
                    const fileSizeKb = Math.round((doc.file_size || 0) / 1024);
                    const pageImages = await pdfToImages(localPath, 3, 150);

                    try {
                        const ocrText = await ocrImagesViaVision(pageImages);
                        const pageNote = pageImages.length > 0 ? `, ${pageImages.length} page${pageImages.length > 1 ? 's' : ''} analysed` : '';
                        return {
                            content: [{
                                type: 'text',
                                text: `PDF received: "${fileName}" (${fileSizeKb}KB${pageNote})\n\nExtracted text:\n\n${ocrText.slice(0, 8000)}${ocrText.length > 8000 ? '\n\n[Truncated at 8000 chars — full file saved to workspace]' : ''}`,
                            }],
                        };
                    } catch (ocrErr) {
                        return {
                            content: [{
                                type: 'text',
                                text: `PDF received: "${fileName}" (${fileSizeKb}KB) — OCR failed: ${ocrErr.message}. The file is saved to workspace. Please ask the user to paste the key text or resend later.`,
                            }],
                            isError: true,
                        };
                    } finally {
                        // Always clean up temp page images
                        for (const img of pageImages) { try { fs.unlinkSync(img); } catch (_) {} }
                    }
                }

                return {
                    content: [{
                        type: 'text',
                        text: `File received: "${fileName}" (${doc.mime_type || 'unknown type'}, ${Math.round((doc.file_size || 0) / 1024)}KB). Saved to workspace. You can now read or process it from the workspace directory.`,
                    }],
                };
            } catch (e) {
                return {
                    content: [{ type: 'text', text: `Failed to retrieve document: ${e.message}` }],
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

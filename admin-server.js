'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 5500;
const API_BASE = 'http://localhost:3000';
const STATIC_ROOT = path.join(__dirname, 'liveclaw-web', 'www');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.png':  'image/png',
    '.ico':  'image/x-icon',
    '.woff2':'font/woff2',
    '.svg':  'image/svg+xml',
    '.json': 'application/json',
};

const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = reqUrl.pathname;

    // Proxy /api/* -> backend at :3000
    if (pathname.startsWith('/api/')) {
        const target = API_BASE + pathname.slice(4) + reqUrl.search;
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', async () => {
            try {
                const body = Buffer.concat(chunks);
                const headers = { ...req.headers, host: 'localhost:3000' };
                delete headers['content-length'];
                const opts = { method: req.method, headers };
                if (body.length) {
                    opts.body = body;
                    headers['content-length'] = String(body.length);
                }
                const r = await fetch(target, opts);
                const rb = await r.arrayBuffer();
                res.writeHead(r.status, Object.fromEntries(r.headers));
                res.end(Buffer.from(rb));
            } catch (e) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Proxy error: ' + e.message);
            }
        });
        return;
    }

    // Resolve file path
    let filePath = path.join(STATIC_ROOT, pathname);

    // /admin or /admin/ -> admin/index.html
    if (pathname === '/' || pathname === '/admin' || pathname === '/admin/') {
        filePath = path.join(STATIC_ROOT, 'admin', 'index.html');
    }

    // If directory, try index.html inside
    try {
        if (fs.statSync(filePath).isDirectory()) {
            filePath = path.join(filePath, 'index.html');
        }
    } catch (_) {}

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found: ' + pathname);
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  🦀 LiveClaw Admin Dashboard`);
    console.log(`  → http://localhost:${PORT}/admin/\n`);
    console.log(`  Admin secret: oKROk1wlJr4E-DvFOMw_zBF6dWI-b9T-`);
    console.log(`  API proxied to: ${API_BASE}\n`);
});

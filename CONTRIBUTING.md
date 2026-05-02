# Contributing

Thanks for your interest in StellarClaw. This document covers the basics for getting a working dev environment, the conventions we follow, and how patches make it from your branch to `main`.

## Setting up

```bash
git clone https://github.com/guglxni/stellarclaw-product.git
cd stellarclaw-product

# install
cd backend
cp .env.example .env       # fill in CHANGE_ME values
npm install --legacy-peer-deps

# run
npm run dev                # nodemon-style hot reload on :4001
```

You'll need at minimum: a Postgres database (local Postgres works; `docker run -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:16` is fine for development), a Google OAuth Web Client ID, and a Cloudflare Turnstile sitekey + secret. See [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md) for the full key map.

For Stellar work specifically, the agent will provision wallets on the network in `STELLARCLAW_DEFAULT_NETWORK`. Use `testnet` during development unless you're explicitly testing a mainnet flow.

## Project layout

```
.
├── backend/                 Node.js orchestrator
│   ├── server.js               main HTTP server, picobot supervisor
│   ├── routes/                 Express routers
│   ├── database.js             Postgres adapter (with SQLite fallback for tests)
│   ├── tests/                  Vitest suite
│   └── package.json
│
├── ../StellarClaw-design/mvp/  Stellar MCP servers (sibling project, symlinked)
│   ├── mcp/
│   │   ├── stellar-mcp.js
│   │   ├── soroswap-mcp.js
│   │   ├── cards402-mcp.js
│   │   └── x402-mcp.js
│   ├── lib/
│   │   ├── caps.js             Per-bot cap enforcement
│   │   ├── intents.js          Intent ledger helpers
│   │   └── soul-template.js    Identity / capabilities prompt
│   ├── infra/                  Deployment scripts
│   └── package.json
│
├── docs/                    Public documentation
├── scripts/                 Operational scripts
└── .github/workflows/       CI: lint, audit, test, deploy
```

## Conventions

### Code style

- Node.js 22 features are fair game (top-level await, native fetch, structured clone).
- Prefer `async/await` over raw promise chains.
- ES modules on the MCP side, CommonJS on the orchestrator side (it's how the codebase started; we don't mix per-file).
- Two-space indent, no semicolons-elision; we run Prettier on save.

### Logging

Always log via the scoped logger. Never call `console.log` in committed code outside CLI scripts.

```javascript
const log = require('./logger.js');

log.startup.info({ userId, walletAddress }, 'wallet provisioned');
log.stellar.error({ err, txHash }, 'submit failed');
```

Never log decrypted secrets, raw Stellar secret keys, or PAN/CVV/expiry.

### Database access

Use the async adapter, not raw `better-sqlite3` calls:

```javascript
// Correct
const row = await db.get('SELECT * FROM stellar_wallets WHERE user_id = $1', [userId]);
await db.run('INSERT INTO stellar_audit (...) VALUES (...)', [...]);

// Wrong — works on SQLite but breaks on Postgres
const row = db.prepare('SELECT * FROM stellar_wallets WHERE user_id = ?').get(userId);
```

### Stellar operations

Two-step everything that moves value:

1. The first call writes a `stellar_intents` row and returns a structured prompt.
2. The second call (`confirm: true`) consumes the intent atomically and signs.

Never have a single tool call that goes from LLM-output to broadcast-tx without a confirmation step in between.

Always check caps **before** signing, never after.

Always write an audit row for every operation that produces a signature, including failed broadcasts.

### Tests

```bash
cd backend
npm test                # Vitest, runs the unit and integration suites
npm test -- --watch     # iterate
npm run lint            # ESLint
```

For Stellar tests, prefer hitting `testnet` over mocking Horizon. Friendbot funding is fast.

For Cards402 / x402 tests against the real APIs, gate them behind an env var:

```javascript
test.runIf(process.env.RUN_LIVE_CARDS402)('issues a real card', async () => { ... });
```

## Pull requests

1. Fork, branch off `main` with a descriptive name (`feat/passkey-kit-smart-wallets`, `fix/cap-enforcement-race`).
2. Keep the diff focused. One conceptual change per PR.
3. Update docs in the same PR if behaviour changes.
4. Make sure `npm test` and `npm run lint` pass locally.
5. Open the PR with a description that answers: what changed, why, how was it tested, what could break.

CI runs `lint`, `audit`, `test`, and `gitleaks` on every PR. Green CI is required before merge. We squash-merge by default.

## Security-sensitive changes

Anything that touches the signing path, key handling, cap enforcement, audit writes, or webhook verification gets an extra eye. Tag the PR with `security` and ping the maintainers. We will not merge a PR in those areas without at least one human review, regardless of CI status.

If you find a vulnerability while developing, do **not** open a public issue. See [`SECURITY.md`](./SECURITY.md) for the disclosure process.

## Releases

Tags are cut from `main` using the `release.yml` workflow. Versioning is calendar-based (`YYYY.MM.PATCH`) for the orchestrator; the MCP packages follow semver independently.

## Code of conduct

Be respectful. Argue about ideas. Don't argue about people. The maintainers reserve the right to remove any contribution or contributor that makes the project worse to work on.

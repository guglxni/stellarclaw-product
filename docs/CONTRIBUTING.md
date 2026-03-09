# Contributing to LiveClaw

Guidelines for developing, testing, and deploying changes to the LiveClaw platform.

---

## Development Setup

### Prerequisites

- Node.js 22+
- npm 10+
- macOS (for Keychain secret management) or Linux

### Local Environment

```bash
git clone https://github.com/guglxni/liveclaw.git && cd liveclaw

# Backend
cd backend
cp .env.example .env
# Fill in the CHANGE_ME values — see CREDENTIALS.md for details
npm install
npm run dev    # starts Express on :3000 with --watch

# Frontend (separate terminal — from repo root)
cd liveclaw-web/www
python3 -m http.server 8080
```

### Environment Variables

All backend secrets live in `backend/.env`. Use the Keychain helper for generated secrets:

```bash
bash scripts/keychain-secrets.sh --inject   # writes TOKEN_ENCRYPTION_KEY, ADMIN_SECRET
```

---

## Code Organization

| Directory | Purpose |
|-----------|---------|
| `backend/` | Express API server, Bifrost client, Dodo Payments module |
| `backend/tests/` | Vitest test suites (integration + unit) |
| `liveclaw-web/www/` | Static frontend served by Nginx |
| `liveclaw-web/www/admin/` | Admin dashboard SPA |
| `scripts/` | Deployment, provisioning, and utility scripts |
| `docs/` | Architecture docs, launch plan, security review |
| `.github/workflows/` | CI/CD pipelines |

---

## Testing

### Run Tests

```bash
cd backend

npm test                    # all tests (109 total, ~1s)
npm run test:unit           # Bifrost unit tests only
npm run test:integration    # API + subscription integration tests
npm run lint                # ESLint
```

### Test Structure

- **`tests/setup.js`** — Sets safe env vars (in-memory DB, test keys)
- **`tests/api.test.js`** — 85 integration tests across all Express endpoints
- **`tests/bifrost.test.js`** — 19 unit tests for Bifrost client (100% coverage)
- **`tests/subscription.test.js`** — 5 subscription lifecycle tests

### Writing Tests

- Use Vitest + Supertest for API tests
- Tests run against an in-memory SQLite database
- Rate limiters are bypassed in test mode
- Auth middleware falls through in test mode (non-production)
- Always clean up seeded data or use unique user IDs per test suite

---

## Branching Strategy

```
main          ← production (auto-deploys via CI/CD)
  └── feature/xxx    ← feature branches
  └── fix/xxx        ← bug fix branches
```

1. Create a feature branch from `main`
2. Make changes, add tests
3. Run `npm test && npm run lint` — all must pass
4. Push and open a PR
5. CI pipeline runs: test → lint → audit
6. Merge to `main` triggers auto-deploy

---

## Deployment

### CI/CD Pipeline (`.github/workflows/main.yml`)

| Stage | What it does |
|-------|-------------|
| **Test** | `npm test` — 109 tests via Vitest |
| **Lint** | `npm run lint` + `node -c` syntax validation |
| **Audit** | `npm audit --audit-level=moderate` |
| **Deploy** | SCP to droplet + PM2 reload (main only) |

### Manual Deploy

```bash
# Code-only (most common)
./scripts/deploy-backend.sh --code-only
./scripts/deploy-frontend.sh --code-only

# Full provision (new droplet)
./scripts/deploy-backend.sh
./scripts/deploy-frontend.sh
```

---

## Code Style

- **Linter:** ESLint (flat config: `eslint.config.mjs`)
- **Style:** Single quotes, semicolons, 4-space indentation in JS
- **Comments:** Section headers use `// ─── Title ───` box-drawing characters
- **Error handling:** All Express routes wrapped with `asyncHandler`
- **SQL:** Prepared statements only — never string concatenation
- **Logging:** Console with brackets: `[module] Message`

---

## Security Checklist

Before merging any PR, verify:

- [ ] No hardcoded secrets or API keys
- [ ] All SQL queries use prepared statements with parameters
- [ ] User input is validated (type, length, format)
- [ ] New endpoints have appropriate auth (`authMiddleware` or `adminAuth`)
- [ ] Error responses don't leak internal details in production
- [ ] `npm audit` shows no high/critical vulnerabilities
- [ ] IDOR prevention: authenticated user can only access their own resources

---

*Last updated: March 7, 2026*

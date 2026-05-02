# Security Policy

StellarClaw signs financial transactions on a public blockchain. We take security reports seriously and respond fast.

## Supported versions

| Version | Supported |
|---------|-----------|
| `main`  | ✅ Yes    |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **security@stellarclaw.xyz** (or DM [@guglxni](https://github.com/guglxni)) with:

1. A short description of the vulnerability and where you found it.
2. Reproduction steps or a proof-of-concept.
3. Affected component(s) and version (commit SHA if you have it).
4. Estimated impact and exploitability.

Acknowledgement within **48 hours**. Critical issues patched within **7 days**, high-severity within 30 days. We will credit you in the advisory unless you ask us not to.

## Scope

**In scope**

- The Express orchestrator (`backend/server.js`, `backend/routes/*`).
- All four Stellar MCP servers (`mcp/stellar-mcp.js`, `soroswap-mcp.js`, `cards402-mcp.js`, `x402-mcp.js`).
- Auth flow (Google OAuth verification, session JWT issuance, Cloudflare Turnstile).
- Webhook signature verification (Dodo Payments, Cards402).
- Token encryption at rest (AES-256-GCM, `TOKEN_ENCRYPTION_KEY` derivation).
- Per-bot Stellar wallet provisioning, persistence, and key isolation.
- The intent ledger (`stellar_intents`), audit table (`stellar_audit`), and cap enforcement (`caps.js`).
- Picobot child-process isolation and env-var injection.

**Out of scope**

- Vulnerabilities in third-party dependencies — please report those upstream first; if there is a downstream-only impact in StellarClaw, then send it to us.
- Stellar protocol-level issues — report to [Stellar Development Foundation](https://stellar.org).
- Social-engineering attacks against humans (Telegram phishing, fake spawn pages, etc.).
- DoS via single-account resource exhaustion (we have rate limits; we are not interested in evidence that they exist).
- Self-XSS that requires the victim to paste attacker-controlled JavaScript into a console.

## Security practices in production

| Control | Implementation |
|---|---|
| Stellar key encryption | AES-256-GCM with `TOKEN_ENCRYPTION_KEY` (64-char hex), per-row IV, AAD bound to `userId` |
| Telegram token encryption | Same envelope as above, distinct AAD context |
| Webhook signing | Dodo Payments SDK signature check, Cards402 HMAC-SHA256 with `CARDS402_WEBHOOK_SECRET` |
| Auth | Google ID tokens verified against live JWKS on every request, no caching of public keys past their TTL |
| Rate limiting | Per-IP and per-user windows on `/api/*`, stricter on `/api/auth/*` and `/deploy-bot` |
| Per-tx caps | Oracle-priced USDC cap (`STELLAR_PER_SEND_CAP_USDC`), checked **before** signing |
| Lifetime caps | Cumulative spend cap (`STELLAR_LIFETIME_CAP_USDC`), enforced in `caps.js` |
| Confirm-before-sign | Every value-bearing operation creates a `stellar_intents` row and waits for explicit user confirmation |
| Append-only audit | `stellar_audit` rows are inserted, never updated or deleted in normal operation |
| TLS | Caddy with Let's Encrypt, HSTS, modern cipher suite |
| Env-file perms | `.env` is `chmod 0600`, owned by the deploy user |
| Secret rotation | Keychain-backed CLI (`scripts/keychain-secrets.sh`) supports `--rotate` |
| Dependency scanning | `npm audit` on every CI run, Dependabot weekly PRs |
| Secret scanning | `gitleaks` on every CI run, pre-commit hook locally |
| Logging | Pino structured JSON, never logs decrypted secrets, signed transactions, or PAN/CVV |
| Isolation | Each picobot agent runs as a separate OS process, sees only its own wallet secret |

## Cryptographic primitives

| Use | Algorithm |
|---|---|
| Symmetric encryption (secrets at rest) | AES-256-GCM |
| Key derivation (deploy-time secrets) | scrypt (`N=2^15, r=8, p=1`) |
| HMAC (webhook signatures) | HMAC-SHA256 |
| Asymmetric (Stellar) | Ed25519 (per Stellar protocol) |
| Soroban contract authorization | Stellar account-auth + contract-defined custom auth |
| TLS | TLS 1.3 only on `api.stellarclaw.xyz` |

## Threat model summary

The two adversaries we model most carefully:

1. **A user trying to spend more than their cap.** Caps are checked server-side, after price oracle resolution, before the signing step. The picobot child has no access to the cap-enforcement code and cannot bypass it by emitting a forged tool result.
2. **An attacker who compromises a single user's account.** They get one bot, one wallet, one set of caps. They cannot pivot to another user (per-bot env injection means each picobot only ever holds its own secret) and cannot read the database directly (the orchestrator process owns the DB connection, not the picobot child).

What we do **not** currently defend against:

- A compromised orchestrator host. If `root` on the droplet is taken, every active bot's in-memory secret is exposed. Mitigation on the v2 roadmap: passkey-kit Soroban smart wallets so the orchestrator only ever holds a session signer with a tight policy, not the master signer.
- A compromised Cards402 backend issuing spoofed `ready` events. Mitigation: webhook signature verification is wired (the secret is provisioned), the handler will be enabled when card-issuance volume justifies async confirmation in addition to the SSE stream.

## Bug bounty

We do not run a paid bounty program yet. We will publicly credit and offer Stellar Garage swag for any valid in-scope report.

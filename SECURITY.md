# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| main    | ✅ Yes     |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report to **security@liveclaw.xyz** (or DM [@guglxni](https://github.com/guglxni) on GitHub) with:

1. A short description of the vulnerability
2. Steps to reproduce (proof-of-concept if available)
3. Affected component(s) and version
4. Potential impact

We will acknowledge your report within **48 hours** and aim to ship a patch within **7 days** for critical issues.

## Scope

In scope:
- Backend API (`backend/server.js`, auth, webhook handling)
- Payment / subscription flow
- Token encryption at rest

Out of scope:
- Third-party dependencies (report those upstream)
- Social-engineering attacks
- Denial-of-service via resource exhaustion on a single user account

## Security practices

- All tokens (Telegram, Bifrost VK) are encrypted at rest using AES-256-GCM
- Webhook payloads are verified via Dodo Payments SDK signature check
- Google ID tokens are verified against live JWKS
- Rate limiting is applied on all public endpoints
- Dependencies are scanned with `npm audit` on every CI run and via Dependabot weekly PRs

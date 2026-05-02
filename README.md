<div align="center">

# StellarClaw

**An AI payments agent for the Stellar network.**

Spin up a personal Telegram-native agent that holds its own Stellar wallet, sends and receives stablecoins across borders, swaps assets through Soroswap, issues virtual Visa cards via Cards402, and pays for its own API access through x402.

[Website](https://stellarclaw.xyz) · [Pilot](https://stellarclaw.xyz/pilot) · [Documentation](./docs/) · [Security](./SECURITY.md)

[![Stellar](https://img.shields.io/badge/Stellar-Mainnet-000?logo=stellar&labelColor=000)](https://stellar.org)
[![Soroban](https://img.shields.io/badge/Soroban-WASM-FDDA24?labelColor=000)](https://soroban.stellar.org)
[![Built on Cards402](https://img.shields.io/badge/Cards402-Live-22C55E?labelColor=000)](https://cards402.com)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

---

## Why StellarClaw

Stellar is the strongest payments-and-stablecoin network in the industry — `$500M+` USDC monthly volume, native PYUSD and EURC, Soroban WASM smart contracts, and a real off-ramp footprint through MoneyGram across `170+` countries. Every other agent platform is built for DeFi speculation on Solana or Ethereum. StellarClaw is built for the work people actually do with money: pay someone in another country, hold yield-bearing stablecoins, mint a virtual card, settle a vendor invoice, top up a remittance corridor.

Each user gets a **dedicated agent** — its own Stellar account, its own LLM context, its own spend caps — orchestrated by a Node.js control plane and isolated through the [picobot](https://github.com/louisho5/picobot) runtime. The security model is inspired by [IronClaw](https://github.com/nearai/ironclaw) from NEAR AI: capability-scoped tools, deny-by-default, and human-in-the-loop confirmation for any value-bearing operation.

---

## What it can do today

| Capability | How |
|---|---|
| Send / receive XLM and Stellar-issued assets | Stellar Horizon REST API |
| Swap USDC ⇄ XLM (and other listed pairs) | Soroswap REST API |
| Issue virtual Visa cards paid in USDC or XLM | Cards402 SDK over Soroban |
| Pay agent-to-API micropayments | x402-stellar |
| Open USDC trustlines automatically | Stellar SDK `changeTrust` |
| Read account balances and transaction history | Horizon |
| Confirm-before-sign on every value transfer | Native intent ledger |
| Per-bot spend caps (per-tx and lifetime, oracle-priced) | Server-enforced |
| Audit trail of every signed operation | Append-only `stellar_audit` |

Roadmap items: Blend Capital lending, MoneyGram cash-out via Anchor APIs, tokenized RWA holdings, Soroban smart-wallet (passkey-kit) for non-custodial mode.

---

## Architecture

```
                       ┌──────────────────────────────────────┐
   Users (Telegram)───▶│           Frontend                   │
                       │   stellarclaw.xyz   (static, Nginx)  │
                       └────────────────┬─────────────────────┘
                                        │ HTTPS
                                        ▼
                       ┌──────────────────────────────────────┐
                       │           Backend                    │
                       │   api.stellarclaw.xyz   (Nginx→Node) │
                       │                                      │
                       │   ┌──────────────┐  ┌─────────────┐  │
                       │   │  Express     │  │  Bifrost    │  │
                       │   │  Orchestrator│  │  AI Gateway │  │
                       │   └──────┬───────┘  └──────┬──────┘  │
                       │          │ spawns          │ routes  │
                       │          ▼                 ▼         │
                       │   ┌──────────────┐  ┌─────────────┐  │
                       │   │  picobot ×N  │  │   LLMs via  │  │
                       │   │  (1 per user │  │  OpenRouter │  │
                       │   │   isolated)  │  │  + others   │  │
                       │   └──────┬───────┘  └─────────────┘  │
                       │          │ MCP                       │
                       │          ▼                           │
                       │   ┌──────────────────────────────┐   │
                       │   │    Stellar MCP Servers       │   │
                       │   │  ┌──────┐ ┌────────┐         │   │
                       │   │  │stellar│ │soroswap│        │   │
                       │   │  └──────┘ └────────┘         │   │
                       │   │  ┌────────┐ ┌──────┐         │   │
                       │   │  │cards402│ │ x402 │         │   │
                       │   │  └────────┘ └──────┘         │   │
                       │   └──────────────────────────────┘   │
                       │          │                           │
                       │          ▼                           │
                       │   ┌──────────────┐                   │
                       │   │  Postgres    │                   │
                       │   │  (wallets,   │                   │
                       │   │  intents,    │                   │
                       │   │  audit)      │                   │
                       │   └──────────────┘                   │
                       └──────────────────────────────────────┘
                                  │
                                  ▼
                       ┌──────────────────────────────────────┐
                       │        Stellar Mainnet               │
                       │  Horizon · Soroban RPC · Soroswap    │
                       │  Cards402 receiver · x402 facilitator│
                       └──────────────────────────────────────┘
```

Each user spawns a private picobot child process. That process is the only thing on the system that holds the bot's Stellar secret key (decrypted in-memory, never logged, never written to disk). Every Stellar operation goes through one of four MCP servers, each with its own narrow scope: `stellar` (transfers and balances), `soroswap` (swaps), `cards402` (virtual cards), and `x402` (micropayments). The orchestrator enforces per-bot caps **before** signing, and writes the operation to an append-only audit table **before** broadcasting.

For the full architecture deep-dive see [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Frontend | Static HTML / Tailwind / Nginx | Fast, cacheable, zero JS runtime cost |
| Orchestrator | Node.js 22 · Express 5 | Mature ecosystem, async I/O, fits the agent-fan-out model |
| Agent runtime | [picobot](https://github.com/louisho5/picobot) (Go) | Sub-100MB per-agent footprint, one OS process per user |
| AI Gateway | [Bifrost](https://github.com/maximhq/bifrost) | `<100µs` overhead, virtual-key budgeting per agent |
| LLMs | MiniMax M2.7 default · OpenRouter for the long tail | Cost-optimised for emerging-market user base |
| Stellar SDK | `@stellar/stellar-sdk` v15 | Horizon + Soroban support |
| Card issuance | [`cards402`](https://www.npmjs.com/package/cards402) | Visa cards via Soroban payment receiver |
| Micropayments | [`x402-stellar`](https://www.npmjs.com/package/x402-stellar) | HTTP 402 monetisation for agent tools |
| Database | Postgres (managed) | ACID for the intent ledger and audit table |
| Auth | Google OAuth 2.0 + Cloudflare Turnstile | Frictionless onboarding, bot-resistant |
| Hosting | DigitalOcean droplets | Simple, predictable cost, USDC-payable in beta |
| CI/CD | GitHub Actions | Test → lint → audit → deploy |
| TLS | Let's Encrypt via Caddy | Automatic renewals |

---

## Stellar contracts and addresses we depend on

StellarClaw does not deploy its own Soroban contracts yet — the value comes from composing the existing payments stack. Mainnet addresses we read from or pay to:

| Contract / Account | Purpose | Address |
|---|---|---|
| Circle USDC issuer | Stablecoin trustline target | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |
| x402-stellar facilitator | Agent micropayment settlement | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| x402-stellar registry | Resource discovery | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |
| Cards402 payment receiver | Card-issuance settlement | Resolved per-order via Cards402 API (not a fixed address) |
| Soroswap router | Swap execution | Resolved via Soroswap REST API |

A custom Soroban program for **policy-bound spend signers** (so a user can grant a bot a $100/day allowance without giving up the key) is on the roadmap and will be the first contract we ship under our own deployer key.

---

## Quick start (local dev)

```bash
git clone https://github.com/guglxni/stellarclaw-product.git
cd stellarclaw-product

# Backend
cd backend
cp .env.example .env          # fill in CHANGE_ME values
npm install
npm run dev                   # starts on :4001 with --watch

# Frontend (separate terminal)
cd ../web
python3 -m http.server 8080
```

You'll need accounts at: Google Cloud Console (OAuth), Cloudflare (Turnstile), MiniMax or OpenRouter (LLM), and Cards402 (one-time `npx cards402 onboard`).

For the complete environment-variable map and key-provisioning workflow see [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

---

## Production deployment

```bash
# 1. provision a DigitalOcean droplet (or any 2vCPU/2GB Linux box)
doctl compute droplet create stellarclaw-prod \
  --image ubuntu-24-04-x64 --size s-2vcpu-2gb --region blr1 --ssh-keys $SSH_KEY_ID

# 2. point api.stellarclaw.xyz at the droplet
doctl compute domain records create stellarclaw.xyz \
  --record-type A --record-name api --record-data $DROPLET_IP

# 3. run the bootstrap script (installs Node 22, Caddy, UFW, Docker, pm2)
ssh root@$DROPLET_IP 'curl -fsSL https://raw.githubusercontent.com/guglxni/stellarclaw-product/main/scripts/bootstrap.sh | bash'

# 4. deploy
./scripts/deploy.sh
```

End-to-end runbook: [`docs/DEPLOYMENT.md`](./docs/DEPLOYMENT.md).

---

## Security

StellarClaw signs financial transactions, so security is treated as a first-class concern, not an afterthought.

- **Encrypted at rest** — every Stellar secret key, every Telegram bot token, every OAuth refresh token is sealed with AES-256-GCM (`TOKEN_ENCRYPTION_KEY`) before it touches disk.
- **Capability-scoped tools** — the orchestrator only injects a bot's secret into the picobot child process that owns it. No bot can read another bot's keys.
- **Confirm-before-sign** — every value-bearing operation creates a row in the `stellar_intents` ledger and waits for explicit user confirmation before the orchestrator signs and broadcasts.
- **Server-enforced caps** — per-transaction (`STELLAR_PER_SEND_CAP_USDC`) and lifetime (`STELLAR_LIFETIME_CAP_USDC`) limits are checked against an oracle-priced USDC value before any signature is produced.
- **Append-only audit** — the `stellar_audit` table records every operation the orchestrator authorises; rows are never updated or deleted in-band.
- **No shell, no eval** — picobot tools are typed JSON-RPC over MCP. The agent cannot execute arbitrary code on the host.
- **Secrets management** — `.env` files are `chmod 0600`, never committed, and rotated via a Keychain-backed CLI.

Disclosure policy and threat model: [`SECURITY.md`](./SECURITY.md).

---

## Observability

- Structured JSON logs via Pino, scoped per subsystem (`startup`, `watchdog`, `mcp`, `stellar`, `cards402`).
- Bifrost gateway exports OpenTelemetry traces for every LLM call.
- `pm2` keeps the orchestrator alive and surfaces process memory / restart count.
- Health check at `GET /healthz` returns the orchestrator state, attached MCPs per bot, and database round-trip latency.

---

## Status

| Component | Status |
|---|---|
| Stellar transfers (Horizon) | ✅ mainnet |
| Soroswap swaps | ✅ mainnet |
| Cards402 virtual Visa | ✅ mainnet (one card issued per user during pilot) |
| x402 micropayments | ✅ mainnet |
| Per-bot wallet provisioning | ✅ persistent, deterministic per `userId` |
| Telegram channel | ✅ live |
| Discord channel | 🛠 planned |
| WhatsApp channel | 🛠 planned |
| Soroban policy-signer contract | 🛠 v2 |
| MoneyGram off-ramp | 🛠 awaiting Anchor onboarding |
| Blend Capital yield | 🛠 v2 |

---

## License

MIT — see [`LICENSE`](./LICENSE).

---

## Acknowledgements

- [Stellar Development Foundation](https://stellar.org) — for shipping Soroban, the Garage cohort, and the brand system this product visually inherits.
- [NEAR AI's IronClaw](https://github.com/nearai/ironclaw) — for the WASM-sandbox-and-policy-signer pattern that informs our security model.
- [picobot](https://github.com/louisho5/picobot) — for a per-user agent runtime that respects RAM.
- [Bifrost](https://github.com/maximhq/bifrost) — for the AI gateway that makes per-agent budgets practical.
- [Cards402](https://cards402.com) — for the only USDC-native card-issuance API that actually works.

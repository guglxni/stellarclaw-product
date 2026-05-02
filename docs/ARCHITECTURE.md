# Architecture

## Design goals

1. **One agent per user, with its own keys.** No shared wallets, no pooled signers. A user's bot signs from a Stellar account that nothing else on the system can touch.
2. **Confirm before sign.** Every value-bearing operation produces a structured intent that the user has to acknowledge before any signature is generated. The orchestrator never signs autonomously based on an LLM's free-form output.
3. **Caps as a backstop.** Even if the agent is talked into something it shouldn't do, the orchestrator's cap-enforcement layer rejects the operation before signing.
4. **Observability over cleverness.** Structured logs, an append-only audit table, and a deterministic intent ledger. We can answer "what did the bot do at 09:42 last Thursday?" with a single query.
5. **Composable, not monolithic.** Stellar capabilities are exposed as four narrowly-scoped MCP servers. Adding Blend or MoneyGram later is a matter of dropping in another MCP, not rewriting the orchestrator.

## Process model

```
            (kernel)
               │
        ┌──────┴──────┐
        │   pm2       │  process manager
        └──────┬──────┘
               │
        ┌──────┴──────┐
        │  Express    │  the orchestrator: HTTP, auth, intent ledger,
        │ (one PID)   │  cap enforcement, picobot supervision
        └──────┬──────┘
               │  spawn(command, env={STELLAR_BOT_SECRET, …})
               │
        ┌──────┴──────┬──────────┬──────────┐
        │ picobot #1  │ picobot 2│ picobot N│  one OS process per user
        │ user A      │ user B   │ user N   │
        └─────────────┴──────────┴──────────┘
               │
               │  MCP (JSON-RPC over stdio)
               │
        ┌──────┴──────┬──────────┬──────────┐
        │ stellar-mcp │ soroswap │ cards402 │  4 narrowly-scoped MCPs,
        │             │  -mcp    │  -mcp    │  spawned as MCP child procs
        └─────────────┴──────────┴──────────┘
                                            x402-mcp (4th)
```

The orchestrator never holds a bot's Stellar secret in a long-lived variable. On spawn it:

1. Reads the encrypted row from `stellar_wallets` (key derived from `TOKEN_ENCRYPTION_KEY`).
2. Decrypts in a local-scope buffer.
3. Passes the secret as `STELLAR_BOT_SECRET` in the picobot child's env.
4. Drops its own reference.

The picobot child holds the secret in its own process memory. When the child dies, the secret dies with it. There is no shared memory between picobot children, no IPC channel, no file the secret is written to.

## The Stellar MCP servers

All four MCPs live in `mvp/mcp/` and are spawned by the orchestrator with a per-bot env (`STELLAR_BOT_PUBLIC`, `STELLAR_BOT_SECRET`, `STELLAR_NETWORK`, plus MCP-specific config). They speak MCP JSON-RPC over stdio to the picobot.

### `stellar-mcp` (`mvp/mcp/stellar-mcp.js`)

| Tool | Purpose |
|---|---|
| `stellar_address` | Return the bot's own G-address. |
| `stellar_balance` | Return XLM, USDC, and any other trustline balances from Horizon. |
| `stellar_send` | Two-step: `quote` writes an intent row; `confirm=true` signs and submits via Horizon. Caps enforced before signing. |
| `stellar_history` | Last N operations from Horizon. |
| `stellar_trustline` | Open or close a trustline (e.g. USDC). |
| `stellar_explorer_url` | Return a Stellar Expert URL for a tx hash or account. |

### `soroswap-mcp` (`mvp/mcp/soroswap-mcp.js`)

| Tool | Purpose |
|---|---|
| `soroswap_quote` | Hit Soroswap REST `/quote` for the best route between two assets, return an intent. |
| `soroswap_swap` | On `confirm=true`, sign and submit the route from the bot's wallet. Caps enforced. |
| `soroswap_pools` | List supported asset pairs. |

### `cards402-mcp` (`mvp/mcp/cards402-mcp.js`)

| Tool | Purpose |
|---|---|
| `cards402_setup` | Return the bot's wallet, balances, USDC trustline status, funding instructions. Mainnet-only. |
| `cards402_quote` | Wrap `Cards402Client.createOrder({amount_usdc, metadata})`. |
| `cards402_purchase` | On `confirm=true`: enforce caps, auto-add USDC trustline if missing, call `payViaContract` from the bot's secret, then `waitForCard` (SSE) for the PAN/CVV/expiry. |
| `cards402_status` | Wrap `getOrder(order_id)`. |
| `cards402_usage` | Wrap `getUsage()` for budget diagnostics. |

### `x402-mcp` (`mvp/mcp/x402-mcp.js`)

| Tool | Purpose |
|---|---|
| `x402_resource_info` | Look up the price and asset of an x402-protected URL. |
| `x402_pay_and_fetch` | Pay the resource through the x402 facilitator and return the response. Strict allowlist via `X402_ALLOWLIST`. |
| `x402_pricing` | Return our own x402 pricing for downstream agents that want to call us. |

## Data model

```
users (id PK, google_sub UNIQUE, email, plan, created_at)

bots  (user_id PK FK → users, status, model, telegram_bot_token_enc,
       virtual_key_id, pid, created_at, updated_at)

stellar_wallets   (user_id PK FK → users, public_key UNIQUE,
                   secret_enc, network, created_at BIGINT, updated_at BIGINT)

stellar_intents   (id PK, user_id FK → users, kind, payload_json,
                   created_at BIGINT, expires_at BIGINT, consumed_at BIGINT NULL)

stellar_audit     (id PK, user_id FK → users, op, status, tx_hash,
                   amount_usdc, payload_json, created_at BIGINT)
```

`stellar_wallets` is the source of truth for "what wallet does user X own?". The row is created at first spawn and never re-created — every subsequent spawn reads the same row, so wallets are deterministic per `userId`.

`stellar_intents` is the confirm-before-sign ledger. A `quote` tool writes a row with `consumed_at NULL`; a `confirm=true` call atomically marks the row consumed and proceeds to sign. Stale intents expire after 5 minutes.

`stellar_audit` captures the post-broadcast result of every signed operation, with the on-chain tx hash so any operation can be cross-referenced against Stellar Expert.

All timestamps are `BIGINT` because `Date.now()` is a 13-digit millisecond value and Postgres `INTEGER` is 32-bit (max `~2.1 × 10^9`). Using `INTEGER` here silently overflows.

## Key flows

### Bot spawn

```
POST /deploy-bot
   │
   ▼
Express orchestrator
   │ 1. verify Google ID token
   │ 2. SELECT * FROM stellar_wallets WHERE user_id = ?
   │      ─ if hit: decrypt secret_enc into a local buffer
   │      ─ if miss: generate Keypair.random(), INSERT (with race recovery)
   │ 3. spawn picobot with env { STELLAR_BOT_SECRET, STELLAR_BOT_PUBLIC,
   │                              STELLAR_NETWORK, MCP server paths, … }
   │ 4. drop the local secret reference
   ▼
respond { stellarAddress, stellarNetwork, botUsername }
```

### Send USDC to another address

```
user (Telegram): "send 5 USDC to GAW…123, memo for rent"
   │
   ▼
picobot → stellar-mcp.stellar_send({ to: "GAW…123", amount: "5", asset: "USDC",
                                      memo: "for rent" })
   │
   ▼
stellar-mcp creates a stellar_intents row, returns a structured prompt:
   "Send 5 USDC (~$5.00) to GAW…123 with memo 'for rent'? Reply YES to confirm."
   │
   ▼
user: "yes"
   │
   ▼
picobot → stellar-mcp.stellar_send({ confirm: true, intent_id: "…" })
   │
   ▼
stellar-mcp:
   ┌─ caps.js: is 5 USDC ≤ STELLAR_PER_SEND_CAP_USDC?
   │             is cumulative ≤ STELLAR_LIFETIME_CAP_USDC?
   │             (USDC value of XLM amounts is oracle-priced)
   │     ─ no → reject, write audit row, return error
   │     ─ yes ↓
   ├─ build tx, sign with Keypair.fromSecret(STELLAR_BOT_SECRET)
   ├─ submit to Horizon
   ├─ INSERT INTO stellar_audit (op='send', tx_hash, …)
   └─ return { tx_hash, explorer_url }
```

### Issue a virtual Visa card

```
user: "buy me a $20 Amazon card"
   │
   ▼
picobot → cards402-mcp.cards402_quote({ amount_usdc: "20.00",
                                         metadata: { stellarclaw_user: "…" } })
   │
   ▼
cards402-mcp → Cards402Client.createOrder(…)
            ← { order_id, payment_instructions: { contract_id, amount, asset } }
   ▼
returns prompt: "Buy a $20 virtual Visa? You will pay 20.00 USDC.
                 Reply YES to confirm."
   │
   ▼
user: "yes"
   │
   ▼
picobot → cards402-mcp.cards402_purchase({ order_id, confirm: true })
   │
   ▼
cards402-mcp:
   ┌─ caps.js: ≤ CARDS402_PER_PURCHASE_CAP_USD?
   │             count of cards in stellar_audit ≤ CARDS402_LIFETIME_PURCHASES?
   ├─ if asset='USDC' and trustline missing: stellar-mcp.stellar_trustline(USDC)
   ├─ Cards402.payViaContract({ order_id, secret: STELLAR_BOT_SECRET })
   │     → signs Soroban invoke, broadcasts, returns tx_hash
   ├─ Cards402Client.waitForCard(order_id)   // SSE stream
   │     → resolves when phase='ready'
   ├─ INSERT INTO stellar_audit (op='card_purchase', tx_hash, amount_usdc, …)
   └─ return { number, cvv, expiry, brand, order_id }
```

The agent surfaces PAN/CVV/expiry to the user **once**, in the Telegram message that completes the request. They are not logged, not echoed back, not retained on the orchestrator.

## Failure modes and how we degrade

| Failure | Behaviour |
|---|---|
| Horizon temporarily unreachable | `stellar_send` returns "network busy, retry in a moment", no signature produced, no audit row, no charge |
| Cards402 backend down | `cards402_quote` fails fast; if it fails after `payViaContract` succeeded but before `waitForCard` resolves, `cards402_status` can recover the card later (the Soroban payment is on-chain regardless) |
| Soroswap route insufficient | `soroswap_quote` returns "no liquidity for this pair right now", suggests an alternative route |
| LLM context window exhausted | Picobot truncates oldest non-system messages; the bot's identity, caps, and current intent are pinned and never truncated |
| Bifrost gateway down | The orchestrator's watchdog flags it; picobots that try to call LLMs see a 5xx and surface "service temporarily unavailable" |
| `STELLAR_BOT_SECRET` env missing | Picobot refuses to start; orchestrator treats the bot as in error state |
| Cap exceeded | Operation rejected before signing, audit row written with `status='cap_rejected'`, user told why |
| Intent expired | Confirm call returns "this intent has expired, re-quote to continue" |

## Why we use Postgres, not SQLite

Pre-launch we used SQLite for speed. As soon as bots started persisting state across restarts (wallets, intents, audit), the WAL contention on a single-writer engine became the bottleneck. Postgres gives us:

- True row-level locking for the `stellar_wallets` insert race (two concurrent spawns for the same user generating two keypairs, only one wins).
- `BIGINT` timestamps without overflow.
- Managed snapshot backups via the cloud provider, so a bad migration doesn't take wallet keys with it.
- Independent connection pool tuning (the orchestrator and the optional sync workers each get their own).

## See also

- [`SECURITY.md`](../SECURITY.md) — threat model, disclosure policy, cryptographic primitives.
- [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) — environment-variable map and end-to-end deploy runbook.
- [`docs/STELLAR_INTEGRATION.md`](./STELLAR_INTEGRATION.md) — MCP-by-MCP detail with sample tool calls.

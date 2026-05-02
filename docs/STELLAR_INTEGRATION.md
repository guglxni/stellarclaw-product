# Stellar Integration

StellarClaw exposes Stellar to the agent through four narrowly-scoped MCP servers. This document is the canonical reference for what each tool does, the intent-based flow, and how to call the SDK directly if you want to bypass the agent.

## Per-bot wallet

Every spawned bot has a unique Stellar account, persistent across restarts and deterministic per `userId`.

```
bot.publicKey   = G…  (56 chars, derived from a fresh Ed25519 keypair)
bot.network     = mainnet  (default; see STELLARCLAW_DEFAULT_NETWORK)
bot.secret      = encrypted at rest in stellar_wallets.secret_enc
                  decrypted only into the picobot child's process memory
```

To find a bot's address from outside the agent:

```bash
psql $DATABASE_URL -c "SELECT public_key, network FROM stellar_wallets WHERE user_id = '...'"
```

## 1. `stellar-mcp` — Horizon and native ops

Direct interaction with the Stellar mainnet via the Horizon REST API. No Soroban contracts involved.

### Tools

```jsonc
// Return the bot's address
{ "name": "stellar_address" }
→ { "address": "GDTPF…", "network": "mainnet" }

// Get current balances (XLM + every trustline)
{ "name": "stellar_balance" }
→ {
    "xlm": "5.0123400",
    "usdc": "12.5000000",
    "lines": [{ "asset_code": "USDC", "issuer": "GA5Z…", "balance": "12.50…" }]
  }

// Two-step send. First call returns a confirmation prompt + intent_id.
{
  "name": "stellar_send",
  "arguments": {
    "to": "GAW…",
    "amount": "5",
    "asset": "USDC",
    "memo": "for rent"
  }
}
→ {
    "intent_id": "01H…",
    "prompt": "Send 5 USDC (~$5.00) to GAW…? Reply YES to confirm.",
    "expires_in_sec": 300
  }

// Confirm and sign
{
  "name": "stellar_send",
  "arguments": { "confirm": true, "intent_id": "01H…" }
}
→ { "tx_hash": "abc…", "explorer_url": "https://stellar.expert/explorer/public/tx/abc…" }
```

### Caps

| Variable | Meaning | Default |
|---|---|---|
| `STELLAR_PER_SEND_CAP_USDC` | Maximum USDC value of a single send | `25` |
| `STELLAR_LIFETIME_CAP_USDC` | Cumulative USDC value across all sends | `100` |

XLM amounts are oracle-priced (CoinGecko fallback to Reflector) into USDC before cap evaluation.

## 2. `soroswap-mcp` — DEX routing

Wraps the Soroswap REST API for asset swaps. The bot doesn't write Soroban code; it calls Soroswap's hosted router which already does the routing math.

### Tools

```jsonc
{
  "name": "soroswap_quote",
  "arguments": { "from": "USDC", "to": "XLM", "amount": "10" }
}
→ {
    "intent_id": "01H…",
    "from": { "asset": "USDC", "amount": "10" },
    "to":   { "asset": "XLM",  "amount": "85.34", "min_received": "84.49" },
    "route": [...],
    "prompt": "Swap 10 USDC → ~85.34 XLM? Reply YES to confirm.",
    "expires_in_sec": 60
  }

{
  "name": "soroswap_swap",
  "arguments": { "confirm": true, "intent_id": "01H…" }
}
→ { "tx_hash": "...", "actual_received": "85.41 XLM" }
```

### Notes

- Quote validity is short (60s) because pool prices move.
- Slippage is set to `0.5%` by default (configurable per-call).
- Cap rejection happens against the **input** USDC value, not the output.

## 3. `cards402-mcp` — Virtual Visa cards

Issues prepaid Visa cards funded from the bot's own wallet. Mainnet only.

### Setup tool (call this first)

```jsonc
{ "name": "cards402_setup" }
→ {
    "wallet_address": "GDTPF…",
    "network": "mainnet",
    "balances": { "xlm": "0", "usdc": "0" },
    "trustlines": { "usdc": false },
    "funding_instructions": "Send ≥2 XLM to GDTPF…, then call cards402_setup again to verify, then send USDC.",
    "caps": { "per_purchase_usd": 10, "lifetime_remaining": 1 }
  }
```

### Purchase flow

```jsonc
{
  "name": "cards402_quote",
  "arguments": { "amount_usdc": "20.00" }
}
→ {
    "order_id": "3f8e2b91…",
    "payment_instructions": { "contract_id": "...", "asset": "USDC", "amount": "20.00" },
    "prompt": "Buy a $20 virtual Visa? You will pay 20.00 USDC. Reply YES to confirm.",
    "expires_in_sec": 300
  }

{
  "name": "cards402_purchase",
  "arguments": { "order_id": "3f8e2b91…", "confirm": true }
}
→ {
    "number": "4111 2345 6789 0123",
    "cvv": "847",
    "expiry": "12/29",
    "brand": "Visa",
    "tx_hash": "..."
  }
```

The purchase tool:

1. Re-verifies the order is still pending and the cap isn't exceeded.
2. Auto-opens a USDC trustline if the user paid in USDC and there isn't one yet.
3. Calls `Cards402.payViaContract({ order_id, secret: STELLAR_BOT_SECRET })`, which signs and broadcasts the Soroban invocation.
4. Subscribes to the SSE stream `/v1/orders/:order_id/stream` and resolves when `phase='ready'`.

### Caps

| Variable | Meaning |
|---|---|
| `CARDS402_PER_PURCHASE_CAP_USD` | Maximum face value of a single card |
| `CARDS402_LIFETIME_PURCHASES` | Maximum number of cards a single bot can ever issue |

These are deliberately low during the pilot. Bump them in `/opt/stellarclaw/backend/.env` and `pm2 restart stellarclaw --update-env` to adjust.

## 4. `x402-mcp` — Agent micropayments

Lets a bot pay a small Stellar amount to access an HTTP-402 monetised resource. Strictly allowlisted to prevent the agent from being talked into paying random URLs.

### Tools

```jsonc
{
  "name": "x402_resource_info",
  "arguments": { "url": "https://api.example.com/premium-data" }
}
→ {
    "url": "...",
    "price": { "asset": "USDC", "amount": "0.10" },
    "in_allowlist": true
  }

{
  "name": "x402_pay_and_fetch",
  "arguments": { "url": "https://api.example.com/premium-data" }
}
→ {
    "status": 200,
    "body": { ... },
    "tx_hash": "...",
    "paid": "0.10 USDC"
  }
```

### Allowlist

`X402_ALLOWLIST` is a comma-separated list of URL prefixes the bot is allowed to pay. Default in production is restrictive — add new prefixes deliberately:

```
X402_ALLOWLIST=https://x402.stellar.org/,https://api.cards402.com/
```

## Calling the SDK directly

You don't have to go through an agent. Every flow above is just an SDK call away:

```javascript
import { Horizon, Keypair, Networks, Asset, TransactionBuilder, Operation } from '@stellar/stellar-sdk';

const server  = new Horizon.Server('https://horizon.stellar.org');
const source  = Keypair.fromSecret(process.env.STELLAR_BOT_SECRET);
const account = await server.loadAccount(source.publicKey());

const tx = new TransactionBuilder(account, {
  fee: '100',
  networkPassphrase: Networks.PUBLIC,
})
  .addOperation(Operation.payment({
    destination: 'GAW…',
    asset: new Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'),
    amount: '5',
  }))
  .setTimeout(60)
  .build();

tx.sign(source);
const result = await server.submitTransaction(tx);
console.log(result.hash);
```

## Mainnet addresses we read from or write to

| Purpose | Address |
|---|---|
| Circle USDC issuer | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |
| x402-stellar facilitator | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| x402-stellar registry | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |
| Cards402 receiver | per-order via Cards402 API |
| Soroswap router | per-route via Soroswap API |

We have not deployed any contracts of our own yet. The first one will be a Soroban policy-signer for non-custodial-mode wallets (passkey-kit pattern), tracked in [GitHub Issues](https://github.com/guglxni/stellarclaw-product/issues).

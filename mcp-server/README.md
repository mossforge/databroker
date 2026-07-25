# databroker-mcp-server

Give any MCP-capable agent (Claude Desktop, Claude Code, Cursor, ...) pay-per-call access to [MossForge DataBroker](https://mossforge.dev) — UK vehicle MOT intelligence, UK-wide reliability analytics, and Companies House / GLEIF entity data — with x402 USDC micropayments on Base mainnet handled automatically. No API keys, no subscription: fund a wallet, ask questions.

## Tools

| Tool                      | Cost                           | Purpose                                                                            |
| ------------------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| `databroker_discover`     | free                           | List enabled datasets, their `kind`, and per-call USDC prices                      |
| `databroker_fetch`        | free to quote, paid to confirm | Fetch a single datapoint for a dataset + key                                       |
| `databroker_meta`         | free                           | Staleness/TTL/source info for a datapoint, without paying for it                   |
| `databroker_health`       | free                           | API uptime check                                                                   |
| `databroker_batch_create` | free to quote, paid to confirm | Fetch up to 100 keys from one on-demand dataset in a single job, one payment total |
| `databroker_batch_status` | free                           | Poll a batch job created by `databroker_batch_create`                              |

**Payments are never automatic.** `databroker_fetch` and `databroker_batch_create` always quote the price first — nothing is paid until the tool is called again with `confirm: true`. Every paid call is also capped by `DATABROKER_MAX_USDC` (default 0.50); a call priced above the cap is declined before anything is paid.

## Setup

1. Create a fresh EOA wallet and fund it with a few USDC on **Base mainnet** (plus nothing else — no ETH needed; EIP-3009 transfers are gasless for the payer).
2. Install:

```bash
npm install && npm run build
```

3. Add to Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "databroker": {
      "command": "node",
      "args": ["/absolute/path/to/databroker-mcp-server/dist/index.js"],
      "env": {
        "DATABROKER_BASE_URL": "https://api.mossforge.dev",
        "DATABROKER_WALLET_KEY": "0x...",
        "DATABROKER_MAX_USDC": "0.50"
      }
    }
  }
}
```

4. Ask: _"Should I buy this 2018 Golf, reg AB18 CDE? Check its MOT history and whether the mileage looks genuine."_

## Who holds the wallet

Two signer providers are supported, set via `DATABROKER_SIGNER`:

- **`raw`** (default) — a private key you hold, read from `DATABROKER_WALLET_KEY`. Zero setup beyond a funded wallet, but the key material is only as safe as this process's environment, and the spend cap is enforced by this codebase alone.
- **`cdp`** — pays from a Coinbase CDP-managed wallet. No private key ever touches this process; CDP signs remotely and can enforce spend policies (session caps, allowed tokens) at the custodian layer. Requires a CDP account and `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` / `CDP_WALLET_SECRET`, plus `npm install @coinbase/cdp-sdk` (it's an optional dependency, not installed by default).

## Security notes

- Use a dedicated, low-balance wallet. In `raw` mode the key never leaves your machine; payments are signed locally via the `@x402/*` v2 protocol stack (`@x402/fetch` + `@x402/core/client` + `@x402/evm/exact/client`), producing EIP-3009 `transferWithAuthorization` payloads.
- The per-call cap (`DATABROKER_MAX_USDC`) is the blast radius for any single call and is checked before any payment is sent — a call priced above it is declined, not charged. Total exposure is otherwise the wallet balance — keep it small.
- Every paid call goes through a quote first: `databroker_fetch` and `databroker_batch_create` never spend money unless called again with `confirm: true`, so payment is never left to the calling model's judgement alone.

## Env vars

| Var                     | Required             | Default | Notes                                                              |
| ----------------------- | -------------------- | ------- | ------------------------------------------------------------------ |
| `DATABROKER_BASE_URL`   | yes                  | —       | e.g. `https://api.mossforge.dev`                                   |
| `DATABROKER_SIGNER`     | no                   | `raw`   | `raw` or `cdp` — see [Who holds the wallet](#who-holds-the-wallet) |
| `DATABROKER_WALLET_KEY` | yes, if `SIGNER=raw` | —       | 0x-prefixed private key                                            |
| `CDP_API_KEY_ID`        | yes, if `SIGNER=cdp` | —       | Coinbase CDP API key id                                            |
| `CDP_API_KEY_SECRET`    | yes, if `SIGNER=cdp` | —       | Coinbase CDP API key secret                                        |
| `CDP_WALLET_SECRET`     | yes, if `SIGNER=cdp` | —       | Coinbase CDP wallet secret                                         |
| `DATABROKER_MAX_USDC`   | no                   | `0.50`  | Per-call spend cap, enforced regardless of signer                  |

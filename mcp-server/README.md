# databroker-mcp-server

Give any MCP-capable agent (Claude Desktop, Claude Code, Cursor, ...) pay-per-call access to [MossForge DataBroker](https://mossforge.dev) — UK vehicle MOT intelligence, UK-wide reliability analytics, and Companies House / GLEIF entity data — with x402 USDC micropayments on Base mainnet handled automatically. No API keys, no subscription: fund a wallet, ask questions.

## Tools

| Tool | Cost | Purpose |
|---|---|---|
| `databroker_catalogue` | free | List endpoints and per-call prices |
| `databroker_vehicle_report` | paid | Per-VRM MOT history, clocking detection, cohort comparison |
| `databroker_uk_analysis` | paid | UK-wide MOT analytics by make/model/year |
| `databroker_call` | paid | Any other DataBroker endpoint (entity spine, utility compute) |

Every paid call is capped by `DATABROKER_MAX_USDC` (default 0.50). A call priced above the cap fails safely without paying.

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

4. Ask: *"Should I buy this 2018 Golf, reg AB18 CDE? Check its MOT history and whether the mileage looks genuine."*

## Security notes

- Use a dedicated, low-balance wallet. The key never leaves your machine; it signs EIP-3009 `transferWithAuthorization` payloads locally via `x402-fetch`.
- The per-call cap is the blast radius for any single call. Total exposure is the wallet balance — keep it small.

## Env vars

| Var | Required | Default | Notes |
|---|---|---|---|
| `DATABROKER_BASE_URL` | yes | — | e.g. `https://api.mossforge.dev` |
| `DATABROKER_WALLET_KEY` | yes | — | 0x-prefixed private key |
| `DATABROKER_MAX_USDC` | no | `0.50` | Per-call spend cap |

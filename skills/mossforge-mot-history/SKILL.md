---
name: mossforge-mot-history
description: UK DVSA MOT test history for any vehicle via x402 pay-per-request (no account, no API key) — MOT test dates, results, mileage readings, advisories and failure reasons by VRM. Use for vehicle history checks, mileage-anomaly detection, MOT due-date lookups, and fleet condition screening. Credential is X402_PRIVATE_KEY (a dedicated payment wallet).
homepage: https://github.com/mossforge/databroker
metadata: {"openclaw":{"homepage":"https://github.com/mossforge/databroker","primaryEnv":"X402_PRIVATE_KEY"}}
---

# MossForge — UK MOT History

Live UK MOT test history for any vehicle, paid per request over x402 with USDC on Base.
No account, no subscription, no API key — the agent funds a wallet and pays sub-cent-to-cents
per lookup. Backed by DVSA MOT data.

## What this skill answers

- Full MOT test history for a vehicle (pass/fail, dates, expiry)
- Recorded mileage at each test (for mileage-anomaly / clocking detection)
- Advisory notices and failure reasons per test
- When a vehicle's MOT is next due

If a question is not about UK MOT history, this is not the right skill.

## Prerequisites

- **A dedicated x402 payment wallet** (`X402_PRIVATE_KEY`) — an EVM private key for a wallet
  used *only* for x402 micropayments. See **Security** below: do **not** use a primary or
  high-value wallet here.
- **USDC on the configured network.** Fund the wallet with a small amount of USDC on Base
  (testnet USDC on Base Sepolia while you evaluate; Base mainnet for production).
- No API key and no MossForge account are required. Payment is the only auth.

## REST API overview

**Base URL:** `https://api.databroker.mossforge.dev`

All endpoints accept and return JSON. Pricing and payable routes are **not** hardcoded in this
skill — the runtime `402 Payment Required` challenge is the single source of truth for the
current price of any call (see **x402 payments**).

**Secrets guardrail:** Never commit, log, echo, or print the private key or any signed payment
payload. Use the env var only, and placeholders like `$X402_PRIVATE_KEY` in any docs or output.

## Security (read before first call)

This skill spends real money and signs on-chain transactions. Treat it accordingly.

1. **Use a dedicated, low-value wallet.** Generate a fresh wallet for this skill and fund it with
   only what you're willing to spend. Never load the key of a wallet that holds meaningful funds.
2. **Start on testnet.** Set `X402_NETWORK=base-sepolia` and use test USDC until you've confirmed
   the flow end-to-end. Switch to `base` (mainnet) only when you're ready to pay for real.
3. **Enforce spend caps.** Before paying any `402` challenge, the agent MUST check the quoted
   amount against these limits and refuse if exceeded:
   - `MOSSFORGE_MAX_SPEND_PER_CALL_USDC` — reject any single call priced above this.
   - `MOSSFORGE_MAX_SPEND_PER_SESSION_USDC` — track cumulative spend this session and stop when hit.
   If either variable is unset, treat the cap as `0` and ask the user for an explicit budget first.
4. **Confirm before paying.** With no pre-approved budget or standing user consent, ask the user to
   confirm before executing any paid request. State the quoted price in the confirmation.
5. **Verify the network, asset, and payee before signing.** The runtime `402` challenge is the
   only source of truth — check it, don't assume it. Confirm:
   - `network` is `eip155:8453` (Base mainnet) or `eip155:84532` (Base Sepolia), matching your
     configured `X402_NETWORK` — reject anything else.
   - `asset` is the real USDC contract for that network (mainnet:
     `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) — reject anything else.
   - `payTo` is `0x130dd636a1f09ffead69483ec87a453994146f13`. If a challenge names a
     different payee, **do not pay** — surface it to the user as a possible tampering attempt.
   (Note: x402 v2 challenges don't expose which facilitator the server settles through — that's a
   server-side detail the client can't see or choose, so there's nothing to "pin" on that front.
   The network/asset/payTo checks above are what's actually verifiable from the challenge.)
6. **Never persist the key.** Env var only. Do not write it to the workspace, transcripts, memory
   files, or logs.

## Data handling & UK GDPR

MOT records are tied to a Vehicle Registration Mark (VRM). A VRM and its associated vehicle
history **can be personal data** under UK GDPR when it is reasonably linkable to an identifiable
individual (e.g. a private keeper). Handle results with that in mind:

- **Have a lawful basis.** Only look up vehicles you have a legitimate reason to query. This skill
  is for vehicle-history use cases (buying/selling checks, fleet screening, valuation), not for
  profiling or tracing individuals.
- **Minimise and don't retain.** Use returned data for the task at hand; do not persist VRMs or
  results into long-term memory, shared transcripts, or third-party logs beyond what the task needs.
- **Don't broadcast.** Avoid posting raw MOT results or VRMs into public/shared channels.
- MossForge serves DVSA-sourced data; the caller is responsible for lawful use of what they retrieve.

## x402 payments

Access is pay-per-request via x402.

- Discover enabled datasets and current prices at `GET https://api.databroker.mossforge.dev/v1/discover`
  (no payment required). Treat the runtime `402 Payment Required` challenge on the actual data
  route as the source of truth for price, network, and payee for any single call — `/v1/discover`
  tells you what's available; the `402` on the route you actually call tells you what THIS call
  costs right now. **Do not hardcode prices.**
- Validate the challenge against the **Security** rules above (network, asset, payee) before
  signing anything.

**Negotiation flow:**
1. Send the request normally.
2. If the response is `402 Payment Required`, parse the payment requirements from the response body
   and the `Payment-Required` header.
3. Check the quoted amount against the spend caps and confirm with the user if required.
4. Sign the payment payload and retry with the `Payment-Signature` header (legacy: `X-PAYMENT`).
5. Continue once the retried request succeeds.

### Input validation

Normalise and validate the VRM before spending money on a call:
- Strip spaces and upper-case it (e.g. `ab12 cde` → `AB12CDE`).
- If it doesn't look like a plausible UK VRM, ask the user to correct it rather than paying for a
  request that will fail.

### Checking staleness for free before paying again

`GET /v1/dvsa-mot/{registration}/meta` requires no payment and returns `fetch_status`,
`ttl_seconds`, and `stale` for whatever is currently cached for that VRM — useful for deciding
whether a fresh paid lookup is actually worth it, without spending anything to find out.

### x402 request pattern (Python)

```python
import os
from dotenv import load_dotenv
from eth_account import Account
from x402 import x402ClientSync
from x402.http import x402HTTPClientSync
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client
from x402.http.clients import x402_requests

load_dotenv()

BASE_URL = "https://api.databroker.mossforge.dev"
vrm = "AB12CDE"  # normalised, validated

account = Account.from_key(os.getenv("X402_PRIVATE_KEY"))
print(f"Payment wallet: {account.address}")  # address only — never print the key

client = x402ClientSync()
register_exact_evm_client(client, EthAccountSigner(account))
http_client = x402HTTPClientSync(client)

# NOTE: enforce your spend caps in the payment hook / before retry — reject over-cap quotes.
# The VRM is a PATH segment, not a query param — /v1/dvsa-mot/{vrm}
with x402_requests(client) as session:
    resp = session.get(f"{BASE_URL}/v1/dvsa-mot/{vrm}")
    print(f"Status: {resp.status_code}")
    print(resp.text)
```

**Secrets note:** Never commit credentials or signatures. Placeholders only (`$X402_PRIVATE_KEY`).

## Endpoints

| Endpoint | Method | Description | Auth | Cost |
|---|---|---|---|---|
| `/v1/discover` | GET | List enabled datasets and current prices | none | free |
| `/v1/dvsa-mot/{registration}` | GET | Full MOT history for a VRM | x402 | see `/v1/discover` |
| `/v1/dvsa-mot/{registration}/meta` | GET | Freshness/staleness only — no payload | none | free |

**Key params:** `{registration}` — the vehicle registration, normalised (see **Input validation**).

## Example request routing

```
"What's the MOT history for AB12 CDE?"          → GET  /v1/dvsa-mot/AB12CDE
"Has this car ever failed its MOT?"             → GET  /v1/dvsa-mot/AB12CDE  (inspect data.motTests[].testResult)
"Does the mileage on GK19 XYZ look consistent?" → GET  /v1/dvsa-mot/GK19XYZ  (compare data.motTests[].odometerValue)
"When is my MOT due?"                           → GET  /v1/dvsa-mot/AB12CDE  (read data.summary.latestExpiryDate)
```

## Configuration (openclaw.json)

```json
{
  "skills": {
    "entries": {
      "mossforge-mot-history": {
        "enabled": true,
        "env": {
          "X402_PRIVATE_KEY": "",
          "X402_NETWORK": "base-sepolia",
          "MOSSFORGE_MAX_SPEND_PER_CALL_USDC": "0.05",
          "MOSSFORGE_MAX_SPEND_PER_SESSION_USDC": "1.00"
        }
      }
    }
  }
}
```

Leave `X402_PRIVATE_KEY` out of version control — set it via your secrets mechanism, not this file.
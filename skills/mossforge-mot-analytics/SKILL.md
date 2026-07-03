---
name: mossforge-mot-analytics
description: Aggregated UK DVSA MOT statistics by vehicle segment via x402 pay-per-request (no account, no API key) — pass rates, dangerous defect rates, annual mileage and clocking rates, fleet population counts, fuel mix, and colour distribution, computed from the full DVSA bulk dataset. Use for reliability comparisons across makes, "is this mileage normal for its age" questions, market-sizing by segment, and fuel-mix/EV-transition trend analysis. Not for single-vehicle history — use mossforge-mot-history for that. Credential is X402_PRIVATE_KEY (a dedicated payment wallet).
homepage: https://github.com/mossforge/databroker
metadata: {"openclaw":{"homepage":"https://github.com/mossforge/databroker","primaryEnv":"X402_PRIVATE_KEY"}}
---

# MossForge — UK MOT Analytics

Aggregate statistics across the full UK DVSA MOT dataset, sliced by make, fuel type, vehicle
age, and registration year. Paid per request over x402 with USDC on Base. No account, no
subscription, no API key.

This is a different tool from **mossforge-mot-history**: that skill answers "what's the MOT
history of THIS car" for a single VRM; this skill answers "what's typical for cars LIKE this"
across a whole segment. Use both together — e.g. pull one vehicle's history, then check
`reliability:<make>` to see whether its record is normal or an outlier for its make.

## What this skill answers

- How does one make's MOT pass rate compare to another's, or across age/mileage bands?
- Is a given annual mileage normal for a vehicle's age, or a possible clocking red flag?
- How many 5-8 year old diesel Fords are still actively being tested (a proxy for still on the road)?
- How has the UK's fuel mix shifted across registration years (EV/hybrid transition, diesel decline)?
- What are the most common colours for a given make and registration year?
- What does UK-wide MOT test volume, pass rate, and expiry density look like by calendar month?

If the question is about a specific vehicle by registration plate, use **mossforge-mot-history**
instead — this skill only returns aggregates, never individual vehicle records.

## Prerequisites

- **A dedicated x402 payment wallet** (`X402_PRIVATE_KEY`) — an EVM private key for a wallet
  used *only* for x402 micropayments. Same wallet as `mossforge-mot-history` if you're running
  both skills. See **Security** below: do **not** use a primary or high-value wallet here.
- **USDC on the configured network.** Fund the wallet with a small amount of USDC on Base
  (testnet USDC on Base Sepolia while you evaluate; Base mainnet for production).
- No API key and no MossForge account are required. Payment is the only auth.

## REST API overview

**Base URL:** `https://api.databroker.mossforge.dev`

All endpoints accept and return JSON. Pricing is **not** hardcoded in this skill — the runtime
`402 Payment Required` challenge on the route you actually call is the single source of truth
for the current price (see **x402 payments**).

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
6. **Never persist the key.** Env var only. Do not write it to the workspace, transcripts, memory
   files, or logs.

## Statistical reliability — read before trusting a rate

Every response includes `minN` (the suppression threshold, currently 30) and, if any rate was
withheld for low sample size, `lowSample: true`. A derived rate or percentile is returned as
`null` — never as a misleadingly precise number — when its underlying count is below `minN`.
Raw counts (`vehicleCount`, fuel/colour counts, test volume) are always returned in full; only
*derived* rates/percentiles/shares get suppressed. Before treating any returned rate as
meaningful, check for `null` and for `lowSample: true` — this matters most for narrow segments
(an uncommon make crossed with an uncommon fuel type and a narrow age band).

## x402 payments

Access is pay-per-request via x402.

- Discover enabled datasets and current prices at `GET https://api.databroker.mossforge.dev/v1/discover`
  (no payment required). The runtime `402 Payment Required` challenge on the actual analytics
  route is the source of truth for what THIS call costs right now. **Do not hardcode prices.**
- Validate the challenge against the **Security** rules above (network, asset, payee) before
  signing anything.

**Negotiation flow:**
1. Send the request normally.
2. If the response is `402 Payment Required`, parse the payment requirements from the response body
   and the `Payment-Required` header.
3. Check the quoted amount against the spend caps and confirm with the user if required.
4. Sign the payment payload and retry with the `Payment-Signature` header (legacy: `X-PAYMENT`).
5. Continue once the retried request succeeds.

### Key validation before paying

The `{key}` path segment must match one of the six family formats below. Validate it client-side
before paying — a malformed key still costs money if you don't catch it first:

- Valid age bands: `0-3yr`, `3-5yr`, `5-8yr`, `8-12yr`, `12yr+`
- Valid fuel types: `petrol`, `diesel`, `electric`, `hybrid`, `other`
- Valid makes: `ford`, `vauxhall`, `volkswagen`, `bmw`, `mercedes-benz`, `toyota`, `audi`, `nissan`,
  `peugeot`, `renault`, `honda`, `hyundai`, `kia`, `volvo`, `land rover`, `mini`, `seat`, `skoda`,
  `fiat`, `mazda`, `citroen`, `jeep`, `mitsubishi`, `suzuki`, `lexus`, `subaru`, `dacia`,
  `alfa romeo`, `jaguar`, `porsche`, `other` — any make not on this list is bucketed as `other`
  server-side, so an unrecognised make in the key will still resolve, just into the `other` bucket.

### Checking staleness for free before paying again

`GET /v1/dvsa-mot-analytics/{key}/meta` requires no payment and returns `fetch_status`,
`ttl_seconds`, and `stale` for whatever is currently cached for that key — useful for deciding
whether a fresh paid lookup is actually worth it before spending anything to find out. Analytics
buckets refresh on a daily pipeline, so within the same day a re-query of the same key won't
return materially different data.

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
key = "reliability:ford"  # colon-delimited, validated against the formats above

account = Account.from_key(os.getenv("X402_PRIVATE_KEY"))
print(f"Payment wallet: {account.address}")  # address only — never print the key

client = x402ClientSync()
register_exact_evm_client(client, EthAccountSigner(account))
http_client = x402HTTPClientSync(client)

# NOTE: enforce your spend caps in the payment hook / before retry — reject over-cap quotes.
with x402_requests(client) as session:
    resp = session.get(f"{BASE_URL}/v1/dvsa-mot-analytics/{key}")
    print(f"Status: {resp.status_code}")
    print(resp.text)
```

**Secrets note:** Never commit credentials or signatures. Placeholders only (`$X402_PRIVATE_KEY`).

## Endpoints

| Endpoint | Method | Description | Auth | Cost |
|---|---|---|---|---|
| `/v1/discover` | GET | List enabled datasets and current prices | none | free |
| `/v1/dvsa-mot-analytics/{key}` | GET | Aggregated stats for a segment | x402 | see `/v1/discover` |
| `/v1/dvsa-mot-analytics/{key}/meta` | GET | Freshness/staleness only — no payload | none | free |

## Response envelope

Every successful response shares the standard DataBroker envelope, with `data` shaped
per-family (see below):

```json
{
  "dataset": "dvsa-mot-analytics",
  "key": "reliability:ford",
  "data": { "...family-specific, see below..." },
  "fetched_at": "2026-07-03T00:00:00.000Z",
  "fetch_status": "ok",
  "source": "DVSA MOT History API v2 — aggregate analytics",
  "ttl_seconds": 691200,
  "stale": false
}
```

## The six analytics families

### `reliability:<make>` — e.g. `reliability:ford`

Pass rates and dangerous-defect rate for a make, broken down by current vehicle age band and by
mileage band at latest test.

```json
{
  "family": "reliability",
  "make": "ford",
  "n": 412088,
  "firstTimePassRate": 71.4,
  "passRateByAge": [
    { "band": "0-3yr", "passRate": 94.2, "n": 38221 },
    { "band": "3-5yr", "passRate": 88.6, "n": 71903 },
    { "band": "5-8yr", "passRate": 79.1, "n": 122344 },
    { "band": "8-12yr", "passRate": 68.3, "n": 98211 },
    { "band": "12yr+", "passRate": 55.7, "n": 81409 }
  ],
  "passRateByMileage": [
    { "band": "0-30k", "passRate": 91.0, "n": 54012 },
    { "band": "30-60k", "passRate": 85.3, "n": 88761 },
    { "band": "60-100k", "passRate": 76.9, "n": 102334 },
    { "band": "100-150k", "passRate": 68.1, "n": 91228 },
    { "band": "150k+", "passRate": 57.4, "n": 75753 }
  ],
  "dangerousDefectRate": 2.1,
  "dangerousN": 398211,
  "computedAt": "2026-07-03T00:00:00.000Z",
  "minN": 30
}
```

`passRateByAge` and `passRateByMileage` always return all 5 bands, in order — a band with `n`
below `minN` returns `passRate: null` and `lowSample: true` on that entry rather than omitting
the band.

### `mileage:<make>:<band_or_year>` — e.g. `mileage:ford:5-8yr` or `mileage:ford:2019`

Average annual mileage, percentile distribution, and odometer-clocking rate. Accepts **either**
an age band (rolls up several registration-year cohorts) **or** an exact 4-digit registration
year (single cohort, no roll-up) — the response shape differs slightly depending on which you
used:

```json
// mileage:ford:5-8yr  (age band — response includes "band")
{
  "family": "mileage",
  "make": "ford",
  "band": "5-8yr",
  "n": 58210,
  "avgAnnualMileage": 8940,
  "percentiles": { "p10": 3200, "p25": 5600, "p50": 8500, "p75": 11800, "p90": 15400 },
  "clockingRate": 0.4,
  "clockingN": 61023,
  "computedAt": "2026-07-03T00:00:00.000Z",
  "minN": 30
}
```

```json
// mileage:ford:2019  (exact year — response includes "cohortYear" and "currentBand" instead of "band")
{
  "family": "mileage",
  "make": "ford",
  "cohortYear": 2019,
  "currentBand": "5-8yr",
  "n": 21044,
  "avgAnnualMileage": 9120,
  "percentiles": { "p10": 3400, "p25": 5900, "p50": 8700, "p75": 12000, "p90": 15800 },
  "clockingRate": 0.4,
  "clockingN": 22110,
  "computedAt": "2026-07-03T00:00:00.000Z",
  "minN": 30
}
```

Age band is the more useful query for "is this mileage normal for its age" — it doesn't require
knowing the exact registration year. Exact year is more useful for year-over-year trend analysis.

### `parc:<make>:<fuel>:<band_or_year>` — e.g. `parc:ford:diesel:5-8yr`

Fleet population and recent testing activity. Same band-vs-year shape distinction as `mileage`
above. Raw counts only — nothing here is ever suppressed by `minN`, since there are no derived
rates in this family.

```json
{
  "family": "parc",
  "make": "ford",
  "fuel": "diesel",
  "band": "5-8yr",
  "n": 61023,
  "vehicleCount": 61023,
  "recentlyTested": 54871,
  "computedAt": "2026-07-03T00:00:00.000Z",
  "minN": 30
}
```

`recentlyTested` counts vehicles tested within roughly the last 2 calendar years — a proxy for
"still actively on the road" versus scrapped/exported/off-road (SORN).

### `fuelmix:<year>` — e.g. `fuelmix:2019`

Fuel type distribution across all makes for a given registration year.

```json
{
  "family": "fuelmix",
  "regYear": "2019",
  "total": 2946555,
  "counts": { "petrol": 1629825, "diesel": 1086093, "electric": 63002, "hybrid": 149158, "other": 18477 },
  "shares": { "petrol": 55.3, "diesel": 36.9, "electric": 2.1, "hybrid": 5.1, "other": 0.6 },
  "computedAt": "2026-07-03T00:00:00.000Z",
  "minN": 30
}
```

`counts` always sums to `total`. `shares` values are individually suppressed to `null` (whole
object, all keys) if `total` itself is below `minN` — a low-volume year for the whole UK fleet,
not a per-fuel-type check.

### `colour:<make>:<year>` — e.g. `colour:ford:2019`

Top colours for a make/registration-year combination, sorted by count descending. Raw counts
only, no suppression.

```json
{
  "family": "colour",
  "make": "ford",
  "regYear": "2019",
  "total": 187442,
  "top": [
    { "key": "BLACK", "count": 41203 },
    { "key": "GREY", "count": 38771 },
    { "key": "WHITE", "count": 29104 }
  ],
  "computedAt": "2026-07-03T00:00:00.000Z",
  "minN": 30
}
```

`top` is capped at 12 entries.

### `temporal` — no parameters

UK-wide MOT test volume, pass rate, and certificate expiry density, bucketed by calendar month.
The only family with no key parameters — request the literal key `temporal`.

```json
{
  "family": "temporal",
  "testVolumeByMonth": [
    { "month": "2026-05", "count": 2984112 },
    { "month": "2026-06", "count": 3021887 }
  ],
  "passRateByMonth": [
    { "month": "2026-05", "passRate": 74.8, "n": 2984112 },
    { "month": "2026-06", "passRate": 75.1, "n": 3021887 }
  ],
  "expiryDensityByMonth": [
    { "month": "2026-05", "count": 2811004 },
    { "month": "2026-06", "count": 2903412 }
  ],
  "computedAt": "2026-07-03T00:00:00.000Z",
  "minN": 30
}
```

Useful for seasonality analysis (MOT test volume clusters around certificate-expiry patterns) or
as a national baseline to compare a specific make/segment against.

## Example request routing

```
"How does Ford's reliability compare to Toyota's?"          → GET /v1/dvsa-mot-analytics/reliability:ford
                                                                 GET /v1/dvsa-mot-analytics/reliability:toyota
"Is 90,000 miles normal for a 6-year-old Ford?"              → GET /v1/dvsa-mot-analytics/mileage:ford:5-8yr  (compare against percentiles)
"How many 5-8yr diesel Fords are still on the road?"         → GET /v1/dvsa-mot-analytics/parc:ford:diesel:5-8yr
"How has the UK's EV share changed since 2019?"              → GET /v1/dvsa-mot-analytics/fuelmix:2019
                                                                 GET /v1/dvsa-mot-analytics/fuelmix:2023
"What colour Fords were most common in 2019?"                → GET /v1/dvsa-mot-analytics/colour:ford:2019
"Is there a seasonal pattern to MOT test volume?"             → GET /v1/dvsa-mot-analytics/temporal
```

## Configuration (openclaw.json)

```json
{
  "skills": {
    "entries": {
      "mossforge-mot-analytics": {
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
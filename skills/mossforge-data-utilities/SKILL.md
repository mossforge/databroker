---
name: mossforge-data-utilities
description: 24 pay-per-call identifier, geospatial, and reference-data utilities via x402 (no account, no API key) — validate/decode VINs, UK plates, IBANs, ISINs, LEIs, card numbers, GTINs, ISBNs, shipping containers; compute check digits (Luhn/Verhoeff/Damm/ISO 7064); great-circle distance and geohash; look up MAC vendors, airports, timezones, ISO currencies, and UN/LOCODEs. Use when you need an authoritative verdict on an identifier or a standards-correct computation instead of implementing the algorithm yourself ($0.001-$0.002 per call). Not for single-vehicle MOT history (mossforge-mot-history) or fleet statistics (mossforge-mot-analytics). Credential is X402_PRIVATE_KEY (a dedicated payment wallet).
homepage: https://github.com/mossforge/databroker
metadata: {"openclaw":{"homepage":"https://github.com/mossforge/databroker","primaryEnv":"X402_PRIVATE_KEY"}}
---

# MossForge — Data Utilities

Single-purpose validation, decoding, and reference-lookup endpoints, paid per request over x402
with USDC on Base. No account, no subscription, no API key. Each endpoint implements one named
standard (ISO 13616, GS1, ISO 6346, IANA tzdb, …) and states it in every response.

This is a different tool from the MOT skills: **mossforge-mot-history** answers "what's the MOT
history of THIS car", **mossforge-mot-analytics** answers "what's typical for cars LIKE this" —
this skill answers "is this identifier valid / what does it decode to / what does this standard
say". They compose well: decode a VIN or UK plate here, then pull its history or segment stats
with the other skills.

## What this skill answers

- Is this IBAN / ISIN / CUSIP / SEDOL / LEI / card number / ABA routing number structurally valid,
  and what do its parts mean?
- Is this VIN well-formed, which region/manufacturer does the WMI map to, and what model years
  could the year code mean?
- What era is this UK plate from, and what registration period does its age identifier decode to?
- When is a GB vehicle's first MOT due, given its first registration date?
- What are the dimensions, max load, and max speed for tyre code `205/55R16 91V`?
- Validate or compute a check digit under Luhn, Verhoeff, Damm, MOD 97-10, or MOD 11-2.
- Validate a GTIN/EAN/UPC, ISBN (with 10↔13 conversion), ISSN, ISO 6346 container number, or IMO ship number.
- Great-circle distance and bearing between two coordinates; destination point from bearing + distance; geohash encode/decode.
- Which vendor owns this MAC prefix? Which airport is `LHR`/`EGLL`? What's the UTC offset in
  `Europe/London` on a given date? What are `GBP`'s minor units? What is UN/LOCODE `GBLON`?

**Rule of thumb:** at $0.001 a call, paying the endpoint is usually cheaper and safer than
writing and testing your own implementation of a checksum or standards table inline.

## Prerequisites

- **A dedicated x402 payment wallet** (`X402_PRIVATE_KEY`) — an EVM private key for a wallet
  used *only* for x402 micropayments. Same wallet as the other MossForge skills if you're
  running several. See **Security** below: do **not** use a primary or high-value wallet here.
- **USDC on the configured network.** Fund the wallet with a small amount of USDC on Base
  (testnet USDC on Base Sepolia while you evaluate; Base mainnet for production).
- No API key and no MossForge account are required. Payment is the only auth.

## REST API overview

**Base URL:** `https://api.databroker.mossforge.dev`

All endpoints follow the same shape: `GET /v1/{dataset_id}/{key}`. Pricing is **not** hardcoded
in this skill — the runtime `402 Payment Required` challenge on the route you actually call is
the single source of truth for the current price (see **x402 payments**).

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
7. **Never send sensitive identifiers you shouldn't hold.** `util-card` performs a structural
   Luhn/network check only — do not send full card numbers you have no legitimate reason to
   process, and prefer test numbers when demonstrating.

## Paying for a verdict — read before calling a validator

Two rules that prevent wasted money and wrong retry logic:

1. **`valid: false` is a paid, correct, final answer.** These endpoints sell the verdict, not
   confirmation. Do not treat `valid: false` as an error, and never retry the same key hoping
   for a different result — computed endpoints are deterministic, so the same key returns the
   same verdict forever.
2. **Malformed keys are rejected free.** A key that isn't even a well-posed question (empty,
   non-printable characters, wrong arity for compute-style keys) returns HTTP 400 *before*
   payment — no funds move. The 400 message states the expected format; fix the key and retry.
   The precheck is deliberately loose: for example, a wrong-length IBAN is a legitimate *paid*
   `valid: false`, not a free 400 — rejecting it for free would give the answer away.

**Cache computed results client-side, forever.** Every computed response carries
`deterministic: true` — the same key can never return a different answer, so never pay twice
for the same key. Bundled lookups carry `deterministic: false` plus `ttl_seconds` (the snapshot
refresh cadence) and `data.data_generated_at` — cache those up to the ttl.

## x402 payments

Access is pay-per-request via x402.

- Discover enabled datasets and current prices at `GET https://api.databroker.mossforge.dev/v1/discover`
  (no payment required). Each utility entry includes `kind` (`computed` | `bundled`), the
  `standard` it implements, `deterministic`, and for bundled datasets a `data_source`. The
  runtime `402 Payment Required` challenge on the actual route is the source of truth for what
  THIS call costs right now. **Do not hardcode prices.**
- Indicative pricing at time of writing: computed utilities $0.001, bundled lookups $0.002 —
  but always verify against the live challenge.
- Validate the challenge against the **Security** rules above (network, asset, payee) before
  signing anything.

**Negotiation flow:**
1. Send the request normally.
2. If the response is `402 Payment Required`, parse the payment requirements from the response body
   and the `PAYMENT-REQUIRED` header.
3. Check the quoted amount against the spend caps and confirm with the user if required.
4. Sign the payment payload and retry with the `PAYMENT-SIGNATURE` header (legacy: `X-PAYMENT`).
5. Continue once the retried request succeeds.

### Key encoding

The `{key}` path segment is URL-decoded server-side, so **percent-encode any key containing
`/`, spaces, `+`, or `#`**. Examples:

- `205/55R16 91V` → `/v1/util-tyre-size/205%2F55R16%2091V`
- `zone:Europe/London:2026-01-15` → `/v1/util-tz/zone%3AEurope%2FLondon%3A2026-01-15`
  (encoding the `:` is optional; encoding the `/` is not)

### Free /meta route

`GET /v1/{dataset_id}/{key}/meta` requires no payment. For utility datasets it returns the
`kind`, `standard`, and determinism info (there is no cache to inspect) — useful for confirming
a dataset exists and how to treat its results before spending anything.

### x402 request pattern (Python)

```python
import os
from urllib.parse import quote
from dotenv import load_dotenv
from eth_account import Account
from x402 import x402ClientSync
from x402.mechanisms.evm import EthAccountSigner
from x402.mechanisms.evm.exact.register import register_exact_evm_client
from x402.http.clients import x402_requests

load_dotenv()

BASE_URL = "https://api.databroker.mossforge.dev"
dataset = "util-iban"
key = quote("GB82WEST12345698765432", safe="")  # always percent-encode the key

account = Account.from_key(os.getenv("X402_PRIVATE_KEY"))
print(f"Payment wallet: {account.address}")  # address only — never print the key

client = x402ClientSync()
register_exact_evm_client(client, EthAccountSigner(account))

# NOTE: enforce your spend caps in the payment hook / before retry — reject over-cap quotes.
with x402_requests(client) as session:
    resp = session.get(f"{BASE_URL}/v1/{dataset}/{key}")
    print(f"Status: {resp.status_code}")
    print(resp.text)
```

**Secrets note:** Never commit credentials or signatures. Placeholders only (`$X402_PRIVATE_KEY`).

## Endpoints

| Endpoint | Method | Description | Auth | Cost |
|---|---|---|---|---|
| `/v1/discover` | GET | List enabled datasets, prices, kind/standard/determinism | none | free |
| `/v1/{dataset_id}/{key}` | GET | Compute or look up (see catalogue below) | x402 | see `/v1/discover` |
| `/v1/{dataset_id}/{key}/meta` | GET | Kind/standard/determinism info — no payload | none | free |

## Response envelope

Every successful response shares the standard DataBroker envelope, with `data` shaped per
endpoint. Utility responses add a `deterministic` marker:

```json
{
  "dataset": "util-iban",
  "key": "GB82WEST12345698765432",
  "data": { "...endpoint-specific..." },
  "fetched_at": "2026-07-05T12:00:00.000Z",
  "fetch_status": "ok",
  "source": "ISO 13616 / ISO 7064 MOD 97-10",
  "ttl_seconds": 315360000,
  "stale": false,
  "deterministic": true
}
```

For computed endpoints `ttl_seconds` is a 10-year sentinel (the result never expires) and
`source` names the standard. For bundled endpoints `deterministic` is `false`, `source` names
the upstream data source, and `ttl_seconds` advertises the snapshot refresh cadence.

Most `data` payloads include `input` (as sent), a normalised form, a `standard` field, and —
where honesty demands it — a `caveat` explaining the limits of a structural check (e.g. a valid
IBAN structure does not mean the account exists; a valid plate format does not mean the plate
is issued).

## Endpoint catalogue

### Vehicles (computed, companions to the MOT skills)

- **`util-vin`** — key: a 17-character VIN.
  Structural validation, North American position-9 check digit, WMI → region + common
  manufacturer, VDS/VIS split, plant code, model year candidates (codes repeat every 30 years,
  so both are returned). Caveat: European VINs may legitimately fail the NA check digit.
  `GET /v1/util-vin/1HGCM82633A004352`

- **`util-uk-plate`** — key: a UK registration plate (spaces optional).
  Format era (current 2001+, prefix 1983-2001, suffix 1963-1983, dateless), area code, age
  identifier, decoded registration period. Caveat: format decode only — cherished transfers
  can put an old-format plate on a newer vehicle.
  `GET /v1/util-uk-plate/LB07SEO`

- **`util-mot-due`** — key: `YYYY-MM-DD` (vehicle first registration date, strict format —
  anything else is a free 400).
  First MOT due date, whether it's now due, vehicle age, 40-year historic exemption flag.
  `GET /v1/util-mot-due/2023-09-14`

- **`util-tyre-size`** — key: an ISO metric tyre code, URL-encoded.
  Section width, aspect ratio, construction, rim diameter, computed overall diameter, load
  index → max kg, speed rating → max km/h.
  `GET /v1/util-tyre-size/205%2F55R16%2091V`

### Finance & securities (computed)

- **`util-iban`** — IBAN validity (per-country SWIFT lengths + MOD 97-10), country/BBAN parse. `GET /v1/util-iban/GB82WEST12345698765432`
- **`util-isin`** — ISIN validity, country prefix, NSIN, Luhn check digit. `GET /v1/util-isin/US0378331005`
- **`util-cusip`** — CUSIP validity, issuer/issue split, mod-10 with `*`,`@`,`#` handling. `GET /v1/util-cusip/037833100`
- **`util-sedol`** — SEDOL validity, weighted mod-10 check digit. `GET /v1/util-sedol/B0YQ5W0`
- **`util-lei`** — LEI validity, MOD 97-10 check digits. `GET /v1/util-lei/213800WSGIIZCXF1P572`
- **`util-card`** — Luhn validity + network detection by public prefix/length rules (structural only — not an issuer BIN lookup). Prefer test numbers. `GET /v1/util-card/4111111111111111`
- **`util-aba-rtn`** — US ABA routing number validity, 3-7-1 weighted mod-10. `GET /v1/util-aba-rtn/021000021`

### Product & publication codes (computed)

- **`util-gtin`** — key: an 8/12/13/14-digit GTIN (EAN/UPC), or `compute:<digits>` with one
  fewer digit to get the check digit and full code. `GET /v1/util-gtin/5000112637922`
- **`util-isbn`** — ISBN-10 or ISBN-13; valid inputs return both forms (13→10 only for the
  978 prefix). `GET /v1/util-isbn/9780306406157`
- **`util-issn`** — 8-character ISSN, weighted mod-11 check character. `GET /v1/util-issn/03178471`

### Logistics (computed)

- **`util-container`** — ISO 6346 container number: owner code, equipment category, serial,
  check digit. `GET /v1/util-container/MSKU3068821`
- **`util-imo`** — 7-digit IMO ship number, weighted check digit. `GET /v1/util-imo/9074729`

### Generic algorithms (computed)

- **`util-checkdigit`** — key: `<algorithm>:<verify|compute>:<digits>` with algorithm one of
  `luhn`, `verhoeff`, `damm`, `mod97-10`, `mod11-2`. Strict format — a malformed key is a free
  400. `verify` returns `valid`; `compute` returns the check digit/character and `full_value`.
  MOD 11-2 accepts a trailing `X` check character on verify; the others are digits-only.
  `GET /v1/util-checkdigit/luhn:compute:7992739871`

### Geospatial math (computed)

- **`util-geo`** — key: `distance:lat1,lon1,lat2,lon2` (returns km/mi/nm + initial bearing) or
  `destination:lat,lon,bearingDegrees,distanceKm`. Haversine on a spherical earth (mean radius
  6371.0088 km). Strict format — malformed keys are a free 400.
  `GET /v1/util-geo/distance:51.4700,-0.4543,40.6413,-73.7781`
- **`util-geohash`** — key: `encode:lat,lon[,precision]` (precision 1-12, default 9) or
  `decode:<hash>` (returns centre + bounding box).
  `GET /v1/util-geohash/encode:51.5074,-0.1278,7`

### Bundled reference lookups ($0.002, snapshot-backed)

- **`util-oui`** — key: a full MAC or OUI prefix (`00:00:5E`, `00005E005300`). Vendor
  name/country from the IEEE registry; flags locally-administered (randomised) and multicast
  addresses — a registry hit on a randomised MAC is coincidental and the response says so.
  Snapshot ~30 days. `GET /v1/util-oui/00%3A00%3A5E`
- **`util-airport`** — key: `LHR`, `EGLL`, or explicit `iata:LHR` / `icao:EGLL` (bare 3-char
  keys are treated as IATA). Name, coordinates, elevation, country/region, municipality,
  scheduled service, both codes; additional matches listed if a code is ambiguous.
  Snapshot ~30 days (OurAirports). `GET /v1/util-airport/LHR`
- **`util-tz`** — key: `zone:<IANA id>[:<ISO timestamp>]` (offset, DST status, abbreviation at
  that moment — defaults to now) or `country:<ISO2>` (zone list). Offsets come from the runtime
  ICU, so they're current even between snapshot refreshes; aliases like `Europe/Belfast`
  resolve to their canonical zone. Remember to URL-encode the `/` in zone IDs.
  `GET /v1/util-tz/zone%3AEurope%2FLondon%3A2026-01-15`
- **`util-currency`** — key: 3-letter alpha (`GBP`) or 3-digit numeric (`826`) ISO 4217 code.
  Name, minor units, using entities, withdrawn-code history. Snapshot ~90 days.
  `GET /v1/util-currency/GBP`
- **`util-locode`** — key: 5-character UN/LOCODE (`GBLON` or `GB:LON`). Place name,
  subdivision, decoded function classifiers (port/rail/road/airport…), status, coordinates.
  Snapshot ~180 days. `GET /v1/util-locode/GBLON`

## Example request routing

```
"Is GB82 WEST 1234 5698 7654 32 a valid IBAN?"              → GET /v1/util-iban/GB82WEST12345698765432
"What year is a BD51 SMR plate from?"                        → GET /v1/util-uk-plate/BD51SMR
"When does a car first registered 2023-09-14 need an MOT?"   → GET /v1/util-mot-due/2023-09-14
"What's the max load for 225/45R17 94W tyres?"               → GET /v1/util-tyre-size/225%2F45R17%2094W
"Compute the Luhn check digit for 7992739871"                → GET /v1/util-checkdigit/luhn:compute:7992739871
"Convert ISBN 0-306-40615-2 to ISBN-13"                      → GET /v1/util-isbn/0306406152
"How far is Heathrow from JFK?"                              → GET /v1/util-geo/distance:51.4700,-0.4543,40.6413,-73.7781
"Whose MAC prefix is 00:00:5E?"                              → GET /v1/util-oui/00%3A00%3A5E
"What's the UTC offset in Sydney right now?"                 → GET /v1/util-tz/zone%3AAustralia%2FSydney
"What port is UN/LOCODE NLRTM?"                              → GET /v1/util-locode/NLRTM
```

## Configuration (openclaw.json)

```json
{
  "skills": {
    "entries": {
      "mossforge-data-utilities": {
        "enabled": true,
        "env": {
          "X402_PRIVATE_KEY": "",
          "X402_NETWORK": "base-sepolia",
          "MOSSFORGE_MAX_SPEND_PER_CALL_USDC": "0.01",
          "MOSSFORGE_MAX_SPEND_PER_SESSION_USDC": "0.50"
        }
      }
    }
  }
}
```

Leave `X402_PRIVATE_KEY` out of version control — set it via your secrets mechanism, not this file.
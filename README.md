# Mossforge DataBroker

Pay-per-call UK data and utility API, gated by [x402](https://x402.org) micropayments on Base
mainnet. No API keys, no accounts, no subscriptions — send a signed USDC payment with your HTTP
request and get an answer back in the same response cycle.

- **Base URL:** `https://api.databroker.mossforge.dev`
- **Network:** Base mainnet (`eip155:8453`)
- **Payment token:** USDC
- **Protocol:** x402, `exact` scheme
- **Landing / docs:** [databroker.mossforge.dev](https://databroker.mossforge.dev) ·
  [llms.txt](https://databroker.mossforge.dev/llms.txt) ·
  [openapi.yaml](https://databroker.mossforge.dev/openapi.yaml)

## Quick start

```bash
curl https://api.databroker.mossforge.dev/v1/discover
```

`/v1/discover` is free and returns every enabled dataset with its current price, description,
and provenance (`kind`, implemented `standard`, `deterministic`, `data_source`). Prices are
configured server-side and can change — always trust the live `402` challenge over anything
written in this README.

Requesting any paid route without payment returns `HTTP 402` with the exact amount, recipient,
and network in a `PAYMENT-REQUIRED` header. Sign an EIP-3009 USDC transfer authorization, retry
with a `PAYMENT-SIGNATURE` header, and the API verifies, settles on-chain, and returns the data
with a `PAYMENT-RESPONSE` receipt. **A 402 means no funds have moved — you only pay on a 200.**

x402 client libraries: [`@coinbase/x402-fetch`](https://www.npmjs.com/package/@coinbase/x402-fetch)
(TypeScript), [`x402`](https://pypi.org/project/x402/) (Python),
[`x402-go`](https://github.com/coinbase/x402-go) (Go).

## Endpoints

All paid routes follow the same shape: `GET /v1/{dataset_id}/{key}`. Keys are URL-decoded
server-side, so percent-encode anything containing `/`, spaces, or `+`
(e.g. `205/55R16 91V` → `/v1/util-tyre-size/205%2F55R16%2091V`).

### Free routes

| Route                          | Description                                                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `GET /v1/health`               | Uptime check                                                                                                      |
| `GET /v1/discover`             | All enabled datasets, current prices, provenance                                                                  |
| `GET /v1/{dataset}/{key}/meta` | Cache freshness for cached datasets; kind/standard/determinism info for utilities. Never returns the data payload |

### Cached datasets

Stored datasets backed by ingestion pipelines, with full freshness semantics (`ttl_seconds`,
`stale`, free `/meta` checks).

| Dataset            | Route                              | Price  | Description                                                                                                                                                                                             |
| ------------------ | ---------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DVSA MOT history   | `GET /v1/dvsa-mot/{registration}`  | $0.005 | Full MOT test history for a UK vehicle — vehicle details, pass/fail summary, mileage, individual test records with defects. Cached 30 days; first-ever lookup for a plate triggers a live fetch (2-4 s) |
| DVSA MOT analytics | `GET /v1/dvsa-mot-analytics/{key}` | $0.02  | Aggregated MOT statistics by vehicle segment — pass rates, top defects, mileage percentiles, clocking rates, fuel mix, colour distribution. Refreshed daily from the full DVSA bulk dataset             |

Analytics keys are colon-delimited and family-specific:

| Family      | Key format                          | Example                  | Returns                                                                         |
| ----------- | ----------------------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| reliability | `reliability:<make>`                | `reliability:ford`       | Pass rates by age and mileage band, first-time pass rate, dangerous defect rate |
| mileage     | `mileage:<make>:<band_or_year>`     | `mileage:ford:5-8yr`     | Average annual mileage, percentile distribution, odometer clocking rate         |
| parc        | `parc:<make>:<fuel>:<band_or_year>` | `parc:ford:diesel:5-8yr` | Fleet population counts and recent testing activity                             |
| fuelmix     | `fuelmix:<year>`                    | `fuelmix:2019`           | Fuel type distribution for a registration year                                  |
| colour      | `colour:<make>:<year>`              | `colour:ford:2019`       | Top colours for a make/year                                                     |
| temporal    | `temporal`                          | `temporal`               | UK-wide test volume, pass rate, expiry density by month                         |

Age bands: `0-3yr`, `3-5yr`, `5-8yr`, `8-12yr`, `12yr+`. Fuels: `petrol`, `diesel`, `electric`,
`hybrid`, `other`. Derived rates are suppressed to `null` (with `lowSample: true`) when the
underlying sample is below `minN`, so small segments never yield misleadingly precise numbers.

### Computed utilities — $0.001 per call

Pure deterministic functions exposed as paid endpoints. The same key always returns the same
answer, forever — responses carry `deterministic: true`, so cache them client-side indefinitely.
Every response names the standard it implements. Malformed keys are rejected with a free `400`
before payment; for validators, `valid: false` is a legitimate _paid_ answer — you pay for the
verdict, not for the verdict being yes.

| Dataset           | Key                                                                    | Returns                                                                                                         |
| ----------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `util-vin`        | 17-char VIN                                                            | Structure validation, NA check digit, WMI region/manufacturer, model year candidates (ISO 3779/3780, FMVSS 565) |
| `util-uk-plate`   | UK registration plate                                                  | Format era, area code, age identifier, registration period (DVLA formats)                                       |
| `util-mot-due`    | `YYYY-MM-DD` first-registration date                                   | First MOT due date, now-due flag, 40-year historic exemption (GB MOT rules)                                     |
| `util-tyre-size`  | e.g. `205/55R16 91V` (encoded)                                         | Dimensions, overall diameter, load index → kg, speed rating → km/h (ETRTO)                                      |
| `util-iban`       | IBAN                                                                   | Per-country length + MOD 97-10 validity, country/BBAN parse (ISO 13616)                                         |
| `util-isin`       | ISIN                                                                   | Validity, country prefix, NSIN, Luhn check digit (ISO 6166)                                                     |
| `util-cusip`      | CUSIP                                                                  | Validity, issuer/issue split, mod-10 with `*` `@` `#` (ANSI X9.6)                                               |
| `util-sedol`      | SEDOL                                                                  | Validity, weighted mod-10 check digit (LSE)                                                                     |
| `util-lei`        | LEI                                                                    | Validity, MOD 97-10 check digits (ISO 17442)                                                                    |
| `util-card`       | Card number                                                            | Luhn validity + network detection by public prefix rules — structural only, not a BIN lookup (ISO/IEC 7812)     |
| `util-aba-rtn`    | 9-digit routing number                                                 | Validity, 3-7-1 weighted mod-10 (ABA)                                                                           |
| `util-gtin`       | GTIN-8/12/13/14, or `compute:<digits>`                                 | Validity + type; compute mode returns check digit and full code (GS1)                                           |
| `util-isbn`       | ISBN-10 or ISBN-13                                                     | Validity + bidirectional 10↔13 conversion (ISO 2108)                                                            |
| `util-issn`       | 8-char ISSN                                                            | Validity, weighted mod-11 check character (ISO 3297)                                                            |
| `util-container`  | e.g. `MSKU3068821`                                                     | Owner code, category, serial, check digit (ISO 6346)                                                            |
| `util-imo`        | 7-digit IMO number                                                     | Validity, weighted check digit (IMO scheme)                                                                     |
| `util-checkdigit` | `<luhn\|verhoeff\|damm\|mod97-10\|mod11-2>:<verify\|compute>:<digits>` | Verify → valid; compute → check digit + full value                                                              |
| `util-geo`        | `distance:lat1,lon1,lat2,lon2` or `destination:lat,lon,bearing,km`     | Great-circle km/mi/nm + bearing, or destination point (haversine)                                               |
| `util-geohash`    | `encode:lat,lon[,precision]` or `decode:<hash>`                        | Geohash string, or centre + bounding box                                                                        |

### Bundled reference lookups — $0.002 per call

Lookups against static reference-data snapshots shipped with the service, refreshed on a
cadence. Responses carry `deterministic: false`, `ttl_seconds` matching the refresh cadence,
and `data_generated_at` naming the snapshot date; `/v1/discover` names the upstream `data_source`.

| Dataset         | Key                                               | Returns                                                                                          | Refresh   |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------- |
| `util-oui`      | MAC or OUI prefix (`00:00:5E`)                    | Vendor name/country (IEEE OUI registry); flags locally-administered/multicast addresses          | ~30 days  |
| `util-airport`  | `LHR`, `EGLL`, `iata:LHR`, `icao:EGLL`            | Name, coordinates, elevation, country, municipality, scheduled service (OurAirports)             | ~30 days  |
| `util-tz`       | `zone:Europe/London[:2026-01-15]` or `country:GB` | UTC offset at a moment, DST status, abbreviation; or country zone list (IANA tzdb + runtime ICU) | ~90 days  |
| `util-currency` | `GBP` or `826`                                    | Name, minor units, using entities, withdrawn-code history (ISO 4217)                             | ~90 days  |
| `util-locode`   | `GBLON` or `GB:LON`                               | Place name, subdivision, function classifiers, coordinates (UNECE Rec 16)                        | ~180 days |

## Response envelope

Every successful paid response shares one envelope:

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

For cached datasets, `ttl_seconds`/`stale` reflect real cache state and `source` names the
upstream. For computed utilities, `ttl_seconds` is a 10-year sentinel (the answer never
expires) and `source` names the standard. For bundled utilities, `source` names the snapshot's
data source. The `deterministic` field appears on utility responses only.

## Errors

Errors return a structured body with a stable machine-readable `code` — branch on `code`, never
on `message` text:

```json
{
  "error": {
    "code": "INGEST_IN_PROGRESS",
    "message": "…",
    "retryable": true,
    "retry_after_seconds": 3,
    "docs_url": "…"
  }
}
```

| Code                        | Status | Retryable | Meaning                                                             |
| --------------------------- | ------ | --------- | ------------------------------------------------------------------- |
| `PAYMENT_INVALID`           | 402    | yes       | Re-sign from a fresh 402 challenge and retry                        |
| `PAYMENT_SETTLEMENT_FAILED` | 402    | yes       | On-chain settlement failed; retry                                   |
| `UNKNOWN_DATASET`           | 404    | no        | Not a recognised dataset — see `/v1/discover`                       |
| `ENTITY_NOT_FOUND`          | 404    | no        | Final result: no record exists (e.g. no MOT history for that plate) |
| `INGEST_IN_PROGRESS`        | 503    | yes       | Live fetch in flight — wait `retry_after_seconds`                   |
| `BUCKET_NOT_SEEDED`         | 404    | yes       | Analytics pipeline hasn't populated this segment yet                |

Utility routes additionally return a plain `400` for malformed keys **before any payment is
taken** — the message states the expected key format. Fix the key and retry; no funds have moved.

## Notes for agent developers

- Call `/v1/discover` before constructing a payment — prices can change without a redeploy.
- Use the free `/meta` route to check cache freshness before paying twice for the same cached
  lookup. Computed utility results never need a re-check: cache them forever.
- `ENTITY_NOT_FOUND` and `valid: false` are final answers, not failures. Don't retry them.
- There is no authentication and no provisioning — a funded Base wallet is the only prerequisite.
- Agent-readable docs: [`/llms.txt`](https://databroker.mossforge.dev/llms.txt). OpenClaw skills
  for the MOT history, MOT analytics, and utilities tiers live alongside this repo.

## Contact

[support@mossforge.dev](mailto:support@mossforge.dev) · Built by [Mossforge](https://mossforge.dev) ·
Powered by [x402](https://x402.org) on [Base](https://base.org)

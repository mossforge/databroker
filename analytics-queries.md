# Analytics query examples

Worked `curl` examples for each of the six `dvsa-mot-analytics` families. All require payment ($0.02 USDC) except where noted. These show the request only — see the [main README](../README.md#analytics-endpoint) for full sample response bodies.

Replace `paid-curl` below with however you're attaching an x402 payment — these are illustrative of the URL and key shape, not a working payment client. See [`examples/typescript/fetch-mot-history.ts`](./typescript/fetch-mot-history.ts) or [`examples/python/fetch_mot_history.py`](./python/fetch_mot_history.py) for a real paid request.

## reliability — pass rates and dangerous defects by make

```bash
paid-curl https://api.databroker.mossforge.dev/v1/dvsa-mot-analytics/reliability:ford
paid-curl https://api.databroker.mossforge.dev/v1/dvsa-mot-analytics/reliability:volkswagen
paid-curl https://api.databroker.mossforge.dev/v1/dvsa-mot-analytics/reliability:bmw
```

Use this to compare overall reliability across makes, or to see how a given make's pass rate degrades across age and mileage bands.

## mileage — annual mileage and clocking, by age band or exact year

```bash
# By age band — rolls up several registration-year cohorts
paid-curl https://api.databroker.mossforge.dev/v1/dvsa-mot-analytics/mileage:ford:5-8yr

# By exact registration year — no roll-up, single cohort
paid-curl https://api.databroker.mossforge.dev/v1/dvsa-mot-analytics/mileage:ford:2019
```

Age band is the more useful query for "is this car's mileage normal for its age" type questions, since it doesn't require knowing the exact registration year. Exact year is more useful for year-over-year trend analysis (e.g. comparing `mileage:ford:2018` against `mileage:ford:2019` to see whether average annual mileage has shifted).

## parc — fleet population by make, fuel, and age

```bash
paid-curl https://api.databroker.mossforge.dev/v1/dvsa-mot-analytics/parc:ford:diesel:5-8yr
paid-curl https://api.databroker.mossforge.dev/v1/dvsa-mot-analytics/parc:ford:petrol:5-8yr
paid-curl https://api.databroker.mossforge.dev/v1/dvsa-mot-analytics/parc:tesla:electric:0-3yr
```

Useful for market sizing — e.g. "how many 5-8 year old diesel Fords are still actively being tested in the UK" as a proxy for how many are still on the road.

## fuelmix — fuel type distribution by registration year

```bash
paid-curl https://api.databroker.mossforge.dev/v1/dvsa-mot-analytics/fuelmix:2015
paid-curl https://api.databroker.mossforge.dev/v1/dvsa-mot-analytics/fuelmix:2019
paid-curl https://api.databroker.mossforge.dev/v1/dvsa-mot-analytics/fuelmix:2023
```

Query several consecutive years to see how the UK's fuel mix has shifted over time — useful for tracking the EV/hybrid transition or diesel's declining new-registration share.

## colour — top vehicle colours by make and registration year

```bash
paid-curl https://api.databroker.mossforge.dev/v1/dvsa-mot-analytics/colour:ford:2019
paid-curl https://api.databroker.mossforge.dev/v1/dvsa-mot-analytics/colour:bmw:2019
```

Mostly a curiosity/market-research query — colour popularity by make and year, sourced from real DVSA registration data rather than manufacturer marketing claims.

## temporal — UK-wide monthly trends (no parameters)

```bash
paid-curl https://api.databroker.mossforge.dev/v1/dvsa-mot-analytics/temporal
```

The only family with no parameters — returns UK-wide test volume, pass rate, and MOT expiry density, all bucketed by calendar month. Useful for seasonality analysis (e.g. MOT test volume spikes around certificate expiry clusters) or as a baseline to compare a specific make/segment against the national average.

## Checking sample size before trusting a rate

Every response includes `minN` (the suppression threshold) and, if any rate was withheld, `lowSample: true`. For niche segments — an uncommon make crossed with an uncommon fuel type and a narrow age band — check for `null` values and the `lowSample` flag before treating a returned rate as meaningful:

```bash
paid-curl https://api.databroker.mossforge.dev/v1/dvsa-mot-analytics/parc:porsche:electric:0-3yr
```

```json
{
  "data": {
    "family": "parc",
    "make": "porsche",
    "fuel": "electric",
    "band": "0-3yr",
    "vehicleCount": 412,
    "recentlyTested": 380,
    "minN": 30
  }
}
```

`parc` returns raw counts only, so nothing here gets suppressed — but for `reliability` or `mileage` queries against a similarly narrow segment, expect to see `null` in place of a rate if the underlying `n` is below `minN`.

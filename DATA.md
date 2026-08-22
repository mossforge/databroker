# Data sources and licensing

The [LICENSE](./LICENSE.md) in this repository covers **the source code only**. The data
served by the DataBroker API is derived from third-party sources, each with its own terms.
This file records what those sources are and what obligations come with them.

If you consume the API, the terms below apply to the data you receive. If you spot an error
here, please open an issue.

---

## Summary

| Dataset            | Endpoint                       | Source                             | Licence                      | Attribution required |
| ------------------ | ------------------------------ | ---------------------------------- | ---------------------------- | -------------------- |
| MOT history        | `/v1/dvsa-mot/{reg}`           | DVSA MOT History API               | Open Government Licence v3.0 | **Yes**              |
| MOT analytics      | `/v1/dvsa-mot-analytics/{key}` | DVSA bulk MOT dataset              | Open Government Licence v3.0 | **Yes**              |
| MAC vendor         | `/v1/util-oui`                 | IEEE MA-L/MA-M/MA-S public listing | No copyright asserted        | No                   |
| Airports           | `/v1/util-airport`             | OurAirports                        | Public domain / CC0          | No                   |
| Time zones         | `/v1/util-tz`                  | IANA tz database                   | Public domain                | No                   |
| Currencies         | `/v1/util-currency`            | ISO 4217 code list                 | See note below               | See note below       |
| Locations          | `/v1/util-locode`              | UN/LOCODE (UNECE)                  | See note below               | See note below       |
| All other `util-*` | various                        | —                                  | No third-party data          | No                   |

---

## DVSA MOT data

**Source:** [DVSA MOT History API](https://documentation.history.mot.api.gov.uk/), accessed
under an approved API key, including the bulk/delta dataset used to compute analytics.

**Licence:** Open Government Licence v3.0. The Department for Transport's own data catalogue
lists the MOT history API under the free UK Open Government Licence.

**What OGL v3 permits:** copying, publishing, distributing, adapting and **commercially
exploiting** the information, including combining it with other data and including it in your
own products.

**What OGL v3 requires:** attribution. Any product built on this data must acknowledge the
source. The required form:

> Contains public sector information licensed under the Open Government Licence v3.0.
> Source: DVSA MOT history data.

Full licence text: <https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/>

**What OGL v3 does not permit:**

- Implying official status, or that DVSA or DfT endorses your use of the data
- Using the data in a way that misleads others or misrepresents it
- Using it in breach of data protection law

### Accuracy and freshness

MOT history is cached for 30 days; analytics are recomputed daily from the bulk dataset. Data
returned from this API may therefore lag the DVSA source. For anything where currency matters
verify against [the official service](https://www.gov.uk/check-mot-history). No warranty of
accuracy is given.

### Personal data

MOT records are vehicle records, not person records: the API returns no names, addresses or
keeper details. However, a registration plate can be linked to an individual by someone who
holds other information, so treat lookup results as potentially identifying in context.

If you are processing this data at scale, you are responsible for your own lawful basis under
UK GDPR. DVSA's own
[privacy notice](https://www.gov.uk/government/publications/dvsa-privacy-notices/mot-history-api-privacy-notice)
sets out that the data is intended for services, applications and research contributing to
improved road safety.

Do not use this API to build a surveillance tool, to track individuals by vehicle, or to
enrich profiles of identifiable people.

---

## IEEE OUI registry (`util-oui`)

**Source:** [IEEE Registration Authority public listings](https://standards.ieee.org/products-programs/regauth/)
(MA-L, MA-M, MA-S).

**Licence:** IEEE does not assert copyright in the OUI public listing and does not restrict
its distribution. IEEE does, however, strongly encourage users to obtain the listing directly
from IEEE and to refresh it regularly, to preserve the integrity of the information.

This API caches the listing for roughly 30 days. For authoritative vendor identification, go
to the IEEE source.

Note that "IEEE", "EUI-48" and "EUI-64" are IEEE trademarks. This project is not affiliated
with or endorsed by IEEE.

---

## OurAirports (`util-airport`)

**Source:** <https://ourairports.com/data/> (mirrored at `davidmegginson/ourairports-data`).

**Licence:** released to the public domain. Commercial use, modification and redistribution
are permitted with no attribution obligation. Attribution is offered here as courtesy, not
because it is required.

Supplied with no guarantee of accuracy or fitness for use. Do not use for navigation or any
safety-of-life purpose.

---

## IANA time zone database (`util-tz`)

**Source:** [IANA tz database](https://www.iana.org/time-zones), supplemented at runtime by
the ICU data bundled with Node.

**Licence:** the tz database is in the public domain.

Time zone rules change, sometimes at short notice. Offsets are computed for the moment you
request, but a cached response may not reflect a rule change published after it was cached.

---

## ISO 4217 currency codes (`util-currency`)

**Source:** the ISO 4217 currency code list.

Currency codes, names and minor-unit values are widely treated as factual reference data and
are redistributed by many projects. The published ISO 4217 _standard document_ is a separate
copyrighted work and is not reproduced here.

---

## UN/LOCODE (`util-locode`)

**Source:** [UNECE UN/LOCODE code list](https://unece.org/trade/cefact/UNLOCODE-Download).

UN/LOCODE is published by UNECE as a service to governments and trade partners and is made
freely downloadable. It is redistributed widely in open datasets.

---

## Endpoints with no third-party data

The majority of the `util-*` endpoints implement **published algorithms and format
specifications**, not datasets. They embed no third-party data and carry no attribution
obligation:

`util-vin`, `util-uk-plate`, `util-mot-due`, `util-tyre-size`, `util-iban`, `util-isin`,
`util-cusip`, `util-sedol`, `util-lei`, `util-card`, `util-aba-rtn`, `util-gtin`,
`util-isbn`, `util-issn`, `util-container`, `util-imo`, `util-checkdigit`, `util-geo`,
`util-geohash`

These compute check digits, validate structure and parse formats defined by public standards
(ISO 3779, ISO 13616, ISO 6166, ISO 2108, ISO 6346, GS1, ANSI X9.6 and others). The
algorithms are facts about a specification; the implementations are original work under this
repository's MIT licence.

Standards documents themselves are copyrighted by their respective bodies and are not
reproduced here.

`util-card` performs **structural** validation only. It is not a BIN lookup and uses no commercial BIN database.

---

## Reporting a problem

Believe something here is wrong, or that data is being redistributed without proper basis?
Open an issue or email <support@mossforge.dev>. Concerns of that kind are taken seriously
and acted on rather than argued with.

#!/usr/bin/env node
/**
 * databroker-mcp-server
 *
 * MCP server exposing MossForge DataBroker (pay-per-call UK open data)
 * to any MCP client. Payments are handled via x402 protocol v2 /
 * EIP-3009 USDC transfers on Base mainnet.
 *
 * IMPORTANT: this uses the @x402/* package family (protocol v2 - the
 * PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE header scheme),
 * NOT the older unscoped "x402-fetch" package, which speaks a different
 * (v1, X-PAYMENT-header) wire format and will not interoperate with a
 * server built on @x402/core/server as DataBroker's serving Lambda is.
 *
 * API surface (see DataBroker README + serving-layer.function.ts):
 *   GET  /v1/health                 - no payment, uptime check
 *   GET  /v1/discover               - no payment, lists enabled datasets + prices + kind
 *   GET  /v1/{dataset}/{key}        - x402-gated, fetches a datapoint
 *   GET  /v1/{dataset}/{key}/meta   - no payment, staleness/TTL/source info
 *   POST /v1/{dataset}/batch        - x402-gated, ONE payment for N keys (on-demand datasets only)
 *   GET  /v1/batch/{jobId}          - no payment, poll a batch job's status/results
 *
 * The quote/cap/formatting logic lives in lib.ts, kept free of env vars, the
 * MCP SDK, and process.exit so it can be unit tested with mocked fetches
 * (see lib.test.ts). This file is just startup wiring: read env vars, build
 * a real signer + paying fetch, wire lib.ts's callDataBroker to the six
 * MCP tools, and start the stdio transport.
 *
 * SIGNER PROVIDERS - who actually holds/uses the private key:
 *   DATABROKER_SIGNER=raw (default) - a private key you hold, read from
 *     DATABROKER_WALLET_KEY. Zero setup beyond a funded wallet, but the key
 *     material is only as safe as this process's environment - anything
 *     with filesystem/shell access to this host can read it, and any spend
 *     cap is enforced by this codebase, not by a third party.
 *   DATABROKER_SIGNER=cdp - pays from a Coinbase CDP-managed wallet. No
 *     private key ever touches this process; CDP's infrastructure signs
 *     remotely and can enforce spend policies (session caps, allowed
 *     tokens) at the custodian layer, not just in this code. Requires a
 *     CDP account and CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET.
 *     The @coinbase/cdp-sdk package is only imported when this mode is
 *     selected, so raw-mode users never need to install it.
 *
 * Adding another provider (Turnkey, Privy, Fireblocks, ...): extend
 * SignerConfig + resolveSignerConfig in lib.ts, and add a matching branch
 * below that constructs an x402Client-compatible signer for it. Nothing
 * else in this file or in lib.ts needs to change.
 *
 * Env vars:
 *   DATABROKER_BASE_URL   Base URL of the DataBroker API (required)
 *   DATABROKER_SIGNER     "raw" (default) or "cdp" - see above
 *   DATABROKER_WALLET_KEY 0x-prefixed private key (required when SIGNER=raw)
 *   CDP_API_KEY_ID         CDP API key id (required when SIGNER=cdp)
 *   CDP_API_KEY_SECRET     CDP API key secret (required when SIGNER=cdp)
 *   CDP_WALLET_SECRET      CDP wallet secret (required when SIGNER=cdp)
 *   DATABROKER_MAX_USDC   Per-call spend cap in USDC (default: 0.50) - note
 *     this cap is enforced by THIS codebase regardless of signer; with
 *     DATABROKER_SIGNER=cdp you can additionally configure a policy in the
 *     CDP dashboard that's enforced independently of this process.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createCallDataBroker, toToolResponse, encodeSegment, resolveSignerConfig } from "./lib.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The MCP server's reported version comes from package.json, not a
// hand-maintained string here - this file lives at src/index.ts in dev (run
// via tsx) and dist/index.js once built, and package.json sits one level up
// from both, so the same relative path resolves correctly either way.
const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: SERVER_VERSION } = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8")
) as { version: string };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = (process.env.DATABROKER_BASE_URL ?? "").replace(/\/+$/, "");
const MAX_USDC = Number(process.env.DATABROKER_MAX_USDC ?? "0.50");

if (!Number.isFinite(MAX_USDC) || MAX_USDC <= 0) {
  console.error(
    `DATABROKER_MAX_USDC must be a positive number of USDC (e.g. "0.50"), got: ` +
    `${JSON.stringify(process.env.DATABROKER_MAX_USDC)}`
  );
  process.exit(1);
}

if (!BASE_URL) {
  console.error("DATABROKER_BASE_URL is required");
  process.exit(1);
}

// resolveSignerConfig (in lib.ts) validates env vars for whichever provider
// was selected and throws a clear error naming what's missing - it does no
// crypto/SDK work itself, so it's unit-tested directly (see lib.test.ts).
let signerConfig: ReturnType<typeof resolveSignerConfig>;
try {
  signerConfig = resolveSignerConfig(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// USDC has 6 decimals.
const maxAtomic = BigInt(Math.round(MAX_USDC * 1_000_000));

// x402client is deliberately `any` here, not InstanceType<typeof x402Client>.
// This is a narrow, intentional type-safety trade-off at one boundary, not a
// general downgrade: if @coinbase/cdp-sdk resolves its own nested copy of
// @x402/core (a real possibility if npm can't dedupe it against the copy
// this package depends on directly), TypeScript treats the two packages'
// x402Client declarations as nominally distinct - even though they're
// structurally identical and interoperate correctly at runtime - because
// private class fields are branded per-declaration, not per-shape. That's
// what "Types have separate declarations of a private property" means; it
// is not a real incompatibility. `any` here sidesteps the mismatch at
// exactly the one line where it can occur; every other variable and every
// tool below stays fully typed.
let x402client: any; // eslint-disable-line @typescript-eslint/no-explicit-any
let walletLabel: string; // for startup logging / error messages only

if (signerConfig.type === "cdp") {
  // Dynamic import, loosely typed for the same reason as x402client above -
  // raw-mode users (the default) never need this package installed, and
  // never need a CDP account, to run this server.
  let CdpX402Client: new () => any;
  try {
    ({ CdpX402Client } = await import("@coinbase/cdp-sdk/x402"));
  } catch (err) {
    console.error(
      "DATABROKER_SIGNER=cdp requires the @coinbase/cdp-sdk package. " +
      "Install it with: npm install @coinbase/cdp-sdk"
    );
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  // CdpX402Client reads CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET
  // from process.env itself (already validated present by resolveSignerConfig
  // above) and extends x402Client, so it drops straight into wrapFetchWithPayment.
  // UNVERIFIED against a live install at the time this was written - confirm
  // the zero-arg constructor and env var names against your installed
  // @coinbase/cdp-sdk version before relying on this in production.
  x402client = new CdpX402Client();
  walletLabel = "CDP-managed wallet (see your CDP Portal dashboard for the address and to configure spend policies)";
} else {
  const account = privateKeyToAccount(signerConfig.walletKey as `0x${string}`);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  x402client = client;
  walletLabel = account.address;
}

const payingFetch = wrapFetchWithPayment(fetch, x402client);

// callDataBroker's cap-enforcement, quote/confirm flow, and formatting all
// live in lib.ts (see lib.test.ts for coverage) - this just wires it up with
// the real fetch implementations and whichever signer was selected above.
const callDataBroker = createCallDataBroker({
  baseUrl: BASE_URL,
  maxAtomic,
  maxUsdcLabel: String(MAX_USDC),
  walletAddress: walletLabel,
  plainFetch: fetch,
  payingFetch,
});

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "databroker-mcp-server",
  version: SERVER_VERSION,
});

server.registerTool(
  "databroker_discover",
  {
    title: "List DataBroker datasets and prices",
    description: `List the currently enabled DataBroker datasets, their USDC prices, and descriptions. FREE call - no payment made. Always call this first if you don't know which dataset id to use, or what a call will cost.

Each entry includes a "kind": "cached" (per-entity data backed by an ingestor/pipeline, e.g. "dvsa-mot" or "dvsa-mot-analytics"), "computed" (a pure deterministic function, no caching, never stale), or "bundled" (served from a static snapshot shipped with the API, refreshed on a cadence). Computed/bundled entries also include a "standard" field describing what the key represents.

Returns: JSON list of enabled datasets with dataset_id, description, price_usdc, scheme, network, and kind.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    const result = await callDataBroker("/v1/discover", { confirm: true }); // never payment-gated
    return toToolResponse(result);
  }
);

server.registerTool(
  "databroker_fetch",
  {
    title: "Fetch a DataBroker datapoint",
    description: `Fetch a single datapoint from MossForge DataBroker for a given dataset and key. This is the main data-access tool.

PAYMENT FLOW - two steps, never skippable: call this WITHOUT confirm (or confirm: false) first. If the dataset is paid, you'll get back a quote showing the exact USDC price - NOTHING IS PAID at this point. If you want to proceed, call again with the same dataset/key and confirm: true, and the payment (capped by DATABROKER_MAX_USDC - calls priced above the cap are declined before any payment is made) is made automatically. Tell the user the quoted price before setting confirm: true, unless they've already told you to proceed with paid calls without asking each time.

Call databroker_discover first if you're not sure which dataset id to use, or to see each dataset's "kind" - the key format below depends on it.

KEY FORMATS BY DATASET (non-exhaustive - always defer to databroker_discover for the current catalogue):
  - "dvsa-mot" (cached, per-vehicle): key is a UK VRM, e.g. "AB12CDE". The response's "data" includes a "vehicle" block, a "summary" block (latest test result/date, total tests), and an "integrity" block covering mileage clocking/anomaly detection - integrity.readings (mileage reading count), integrity.clocked (boolean), integrity.anomalies (array of flagged discrepancies), integrity.avgAnnualMiles. Check integrity when the user is asking about mileage trustworthiness, not just raw MOT pass/fail history.
  - "dvsa-mot-analytics" (cached, aggregate/cohort - NOT per-vehicle): key is a colon-delimited logical key:
      reliability:<make>                    e.g. "reliability:ford"
      mileage:<make>:<band|year>            band e.g. "mileage:ford:5-8yr", year e.g. "mileage:ford:2019"
      parc:<make>:<fuel>:<band|year>        e.g. "parc:ford:diesel:5-8yr"
      fuelmix:<year>                        e.g. "fuelmix:2022"
      colour:<make>:<year>                  e.g. "colour:ford:2022"
      temporal                              no args - overall pass-rate trend
    Valid age bands: 0-3yr, 3-5yr, 5-8yr, 8-12yr, 12yr+. Valid fuel types: petrol, diesel, electric, hybrid, other.
    Rates/percentiles in the response may come back null with lowSample: true when the underlying sample is too small to publish safely - this is a valid, expected response, not an error.
  - Datasets with "kind": "computed" or "bundled" in databroker_discover: key is whatever single logical input the tool computes over - check that dataset's "standard" field.

If you're unsure of the exact key grammar for a dataset you haven't used before, try databroker_meta first (it's free) - a well-formed key returns metadata, a malformed one returns a 400 telling you the expected format, without spending anything.

Args:
  - dataset (string): Dataset id exactly as returned by databroker_discover, e.g. "dvsa-mot".
  - key (string): Entity key within that dataset - format depends on the dataset, see above.
  - confirm (boolean, default false): Set true only after you've quoted the price and the user (or your standing instructions) has approved spending it. Leaving this false costs nothing and returns the price.

Returns: on confirm=false, a price quote (no data). On confirm=true, the JSON response envelope - { dataset, key, data, fetched_at, fetch_status, source, ttl_seconds, stale }.`,
    inputSchema: {
      dataset: z
        .string()
        .min(1)
        .max(60)
        .describe('Dataset id, e.g. "dvsa-mot" (see databroker_discover for the current list)'),
      key: z
        .string()
        .min(1)
        .max(120)
        .describe('Entity key within the dataset - format varies by dataset, see tool description'),
      confirm: z
        .boolean()
        .optional()
        .describe("Set true to actually pay and fetch data, after quoting the price to the user. Defaults to false (quote only, no payment)."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ dataset, key, confirm }) => {
    const result = await callDataBroker(
      `/v1/${encodeSegment(dataset)}/${encodeSegment(key)}`,
      { confirm: confirm ?? false }
    );
    return toToolResponse(result);
  }
);

server.registerTool(
  "databroker_meta",
  {
    title: "Check DataBroker datapoint freshness",
    description: `Check the staleness/TTL/source metadata for a datapoint WITHOUT fetching or paying for the underlying data. FREE call - no payment made. Useful to check whether a cached datapoint is fresh before deciding to pay for databroker_fetch, or to validate a key's shape for free before spending on a dataset you're unfamiliar with.

For "computed" and "bundled" datasets this returns an honest note explaining there's nothing to cache (computed) or the snapshot refresh cadence (bundled), rather than TTL/staleness data.

Args:
  - dataset (string): Dataset id, e.g. "dvsa-mot".
  - key (string): Entity key within that dataset - same format as databroker_fetch.

Returns: JSON metadata - staleness, ttl_seconds, source, last_fetched (or kind/standard/note for computed/bundled datasets).`,
    inputSchema: {
      dataset: z.string().min(1).max(60).describe('Dataset id, e.g. "dvsa-mot"'),
      key: z.string().min(1).max(120).describe("Entity key within the dataset"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ dataset, key }) => {
    const result = await callDataBroker(
      `/v1/${encodeSegment(dataset)}/${encodeSegment(key)}/meta`,
      { confirm: true } // never payment-gated
    );
    return toToolResponse(result);
  }
);

server.registerTool(
  "databroker_health",
  {
    title: "Check DataBroker API health",
    description: `Check whether the DataBroker API is up. FREE call - no payment made, always returns 200 when the service is healthy.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    const result = await callDataBroker("/v1/health", { confirm: true }); // never payment-gated
    return toToolResponse(result);
  }
);

server.registerTool(
  "databroker_batch_create",
  {
    title: "Create a DataBroker batch job",
    description: `Fetch MANY keys from a single on-demand cached dataset (e.g. "dvsa-mot") in one job, with ONE payment covering all of them, instead of paying per key. Only works for datasets that support on-demand ingestion - NOT "dvsa-mot-analytics" (pipeline-populated) or computed/bundled datasets, which will reject batch requests. Use databroker_fetch for those, or for one-off single-key lookups.

PAYMENT FLOW - two steps, never skippable: call this WITHOUT confirm (or confirm: false) first. Total price = per-key price x number of unique keys (duplicates in your list are deduplicated and only charged once). You'll get back a quote showing the exact USDC total - NOTHING IS PAID at this point, and the job is NOT created yet. If you want to proceed, call again with the same dataset/keys and confirm: true, and the payment (capped by DATABROKER_MAX_USDC - totals above the cap are declined before any payment is made) is made and the job created. Tell the user the quoted total before setting confirm: true, unless they've already told you to proceed with paid calls without asking each time. Maximum 100 keys per batch; split larger sets across multiple calls.

Once confirmed and created, returns immediately (202) with a job_id and a status_url - poll it with databroker_batch_status (free) until complete. Already-cached/fresh keys may come back complete right away; the rest are fetched in the background.

Args:
  - dataset (string): Dataset id that supports on-demand fetching, e.g. "dvsa-mot".
  - keys (string array): 1-100 entity keys, e.g. VRMs for "dvsa-mot".
  - confirm (boolean, default false): Set true only after you've quoted the total and the user (or your standing instructions) has approved spending it. Leaving this false costs nothing and creates no job.

Returns: on confirm=false, a price quote (no job created). On confirm=true, JSON - { job_id, status_url, keys_accepted, keys_deduplicated, price_usdc_total, complete, pending, expires_at }.`,
    inputSchema: {
      dataset: z
        .string()
        .min(1)
        .max(60)
        .describe('Dataset id that supports on-demand fetching, e.g. "dvsa-mot"'),
      keys: z
        .array(z.string().min(1).max(64))
        .min(1)
        .max(100)
        .describe("1-100 entity keys to fetch in this batch"),
      confirm: z
        .boolean()
        .optional()
        .describe("Set true to actually pay and create the job, after quoting the total to the user. Defaults to false (quote only, no payment, no job created)."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ dataset, keys, confirm }) => {
    const result = await callDataBroker(`/v1/${encodeSegment(dataset)}/batch`, {
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys }),
      },
      confirm: confirm ?? false,
    });
    return toToolResponse(result);
  }
);

server.registerTool(
  "databroker_batch_status",
  {
    title: "Poll a DataBroker batch job",
    description: `Poll the status of a batch job created by databroker_batch_create. FREE call - no payment made (payment already happened at job creation). Returns per-key state: "complete" (data included inline), "pending" (still fetching - poll again shortly), or "not_found" (valid key, no record exists - this is a final result, not an error). Jobs expire 24 hours after creation.

Args:
  - jobId (string): The job_id returned by databroker_batch_create.

Returns: JSON - { job_id, dataset, status, total, complete, pending, results: [...] }.`,
    inputSchema: {
      jobId: z.string().min(1).max(64).describe("The job_id returned by databroker_batch_create"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ jobId }) => {
    const result = await callDataBroker(`/v1/batch/${encodeSegment(jobId)}`, { confirm: true }); // never payment-gated
    return toToolResponse(result);
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `databroker-mcp-server ready - signer: ${signerConfig.type}, wallet: ${walletLabel}, cap: ${MAX_USDC} USDC/call`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
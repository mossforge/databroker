#!/usr/bin/env node
/**
 * databroker-mcp-server
 *
 * MCP server exposing MossForge DataBroker (pay-per-call UK open data)
 * to any MCP client. Payments are handled transparently via x402 /
 * EIP-3009 USDC transfers on Base mainnet using a local wallet key.
 *
 * Env vars:
 *   DATABROKER_BASE_URL   Base URL of the DataBroker API (required)
 *   DATABROKER_WALLET_KEY 0x-prefixed private key of the paying wallet (required)
 *   DATABROKER_MAX_USDC   Per-call spend cap in USDC (default: 0.50)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "x402-fetch";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = (process.env.DATABROKER_BASE_URL ?? "").replace(/\/+$/, "");
const WALLET_KEY = process.env.DATABROKER_WALLET_KEY ?? "";
const MAX_USDC = Number(process.env.DATABROKER_MAX_USDC ?? "0.50");

if (!BASE_URL) {
  console.error("DATABROKER_BASE_URL is required");
  process.exit(1);
}
if (!/^0x[0-9a-fA-F]{64}$/.test(WALLET_KEY)) {
  console.error("DATABROKER_WALLET_KEY must be a 0x-prefixed 32-byte hex private key");
  process.exit(1);
}

const account = privateKeyToAccount(WALLET_KEY as `0x${string}`);

// USDC has 6 decimals; x402-fetch takes the cap in atomic units.
const maxAtomic = BigInt(Math.round(MAX_USDC * 1_000_000));
const payingFetch = wrapFetchWithPayment(fetch, account, maxAtomic);

// ---------------------------------------------------------------------------
// Shared request helper
// ---------------------------------------------------------------------------

const CHARACTER_LIMIT = 40_000;

interface CallResult {
  ok: boolean;
  status: number;
  paid: boolean;
  body: string;
}

async function callDataBroker(
  path: string,
  query?: Record<string, string | number | boolean | undefined>
): Promise<CallResult> {
  const url = new URL(`${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  let res: Response;
  try {
    res = await payingFetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // x402-fetch throws when the price exceeds the cap or the wallet
    // can't cover it - surface that clearly to the agent.
    return {
      ok: false,
      status: 0,
      paid: false,
      body:
        `Request failed before completion: ${msg}. ` +
        `If this mentions payment limits, the endpoint price may exceed the ` +
        `DATABROKER_MAX_USDC cap (currently ${MAX_USDC} USDC) or the wallet ` +
        `(${account.address}) may need funding with USDC on Base mainnet.`,
    };
  }

  const paid = res.headers.has("x-payment-response");
  let body = await res.text();
  if (body.length > CHARACTER_LIMIT) {
    body =
      body.slice(0, CHARACTER_LIMIT) +
      `\n...[truncated at ${CHARACTER_LIMIT} chars - use a more specific query]`;
  }

  return { ok: res.ok, status: res.status, paid, body };
}

function toToolResponse(result: CallResult) {
  const prefix = result.ok
    ? result.paid
      ? "[paid call succeeded]\n"
      : "[free call succeeded]\n"
    : `[error - HTTP ${result.status}]\n`;
  return {
    content: [{ type: "text" as const, text: prefix + result.body }],
    isError: !result.ok,
  };
}

// ---------------------------------------------------------------------------
// Server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "databroker-mcp-server",
  version: "0.1.0",
});

server.registerTool(
  "databroker_vehicle_report",
  {
    title: "UK Vehicle MOT Report",
    description: `Fetch a full per-vehicle report for a UK registration (VRM) from MossForge DataBroker. Includes MOT test history, advisories, mileage integrity / clocking detection, and cohort comparison against similar vehicles.

This is a PAID call: a small USDC micropayment on Base mainnet is made automatically (capped by DATABROKER_MAX_USDC). Use it when the user asks about a specific car - e.g. pre-purchase checks, MOT history, whether mileage looks genuine.

Args:
  - vrm (string): UK vehicle registration mark, e.g. "AB18CDE". Spaces are ignored.

Returns: JSON report with MOT history, advisory details, mileage timeline and integrity flags, and cohort statistics.`,
    inputSchema: {
      vrm: z
        .string()
        .min(2)
        .max(10)
        .describe('UK registration, e.g. "AB18 CDE"'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ vrm }) => {
    const clean = vrm.replace(/\s+/g, "").toUpperCase();
    const result = await callDataBroker(`/v1/vehicle/${encodeURIComponent(clean)}`);
    return toToolResponse(result);
  }
);

server.registerTool(
  "databroker_uk_analysis",
  {
    title: "UK-wide MOT Analysis",
    description: `Fetch UK-wide MOT analytics from MossForge DataBroker: pass/fail rates, failure modes, and reliability statistics by make, model, and cohort.

This is a PAID call (USDC micropayment on Base, auto-handled). Use it for questions about vehicle reliability in general - e.g. "which makes fail MOTs most", "how reliable are 2016 diesels".

Args:
  - make (string, optional): Canonical vehicle make to filter by, e.g. "FORD".
  - model (string, optional): Model to filter by.
  - year (number, optional): First-registration year cohort.

Returns: JSON analytics for the requested cohort, or headline UK-wide figures when no filters given.`,
    inputSchema: {
      make: z.string().max(40).optional().describe('Vehicle make, e.g. "FORD"'),
      model: z.string().max(60).optional().describe("Vehicle model"),
      year: z.number().int().min(1980).max(2030).optional().describe("Registration year"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ make, model, year }) => {
    const result = await callDataBroker("/v1/analysis/uk", { make, model, year });
    return toToolResponse(result);
  }
);

server.registerTool(
  "databroker_call",
  {
    title: "Call any DataBroker endpoint",
    description: `Generic GET against any MossForge DataBroker endpoint, with x402 payment handled automatically. Use this for endpoints not covered by the dedicated tools - e.g. the Companies House / GLEIF entity spine or utility compute endpoints. Call databroker_catalogue first if you don't know which paths exist.

Payments are capped per-call by DATABROKER_MAX_USDC; calls priced above the cap fail safely without paying.

Args:
  - path (string): Endpoint path, e.g. "/v1/entity/12345678".
  - query (object, optional): Query parameters as string key/value pairs.

Returns: Raw response body (JSON where the endpoint returns JSON).`,
    inputSchema: {
      path: z
        .string()
        .min(1)
        .max(300)
        .regex(/^\/[^\s]*$/, "path must start with / and contain no spaces")
        .describe('Endpoint path, e.g. "/v1/entity/12345678"'),
      query: z.record(z.string(), z.string()).optional().describe("Query parameters"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ path, query }) => {
    const result = await callDataBroker(path, query);
    return toToolResponse(result);
  }
);

server.registerTool(
  "databroker_catalogue",
  {
    title: "List DataBroker endpoints and prices",
    description: `List the available DataBroker endpoints with their USDC prices. FREE call - no payment made. Use this first when unsure what data is available or what a call will cost.

Returns: JSON catalogue of endpoints, descriptions, and per-call prices.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    const result = await callDataBroker("/v1/catalogue");
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
    `databroker-mcp-server ready - wallet ${account.address}, cap ${MAX_USDC} USDC/call`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

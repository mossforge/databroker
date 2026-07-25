
import { describe, it, expect, vi } from "vitest";
import {
    formatUsdc,
    pickRequirement,
    amountExceedsCap,
    encodeSegment,
    createCallDataBroker,
    toToolResponse,
    resolveSignerConfig,
    type FetchLike,
    type CallResult,
} from "../src/lib.js";

// ---------------------------------------------------------------------------
// formatUsdc
// ---------------------------------------------------------------------------

describe("formatUsdc", () => {
    it("formats sub-dollar atomic amounts", () => {
        expect(formatUsdc("5000")).toBe("0.005");
    });

    it("formats whole dollar amounts with no trailing decimal", () => {
        expect(formatUsdc("1000000")).toBe("1");
    });

    it("formats amounts with a partial fraction, trimming trailing zeros", () => {
        expect(formatUsdc("1500000")).toBe("1.5");
    });

    it("formats zero", () => {
        expect(formatUsdc("0")).toBe("0");
    });

    it("returns the input unchanged when unparseable", () => {
        expect(formatUsdc("not-a-number")).toBe("not-a-number");
    });
});

// ---------------------------------------------------------------------------
// pickRequirement
// ---------------------------------------------------------------------------

describe("pickRequirement", () => {
    it("prefers the eip155:8453 (Base mainnet) entry when multiple networks are offered", () => {
        const body = {
            accepts: [
                { network: "eip155:84532", amount: "1000" },
                { network: "eip155:8453", amount: "2000" },
            ],
        };
        expect(pickRequirement(body)?.network).toBe("eip155:8453");
        expect(pickRequirement(body)?.amount).toBe("2000");
    });

    it("falls back to the first entry when Base mainnet isn't offered", () => {
        const body = { accepts: [{ network: "eip155:84532", amount: "1000" }] };
        expect(pickRequirement(body)?.network).toBe("eip155:84532");
    });

    it("returns undefined when accepts is missing or empty", () => {
        expect(pickRequirement({})).toBeUndefined();
        expect(pickRequirement({ accepts: [] })).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// amountExceedsCap
// ---------------------------------------------------------------------------

describe("amountExceedsCap", () => {
    it("returns false when the amount is under the cap", () => {
        expect(amountExceedsCap(5_000n, 500_000n)).toBe(false);
    });

    it("returns false when the amount equals the cap", () => {
        expect(amountExceedsCap(500_000n, 500_000n)).toBe(false);
    });

    it("returns true when the amount exceeds the cap", () => {
        expect(amountExceedsCap(500_001n, 500_000n)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// encodeSegment
// ---------------------------------------------------------------------------

describe("encodeSegment", () => {
    it("passes through simple alphanumeric segments", () => {
        expect(encodeSegment("dvsa-mot")).toBe("dvsa-mot");
    });

    it("encodes colons and special characters used in analytics keys", () => {
        expect(encodeSegment("mileage:ford:5-8yr")).toBe(
            encodeURIComponent("mileage:ford:5-8yr")
        );
    });
});

// ---------------------------------------------------------------------------
// callDataBroker - built via createCallDataBroker with mocked fetches
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.databroker.mossforge.dev";
const WALLET = "0xTestWallet";
const CAP_ATOMIC = 500_000n; // 0.50 USDC

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function makeDeps(overrides: { plainFetch?: FetchLike; payingFetch?: FetchLike } = {}) {
    const plainFetch = overrides.plainFetch ?? vi.fn();
    const payingFetch = overrides.payingFetch ?? vi.fn();
    return {
        deps: {
            baseUrl: BASE_URL,
            maxAtomic: CAP_ATOMIC,
            maxUsdcLabel: "0.50",
            walletAddress: WALLET,
            plainFetch,
            payingFetch,
        },
        plainFetch,
        payingFetch,
    };
}

describe("callDataBroker - free routes", () => {
    it("returns paymentState 'free' for a non-402 response and never touches payingFetch", async () => {
        const plainFetch = vi.fn().mockResolvedValue(jsonResponse(200, { status: "ok" }));
        const payingFetch = vi.fn();
        const { deps } = makeDeps({ plainFetch, payingFetch });
        const callDataBroker = createCallDataBroker(deps);

        const result = await callDataBroker("/v1/health");

        expect(result.paymentState).toBe("free");
        expect(result.ok).toBe(true);
        expect(result.status).toBe(200);
        expect(payingFetch).not.toHaveBeenCalled();
    });

    it("surfaces a network failure on the probe without ever calling payingFetch", async () => {
        const plainFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
        const payingFetch = vi.fn();
        const { deps } = makeDeps({ plainFetch, payingFetch });
        const callDataBroker = createCallDataBroker(deps);

        const result = await callDataBroker("/v1/health");

        expect(result.paymentState).toBe("free");
        expect(result.ok).toBe(false);
        expect(result.status).toBe(0);
        expect(result.body).toContain("ECONNREFUSED");
        expect(payingFetch).not.toHaveBeenCalled();
    });

    it("fails closed (paymentState 'free', ok false) when a 402 challenge has no parseable amount", async () => {
        const plainFetch = vi.fn().mockResolvedValue(jsonResponse(402, { accepts: [] }));
        const payingFetch = vi.fn();
        const { deps } = makeDeps({ plainFetch, payingFetch });
        const callDataBroker = createCallDataBroker(deps);

        const result = await callDataBroker("/v1/dvsa-mot/AB12CDE");

        expect(result.paymentState).toBe("free");
        expect(result.ok).toBe(false);
        expect(result.status).toBe(402);
        expect(payingFetch).not.toHaveBeenCalled();
    });
});

describe("callDataBroker - quote (confirm: false / omitted)", () => {
    it("returns a quote and does NOT call payingFetch when confirm is omitted", async () => {
        const plainFetch = vi
            .fn()
            .mockResolvedValue(jsonResponse(402, { accepts: [{ network: "eip155:8453", amount: "5000" }] }));
        const payingFetch = vi.fn();
        const { deps } = makeDeps({ plainFetch, payingFetch });
        const callDataBroker = createCallDataBroker(deps);

        const result = await callDataBroker("/v1/dvsa-mot/AB12CDE");

        expect(result.paymentState).toBe("quoted");
        expect(result.ok).toBe(true); // quotable within cap - not an error, just unpaid
        expect(result.amountAtomic).toBe("5000");
        expect(result.body).toContain("0.005 USDC");
        expect(result.body).toContain("has not been paid");
        expect(payingFetch).not.toHaveBeenCalled();
    });

    it("returns a quote and does NOT call payingFetch when confirm is explicitly false", async () => {
        const plainFetch = vi
            .fn()
            .mockResolvedValue(jsonResponse(402, { accepts: [{ network: "eip155:8453", amount: "20000" }] }));
        const payingFetch = vi.fn();
        const { deps } = makeDeps({ plainFetch, payingFetch });
        const callDataBroker = createCallDataBroker(deps);

        const result = await callDataBroker("/v1/dvsa-mot-analytics/reliability:ford", {
            confirm: false,
        });

        expect(result.paymentState).toBe("quoted");
        expect(payingFetch).not.toHaveBeenCalled();
    });

    it("declines (does not quote as payable) when the price exceeds the cap, even with confirm: true", async () => {
        // Price (600,000 atomic = 0.60 USDC) exceeds the 0.50 USDC cap.
        const plainFetch = vi
            .fn()
            .mockResolvedValue(jsonResponse(402, { accepts: [{ network: "eip155:8453", amount: "600000" }] }));
        const payingFetch = vi.fn();
        const { deps } = makeDeps({ plainFetch, payingFetch });
        const callDataBroker = createCallDataBroker(deps);

        const result = await callDataBroker("/v1/dvsa-mot/AB12CDE", { confirm: true });

        expect(result.paymentState).toBe("quoted");
        expect(result.ok).toBe(false);
        expect(result.status).toBe(402);
        expect(result.body).toContain("exceeds");
        expect(payingFetch).not.toHaveBeenCalled();
    });
});

describe("callDataBroker - pay (confirm: true, within cap)", () => {
    it("calls payingFetch and returns paymentState 'paid' with the data", async () => {
        const plainFetch = vi
            .fn()
            .mockResolvedValue(jsonResponse(402, { accepts: [{ network: "eip155:8453", amount: "5000" }] }));
        const payingFetch = vi
            .fn()
            .mockResolvedValue(jsonResponse(200, { dataset: "dvsa-mot", key: "AB12CDE", data: { ok: true } }));
        const { deps } = makeDeps({ plainFetch, payingFetch });
        const callDataBroker = createCallDataBroker(deps);

        const result = await callDataBroker("/v1/dvsa-mot/AB12CDE", { confirm: true });

        expect(result.paymentState).toBe("paid");
        expect(result.ok).toBe(true);
        expect(result.amountAtomic).toBe("5000");
        expect(result.body).toContain('"dataset":"dvsa-mot"'.replace(/"/g, '"')); // sanity - body is passed through
        expect(payingFetch).toHaveBeenCalledTimes(1);
        expect(payingFetch).toHaveBeenCalledWith(
            `${BASE_URL}/v1/dvsa-mot/AB12CDE`,
            expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) })
        );
    });

    it("passes POST method/body through to both the probe and the paying fetch (batch create)", async () => {
        const plainFetch = vi
            .fn()
            .mockResolvedValue(jsonResponse(402, { accepts: [{ network: "eip155:8453", amount: "10000" }] }));
        const payingFetch = vi
            .fn()
            .mockResolvedValue(jsonResponse(202, { job_id: "abc-123" }));
        const { deps } = makeDeps({ plainFetch, payingFetch });
        const callDataBroker = createCallDataBroker(deps);

        const init: RequestInit = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ keys: ["AB12CDE", "XY99ZZZ"] }),
        };
        const result = await callDataBroker("/v1/dvsa-mot/batch", { init, confirm: true });

        expect(result.paymentState).toBe("paid");
        expect(plainFetch).toHaveBeenCalledWith(`${BASE_URL}/v1/dvsa-mot/batch`, expect.objectContaining({ method: "POST" }));
        expect(payingFetch).toHaveBeenCalledWith(`${BASE_URL}/v1/dvsa-mot/batch`, expect.objectContaining({ method: "POST" }));
    });

    it("returns paymentState 'quoted' with an error when the paying fetch itself throws (e.g. facilitator rejection)", async () => {
        const plainFetch = vi
            .fn()
            .mockResolvedValue(jsonResponse(402, { accepts: [{ network: "eip155:8453", amount: "5000" }] }));
        const payingFetch = vi.fn().mockRejectedValue(new Error("insufficient funds"));
        const { deps } = makeDeps({ plainFetch, payingFetch });
        const callDataBroker = createCallDataBroker(deps);

        const result = await callDataBroker("/v1/dvsa-mot/AB12CDE", { confirm: true });

        expect(result.paymentState).toBe("quoted");
        expect(result.ok).toBe(false);
        expect(result.status).toBe(0);
        expect(result.body).toContain("insufficient funds");
        expect(result.body).toContain(WALLET);
    });
});

describe("callDataBroker - response body truncation", () => {
    it("truncates response bodies longer than the configured character limit", async () => {
        const bigBody = "x".repeat(100);
        const plainFetch = vi.fn().mockResolvedValue(new Response(bigBody, { status: 200 }));
        const payingFetch = vi.fn();
        const deps = {
            baseUrl: BASE_URL,
            maxAtomic: CAP_ATOMIC,
            maxUsdcLabel: "0.50",
            walletAddress: WALLET,
            plainFetch,
            payingFetch,
            characterLimit: 20,
        };
        const callDataBroker = createCallDataBroker(deps);

        const result = await callDataBroker("/v1/discover");

        expect(result.body.length).toBeLessThan(bigBody.length);
        expect(result.body).toContain("truncated");
    });
});

// ---------------------------------------------------------------------------
// toToolResponse
// ---------------------------------------------------------------------------

describe("toToolResponse", () => {
    it("formats a paid success with the USDC amount and no error flag", () => {
        const result: CallResult = { ok: true, status: 200, paymentState: "paid", amountAtomic: "5000", body: "{}" };
        const response = toToolResponse(result);
        expect(response.isError).toBe(false);
        expect(response.content[0].text).toContain("[paid call succeeded - 0.005 USDC]");
    });

    it("formats a quote (unpaid, within cap) without marking it as an error", () => {
        const result: CallResult = { ok: true, status: 402, paymentState: "quoted", amountAtomic: "20000", body: "quote text" };
        const response = toToolResponse(result);
        expect(response.isError).toBe(false);
        expect(response.content[0].text).toContain("[quote only - 0.02 USDC, NOT paid]");
    });

    it("formats a declined over-cap quote as an error", () => {
        const result: CallResult = { ok: false, status: 402, paymentState: "quoted", amountAtomic: "900000", body: "over cap" };
        const response = toToolResponse(result);
        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain("[payment declined - HTTP 402]");
    });

    it("formats a free success", () => {
        const result: CallResult = { ok: true, status: 200, paymentState: "free", body: "{}" };
        const response = toToolResponse(result);
        expect(response.isError).toBe(false);
        expect(response.content[0].text).toContain("[free call succeeded]");
    });

    it("formats a free-path error (e.g. unparseable 402 challenge, or a 404)", () => {
        const result: CallResult = { ok: false, status: 404, paymentState: "free", body: "not found" };
        const response = toToolResponse(result);
        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain("[error - HTTP 404]");
    });
});

// ---------------------------------------------------------------------------
// resolveSignerConfig
// ---------------------------------------------------------------------------

const VALID_RAW_KEY = "0x" + "1".repeat(64);

describe("resolveSignerConfig", () => {
    it("defaults to 'raw' when DATABROKER_SIGNER is unset", () => {
        const config = resolveSignerConfig({ DATABROKER_WALLET_KEY: VALID_RAW_KEY });
        expect(config.type).toBe("raw");
    });

    it("selects 'raw' explicitly and returns the wallet key", () => {
        const config = resolveSignerConfig({
            DATABROKER_SIGNER: "raw",
            DATABROKER_WALLET_KEY: VALID_RAW_KEY,
        });
        expect(config).toEqual({ type: "raw", walletKey: VALID_RAW_KEY });
    });

    it("is case-insensitive on DATABROKER_SIGNER", () => {
        const config = resolveSignerConfig({
            DATABROKER_SIGNER: "RAW",
            DATABROKER_WALLET_KEY: VALID_RAW_KEY,
        });
        expect(config.type).toBe("raw");
    });

    it("throws a clear error for 'raw' with a missing wallet key", () => {
        expect(() => resolveSignerConfig({ DATABROKER_SIGNER: "raw" })).toThrow(
            /DATABROKER_WALLET_KEY/
        );
    });

    it("throws for a malformed (non-hex, wrong-length) wallet key", () => {
        expect(() =>
            resolveSignerConfig({ DATABROKER_SIGNER: "raw", DATABROKER_WALLET_KEY: "not-a-key" })
        ).toThrow(/DATABROKER_WALLET_KEY/);
    });

    it("selects 'cdp' and returns all three credentials when present", () => {
        const config = resolveSignerConfig({
            DATABROKER_SIGNER: "cdp",
            CDP_API_KEY_ID: "id-123",
            CDP_API_KEY_SECRET: "secret-abc",
            CDP_WALLET_SECRET: "wallet-xyz",
        });
        expect(config).toEqual({
            type: "cdp",
            apiKeyId: "id-123",
            apiKeySecret: "secret-abc",
            walletSecret: "wallet-xyz",
        });
    });

    it("does not require DATABROKER_WALLET_KEY when using 'cdp'", () => {
        // Regression guard: a user switching to cdp shouldn't need to also keep
        // an unused raw key set.
        const config = resolveSignerConfig({
            DATABROKER_SIGNER: "cdp",
            CDP_API_KEY_ID: "id-123",
            CDP_API_KEY_SECRET: "secret-abc",
            CDP_WALLET_SECRET: "wallet-xyz",
        });
        expect(config.type).toBe("cdp");
    });

    it("lists every missing cdp credential in one error, not just the first", () => {
        expect(() =>
            resolveSignerConfig({ DATABROKER_SIGNER: "cdp", CDP_API_KEY_ID: "id-123" })
        ).toThrow(/CDP_API_KEY_SECRET.*CDP_WALLET_SECRET/s);
    });

    it("throws for an unknown signer type, naming the allowed values", () => {
        expect(() => resolveSignerConfig({ DATABROKER_SIGNER: "turnkey" })).toThrow(
            /Unknown DATABROKER_SIGNER "turnkey"/
        );
    });
});
// =============================================================================
// lib.ts
//
// Pure/testable core of the DataBroker MCP server. Deliberately has no
// dependency on the MCP SDK, no env var reads, and no process.exit - all of
// that startup wiring lives in index.ts. Everything here takes its
// dependencies (fetch implementations, wallet address, base URL, spend cap)
// as explicit arguments so it can be exercised in tests with mocked fetches
// and no network access, no funded wallet, and no live DataBroker instance.
// =============================================================================

export interface PaymentRequirement {
    scheme?: string;
    network?: string;
    amount?: string;
    payTo?: string;
}

export interface PaymentRequiredBody {
    accepts?: PaymentRequirement[];
}

// Prefer the Base mainnet requirement if the challenge lists several
// networks; otherwise take whatever the server offered first.
export function pickRequirement(body: PaymentRequiredBody): PaymentRequirement | undefined {
    return body.accepts?.find((r) => r.network === "eip155:8453") ?? body.accepts?.[0];
}

export function amountExceedsCap(amountAtomic: bigint, maxAtomic: bigint): boolean {
    return amountAtomic > maxAtomic;
}

// USDC has 6 decimals - format atomic units as a human-readable dollar amount
// (e.g. "5000" -> "0.005") for display in tool responses. Returns the input
// unchanged if it isn't parseable as an integer, rather than throwing.
export function formatUsdc(amountAtomic: string): string {
    try {
        const atomic = BigInt(amountAtomic);
        const whole = atomic / 1_000_000n;
        const frac = (atomic % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
        return frac ? `${whole}.${frac}` : whole.toString();
    } catch {
        return amountAtomic;
    }
}

// Dataset/key path segments come from the model - keep them URL-safe but
// otherwise pass through verbatim, since dataset ids and entity keys are
// server-defined (e.g. dataset "dvsa-mot", key "AB12CDE", or colon-delimited
// analytics keys like "mileage:ford:5-8yr").
export function encodeSegment(segment: string): string {
    return encodeURIComponent(segment);
}

export interface CallResult {
    ok: boolean;
    status: number;
    // "free"   - no payment was ever required for this call
    // "quoted" - a payment WOULD be required, but confirm=false so nothing was paid
    // "paid"   - a payment was made and the request completed
    paymentState: "free" | "quoted" | "paid";
    amountAtomic?: string; // present whenever the endpoint is payment-gated (quoted or paid)
    body: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CallDataBrokerDeps {
    baseUrl: string;
    maxAtomic: bigint;
    maxUsdcLabel: string; // human-readable cap, e.g. "0.50", for messages only
    walletAddress: string;
    plainFetch: FetchLike;
    payingFetch: FetchLike;
    characterLimit?: number;
}

export function createCallDataBroker(deps: CallDataBrokerDeps) {
    const CHARACTER_LIMIT = deps.characterLimit ?? 40_000;

    async function readBodyText(res: Response): Promise<string> {
        let body = await res.text();
        if (body.length > CHARACTER_LIMIT) {
            body =
                body.slice(0, CHARACTER_LIMIT) +
                `\n...[truncated at ${CHARACTER_LIMIT} chars - use a more specific query]`;
        }
        return body;
    }

    // `confirm` gates every payment: false (or omitted) NEVER spends money, even
    // if the endpoint is payment-gated - it returns a quote (price + a note to
    // retry with confirm: true) instead of paying. This is a hard guarantee
    // enforced here, not left to the calling model's judgement.
    return async function callDataBroker(
        path: string,
        opts: { init?: RequestInit; confirm?: boolean } = {}
    ): Promise<CallResult> {
        const { init = {}, confirm = false } = opts;
        const url = `${deps.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
        const requestInit: RequestInit = {
            ...init,
            headers: { Accept: "application/json", ...(init.headers ?? {}) },
        };

        // Probe unauthenticated first - this never pays, regardless of confirm.
        let probe: Response;
        try {
            probe = await deps.plainFetch(url, requestInit);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false, status: 0, paymentState: "free", body: `Request failed: ${msg}` };
        }

        if (probe.status !== 402) {
            // Free route, or an error unrelated to payment - nothing more to do.
            return { ok: probe.ok, status: probe.status, paymentState: "free", body: await readBodyText(probe) };
        }

        // Payment-gated: inspect the challenge before doing anything else.
        let challengeBody: PaymentRequiredBody = {};
        try {
            challengeBody = await probe.clone().json();
        } catch {
            // Fall through - requirement below will be undefined, handled as "unknown price".
        }
        const requirement = pickRequirement(challengeBody);
        const amountAtomic = requirement?.amount;

        if (!amountAtomic) {
            return {
                ok: false,
                status: 402,
                paymentState: "free",
                body: "Server returned 402 but the payment amount could not be parsed from the challenge. Declined before paying.",
            };
        }

        let overCap = false;
        try {
            overCap = amountExceedsCap(BigInt(amountAtomic), deps.maxAtomic);
        } catch {
            overCap = true; // unparseable - fail closed
        }
        if (overCap) {
            return {
                ok: false,
                status: 402,
                paymentState: "quoted",
                amountAtomic,
                body:
                    `Payment required (${formatUsdc(amountAtomic)} USDC) exceeds the DATABROKER_MAX_USDC ` +
                    `cap (currently ${deps.maxUsdcLabel} USDC). Call declined before paying. Raise DATABROKER_MAX_USDC ` +
                    `if this call is expected to cost more.`,
            };
        }

        if (!confirm) {
            // Within cap and would succeed, but not confirmed - return the quote, spend nothing.
            return {
                ok: true,
                status: 402,
                paymentState: "quoted",
                amountAtomic,
                body:
                    `This call costs ${formatUsdc(amountAtomic)} USDC and has not been paid. ` +
                    `No money has moved. To proceed with payment, call this tool again with confirm: true.`,
            };
        }

        let res: Response;
        try {
            res = await deps.payingFetch(url, requestInit);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                ok: false,
                status: 0,
                paymentState: "quoted",
                amountAtomic,
                body:
                    `Payment failed: ${msg}. The wallet (${deps.walletAddress}) may need funding ` +
                    `with USDC on Base mainnet, or the request may have been rejected by the facilitator.`,
            };
        }

        return { ok: res.ok, status: res.status, paymentState: "paid", amountAtomic, body: await readBodyText(res) };
    };
}

export function toToolResponse(result: CallResult) {
    let prefix: string;
    if (result.paymentState === "paid") {
        prefix = `[paid call succeeded - ${formatUsdc(result.amountAtomic!)} USDC]\n`;
    } else if (result.paymentState === "quoted") {
        prefix = result.ok
            ? `[quote only - ${formatUsdc(result.amountAtomic!)} USDC, NOT paid]\n`
            : `[payment declined - HTTP ${result.status}]\n`;
    } else {
        prefix = result.ok ? "[free call succeeded]\n" : `[error - HTTP ${result.status}]\n`;
    }
    return {
        content: [{ type: "text" as const, text: prefix + result.body }],
        isError: !result.ok,
    };
}

// ---------------------------------------------------------------------------
// Signer provider selection
//
// Pure validation only - no SDK imports, no crypto, no key material touches
// this function. It decides WHICH provider index.ts should construct and
// checks the right env vars are present for that choice; the actual signer
// construction (privateKeyToAccount, or `new CdpX402Client()`) happens in
// index.ts, since that requires real crypto/SDK calls this file deliberately
// stays free of. Kept here so the "did we pick the right provider and
// validate its env vars correctly" logic is unit-testable without needing a
// real wallet key or CDP credentials.
//
// New providers (Turnkey, Privy, Fireblocks, ...) are added by extending the
// SignerConfig union and this function's switch - index.ts's branch on
// signerConfig.type is the only other place that needs a new case.
// ---------------------------------------------------------------------------

export type SignerEnv = Record<string, string | undefined>;

export type SignerConfig =
    | { type: "raw"; walletKey: string }
    | { type: "cdp"; apiKeyId: string; apiKeySecret: string; walletSecret: string };

const RAW_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function resolveSignerConfig(env: SignerEnv): SignerConfig {
    const type = (env.DATABROKER_SIGNER ?? "raw").toLowerCase();

    if (type === "raw") {
        const walletKey = env.DATABROKER_WALLET_KEY ?? "";
        if (!RAW_KEY_PATTERN.test(walletKey)) {
            throw new Error(
                "DATABROKER_WALLET_KEY must be a 0x-prefixed 32-byte hex private key " +
                '(required when DATABROKER_SIGNER=raw, which is the default).'
            );
        }
        return { type: "raw", walletKey };
    }

    if (type === "cdp") {
        const apiKeyId = env.CDP_API_KEY_ID ?? "";
        const apiKeySecret = env.CDP_API_KEY_SECRET ?? "";
        const walletSecret = env.CDP_WALLET_SECRET ?? "";
        const missing = [
            !apiKeyId && "CDP_API_KEY_ID",
            !apiKeySecret && "CDP_API_KEY_SECRET",
            !walletSecret && "CDP_WALLET_SECRET",
        ].filter((v): v is string => Boolean(v));
        if (missing.length > 0) {
            throw new Error(
                `Missing required env var(s) for DATABROKER_SIGNER=cdp: ${missing.join(", ")}.`
            );
        }
        return { type: "cdp", apiKeyId, apiKeySecret, walletSecret };
    }

    throw new Error(`Unknown DATABROKER_SIGNER "${type}": expected "raw" or "cdp".`);
}
// examples/typescript/fetch-mot-history.ts
//
// Minimal example: pay for and fetch a single MOT history lookup via x402.
//
// Setup:
//   npm install @x402/fetch @x402/evm viem
//   export AGENT_PRIVATE_KEY=0x...   (a Base mainnet wallet funded with a small amount of USDC)
//
// Run:
//   npx tsx fetch-mot-history.ts AB12CDE

import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const BASE_URL = 'https://api.databroker.mossforge.dev';

interface DataBrokerError {
    error: {
        code: string;
        message: string;
        retryable: boolean;
        retry_after_seconds?: number;
        docs_url: string;
    };
}

interface MotHistoryResponse {
    dataset: string;
    key: string;
    fetched_at: string;
    fetch_status: 'ok' | 'error' | 'partial';
    source: string;
    ttl_seconds: number;
    stale: boolean;
    data: {
        vehicle: {
            registration: string;
            make: string | null;
            model: string | null;
            primaryColour: string | null;
            fuelType: string | null;
            engineSize: string | null;
            firstUsedDate: string | null;
            registrationDate: string | null;
            manufactureDate: string | null;
        };
        summary: {
            latestTestDate: string | null;
            latestTestResult: 'PASSED' | 'FAILED' | null;
            latestExpiryDate: string | null;
            totalTests: number;
            passCount: number;
            failCount: number;
            passRate: number | null;
            mileageAtLatestTest: number | null;
            mileageUnit: string | null;
        };
        motTests: unknown[];
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getMotHistory(
    paidFetch: typeof fetch,
    registration: string,
): Promise<MotHistoryResponse> {
    const response = await paidFetch(`${BASE_URL}/v1/dvsa-mot/${registration}`);

    if (response.ok) {
        return response.json() as Promise<MotHistoryResponse>;
    }

    const body = await response.json() as DataBrokerError;
    const { code, message, retryable, retry_after_seconds } = body.error;

    // First-ever lookup for a registration triggers a live DVSA fetch.
    // If it didn't complete within the request window, the server asks us
    // to retry — this is the one case worth handling automatically here.
    if (code === 'INGEST_IN_PROGRESS' && retryable) {
        const waitMs = (retry_after_seconds ?? 5) * 1000;
        console.log(`Data still being fetched, retrying in ${waitMs}ms...`);
        await sleep(waitMs);
        return getMotHistory(paidFetch, registration);
    }

    throw new Error(`DataBroker error [${code}]: ${message}`);
}

async function main() {
    const registration = process.argv[2];
    if (!registration) {
        console.error('Usage: tsx fetch-mot-history.ts <REGISTRATION>');
        process.exit(1);
    }

    const privateKey = process.env.AGENT_PRIVATE_KEY;
    if (!privateKey) {
        console.error('Set AGENT_PRIVATE_KEY to a funded Base mainnet wallet private key.');
        process.exit(1);
    }

    // Optional: check pricing before paying anything.
    const discoverResp = await fetch(`${BASE_URL}/v1/discover`);
    const { datasets } = await discoverResp.json() as { datasets: Array<{ dataset_id: string; price_usdc: string }> };
    const motPricing = datasets.find(d => d.dataset_id === 'dvsa-mot');
    console.log(`dvsa-mot costs $${motPricing?.price_usdc ?? '?'} USDC per call`);

    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const x402 = new x402Client();
    registerExactEvmScheme(x402, { signer: account });
    const paidFetch = wrapFetchWithPayment(fetch, x402);

    console.log(`Fetching MOT history for ${registration}...`);
    const history = await getMotHistory(paidFetch, registration);

    console.log(JSON.stringify(history.data.summary, null, 2));
}

main().catch(err => {
    console.error(err.message ?? err);
    process.exit(1);
});
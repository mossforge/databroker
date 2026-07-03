// examples/typescript/agent-tool.ts
//
// Shows how to expose DataBroker's two endpoints as tools to an LLM agent
// using Anthropic's function-calling format. The model decides when to call
// these; the actual x402 payment happens transparently inside the handler.
//
// Setup:
//   npm install @anthropic-ai/sdk @x402/fetch @x402/evm viem
//   export ANTHROPIC_API_KEY=...
//   export AGENT_PRIVATE_KEY=0x...

import Anthropic from '@anthropic-ai/sdk';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const BASE_URL = 'https://api.databroker.mossforge.dev';

const account = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const x402 = new x402Client();
registerExactEvmScheme(x402, { signer: account });
const paidFetch = wrapFetchWithPayment(fetch, x402);
const anthropic = new Anthropic();

// ── Tool definitions ────────────────────────────────────────────────────────
// The cost is stated in the description so the model can reason about
// whether a lookup is worth making, the same way it would reason about any
// other tradeoff.

const tools: Anthropic.Tool[] = [
    {
        name: 'get_mot_history',
        description:
            'Retrieve full MOT test history for a UK vehicle by registration plate. ' +
            'Returns vehicle details, pass/fail summary, mileage, and individual test ' +
            'records with defects. Costs $0.005 USDC per call, paid automatically via x402.',
        input_schema: {
            type: 'object',
            properties: {
                registration: {
                    type: 'string',
                    description: 'UK vehicle registration plate, e.g. AB12CDE',
                },
            },
            required: ['registration'],
        },
    },
    {
        name: 'get_mot_analytics',
        description:
            'Retrieve aggregated MOT statistics for a UK vehicle segment. Six families: ' +
            'reliability:<make>, mileage:<make>:<band_or_year>, parc:<make>:<fuel>:<band_or_year>, ' +
            'fuelmix:<year>, colour:<make>:<year>, temporal. Costs $0.02 USDC per call via x402.',
        input_schema: {
            type: 'object',
            properties: {
                key: {
                    type: 'string',
                    description:
                        "Colon-delimited key, e.g. 'reliability:ford' or 'mileage:ford:5-8yr'. " +
                        'band_or_year accepts an age band (0-3yr 3-5yr 5-8yr 8-12yr 12yr+) or a 4-digit year.',
                },
            },
            required: ['key'],
        },
    },
];

// ── Tool execution ──────────────────────────────────────────────────────────

async function executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    if (name === 'get_mot_history') {
        const response = await paidFetch(`${BASE_URL}/v1/dvsa-mot/${input.registration}`);
        return response.json();
    }

    if (name === 'get_mot_analytics') {
        const response = await paidFetch(`${BASE_URL}/v1/dvsa-mot-analytics/${input.key}`);
        return response.json();
    }

    throw new Error(`Unknown tool: ${name}`);
}

// ── Agent loop ───────────────────────────────────────────────────────────────

async function runAgent(userMessage: string): Promise<string> {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];

    while (true) {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            tools,
            messages,
        });

        if (response.stop_reason !== 'tool_use') {
            const textBlock = response.content.find(b => b.type === 'text');
            return textBlock && textBlock.type === 'text' ? textBlock.text : '';
        }

        messages.push({ role: 'assistant', content: response.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
            if (block.type !== 'tool_use') continue;

            const result = await executeTool(block.name, block.input as Record<string, unknown>);
            toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: JSON.stringify(result),
            });
        }

        messages.push({ role: 'user', content: toolResults });
    }
}

async function main() {
    const question = process.argv.slice(2).join(' ') ||
        'Should I buy a Ford Focus registration AB12CDE? What does its MOT history look like, and how does that compare to typical Ford reliability?';

    console.log(`Q: ${question}\n`);
    const answer = await runAgent(question);
    console.log(`A: ${answer}`);
}

main().catch(err => {
    console.error(err.message ?? err);
    process.exit(1);
});
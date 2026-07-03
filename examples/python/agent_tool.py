"""
examples/python/agent_tool.py

Shows how to expose DataBroker's two endpoints as tools to an LLM agent
using Anthropic's function-calling format. The model decides when to call
these; the actual x402 payment happens transparently inside the handler.

Setup:
    pip install anthropic x402 httpx eth-account
    export ANTHROPIC_API_KEY=...
    export AGENT_PRIVATE_KEY=0x...
"""

import asyncio
import json
import os
import sys

import httpx
from anthropic import Anthropic
from eth_account import Account
from x402.httpx import x402_payment_hooks

BASE_URL = "https://api.databroker.mossforge.dev"

account = Account.from_key(os.environ["AGENT_PRIVATE_KEY"])
anthropic_client = Anthropic()

# ── Tool definitions ────────────────────────────────────────────────────────
# The cost is stated in the description so the model can reason about
# whether a lookup is worth making, the same way it would reason about any
# other tradeoff.

TOOLS = [
    {
        "name": "get_mot_history",
        "description": (
            "Retrieve full MOT test history for a UK vehicle by registration plate. "
            "Returns vehicle details, pass/fail summary, mileage, and individual test "
            "records with defects. Costs $0.005 USDC per call, paid automatically via x402."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "registration": {
                    "type": "string",
                    "description": "UK vehicle registration plate, e.g. AB12CDE",
                },
            },
            "required": ["registration"],
        },
    },
    {
        "name": "get_mot_analytics",
        "description": (
            "Retrieve aggregated MOT statistics for a UK vehicle segment. Six families: "
            "reliability:<make>, mileage:<make>:<band_or_year>, parc:<make>:<fuel>:<band_or_year>, "
            "fuelmix:<year>, colour:<make>:<year>, temporal. Costs $0.02 USDC per call via x402."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "description": (
                        "Colon-delimited key, e.g. 'reliability:ford' or 'mileage:ford:5-8yr'. "
                        "band_or_year accepts an age band (0-3yr 3-5yr 5-8yr 8-12yr 12yr+) or a 4-digit year."
                    ),
                },
            },
            "required": ["key"],
        },
    },
]


# ── Tool execution ──────────────────────────────────────────────────────────


async def execute_tool(client: httpx.AsyncClient, name: str, tool_input: dict) -> dict:
    if name == "get_mot_history":
        response = await client.get(
            f"{BASE_URL}/v1/dvsa-mot/{tool_input['registration']}"
        )
        return response.json()

    if name == "get_mot_analytics":
        response = await client.get(
            f"{BASE_URL}/v1/dvsa-mot-analytics/{tool_input['key']}"
        )
        return response.json()

    raise ValueError(f"Unknown tool: {name}")


# ── Agent loop ───────────────────────────────────────────────────────────────


async def run_agent(client: httpx.AsyncClient, user_message: str) -> str:
    messages = [{"role": "user", "content": user_message}]

    while True:
        response = anthropic_client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            tools=TOOLS,
            messages=messages,
        )

        if response.stop_reason != "tool_use":
            text_blocks = [b.text for b in response.content if b.type == "text"]
            return "".join(text_blocks)

        messages.append({"role": "assistant", "content": response.content})

        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            result = await execute_tool(client, block.name, block.input)
            tool_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(result),
                }
            )

        messages.append({"role": "user", "content": tool_results})


async def main() -> None:
    question = " ".join(sys.argv[1:]) or (
        "Should I buy a Ford Focus registration AB12CDE? What does its MOT "
        "history look like, and how does that compare to typical Ford reliability?"
    )

    print(f"Q: {question}\n")

    async with httpx.AsyncClient(event_hooks=x402_payment_hooks(account)) as client:
        answer = await run_agent(client, question)

    print(f"A: {answer}")


if __name__ == "__main__":
    asyncio.run(main())

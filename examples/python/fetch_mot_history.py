"""
examples/python/fetch_mot_history.py

Minimal example: pay for and fetch a single MOT history lookup via x402.

Setup:
    pip install x402 httpx eth-account
    export AGENT_PRIVATE_KEY=0x...   # a Base mainnet wallet funded with a small amount of USDC

Run:
    python fetch_mot_history.py AB12CDE
"""

import asyncio
import os
import sys

import httpx
from eth_account import Account
from x402.httpx import x402_payment_hooks

BASE_URL = "https://api.databroker.mossforge.dev"


class DataBrokerError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        retryable: bool,
        retry_after_seconds: int | None = None,
    ):
        super().__init__(f"DataBroker error [{code}]: {message}")
        self.code = code
        self.retryable = retryable
        self.retry_after_seconds = retry_after_seconds


async def get_mot_history(client: httpx.AsyncClient, registration: str) -> dict:
    response = await client.get(f"{BASE_URL}/v1/dvsa-mot/{registration}")

    if response.status_code < 400:
        return response.json()

    body = response.json()
    err = body["error"]

    # First-ever lookup for a registration triggers a live DVSA fetch. If it
    # didn't complete within the request window, the server asks us to retry —
    # this is the one case worth handling automatically here.
    if err["code"] == "INGEST_IN_PROGRESS" and err.get("retryable"):
        wait_seconds = err.get("retry_after_seconds", 5)
        print(f"Data still being fetched, retrying in {wait_seconds}s...")
        await asyncio.sleep(wait_seconds)
        return await get_mot_history(client, registration)

    raise DataBrokerError(
        code=err["code"],
        message=err["message"],
        retryable=err.get("retryable", False),
        retry_after_seconds=err.get("retry_after_seconds"),
    )


async def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python fetch_mot_history.py <REGISTRATION>")
        sys.exit(1)

    registration = sys.argv[1]

    private_key = os.environ.get("AGENT_PRIVATE_KEY")
    if not private_key:
        print("Set AGENT_PRIVATE_KEY to a funded Base mainnet wallet private key.")
        sys.exit(1)

    # Optional: check pricing before paying anything.
    async with httpx.AsyncClient() as discover_client:
        discover_resp = await discover_client.get(f"{BASE_URL}/v1/discover")
        datasets = discover_resp.json()["datasets"]
        mot_pricing = next((d for d in datasets if d["dataset_id"] == "dvsa-mot"), None)
        price = mot_pricing["price_usdc"] if mot_pricing else "?"
        print(f"dvsa-mot costs ${price} USDC per call")

    account = Account.from_key(private_key)

    async with httpx.AsyncClient(event_hooks=x402_payment_hooks(account)) as client:
        print(f"Fetching MOT history for {registration}...")
        history = await get_mot_history(client, registration)
        print(history["data"]["summary"])


if __name__ == "__main__":
    asyncio.run(main())

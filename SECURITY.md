# Security

**Bottom line: this software spends real money from a wallet you control. Fund a
dedicated wallet with an amount you would not mind losing entirely, keep
`DATABROKER_MAX_USDC` low, and never point it at a wallet holding anything else.
Report vulnerabilities to security@mossforge.dev — do not open a public issue.**

---

## Reporting a vulnerability

**Email security@mossforge.dev. Expect an acknowledgement within 3 working days
and an assessment within 10.**

Do not open a public GitHub issue for anything that could be used to move funds,
forge a payment, or bypass the spend cap. Include reproduction steps and the
version (`npm ls @mossforge/databroker-mcp`, or the commit SHA if built from
source). We will credit you in the release notes unless you'd rather we didn't.

Reports about the DataBroker API itself, rather than this client code, go to the
same address.

## Your wallet key is the whole attack surface

**In the default `raw` signer mode, anything that can read this process's
environment can drain the wallet. Treat the key as compromised the moment it
leaves a machine you control.**

The key sits in `DATABROKER_WALLET_KEY` (or `X402_PRIVATE_KEY`) and is read at
startup. That means it is readable by any process running as your user, it is
visible in your MCP client's config file in plaintext, and it lands in shell
history if you ever pass it on a command line. None of that is unusual for a
local signer, but it does mean the mitigation is balance, not secrecy:

- Use a **fresh wallet created for this purpose only**. Never a wallet with an
  ENS name, an NFT, or a balance you'd miss.
- Fund it with **a few dollars of USDC on Base mainnet**. Top it up when it runs
  out. Your total exposure is the balance, so keep the balance small.
- No ETH is required. EIP-3009 `transferWithAuthorization` payments are gasless
  for the payer; the facilitator submits the transaction.
- If you need stronger separation, use `DATABROKER_SIGNER=cdp` — a Coinbase
  CDP-managed wallet signs remotely, no private key enters this process, and
  spend policies are enforced by the custodian rather than by this codebase.

## Two independent controls stop runaway spending

**Every paid call must be explicitly confirmed, and every paid call is capped.
Neither is left to the calling model's judgement.**

1. **Quote, then confirm.** `databroker_fetch` and `databroker_batch_create`
   return a price and spend nothing unless called a second time with
   `confirm: true`. This is enforced in `lib.ts`, not in a prompt — a model that
   ignores the instruction still cannot spend.
2. **Per-call cap.** `DATABROKER_MAX_USDC` (default `0.50`) is checked against
   the 402 challenge _before_ any payment is signed. A call priced above the cap
   is declined, not charged.

The cap is per call, not per session or per day. An agent in a loop can make
many capped calls. The wallet balance is your only hard ceiling — which is why
the previous section matters more than this one.

## What an HTTP 402 does and does not mean

**A 402 means no funds have moved. You are only ever charged on a 200.**

Malformed keys on utility endpoints are rejected with a free `400` before
payment is requested at all. `valid: false` from a validator is a legitimate
_paid_ answer — you are paying for the verdict, not for the verdict being yes.

## Trust boundaries

**This client trusts the DataBroker API to quote honestly, and trusts npm and
the MCP registry to serve the package you asked for.**

- The price you pay is the price in the server's 402 challenge. The cap is your
  protection against a wrong or hostile quote; nothing else validates it.
- Responses are passed to the model as text. Treat data returned from any API,
  including this one, as untrusted input to your agent.
- npm publishes are signed with provenance via GitHub Actions Trusted
  Publishing. Verify with `npm audit signatures` or check the provenance link on
  the package page.
- Payment goes to the `payTo` address in the server's challenge, on
  `eip155:8453` (Base mainnet). If you are running against a base URL you do not
  control, you are trusting whoever operates it with the payment destination.

## Supported versions

**Only the latest minor release receives fixes.** Pin with `npx -y
@mossforge/databroker-mcp@0.4` if you need stability, but expect security fixes
only on the current line.

## Out of scope

Reports we will close without action: the wallet key being readable by other
processes on the same machine (inherent to local signing — use `cdp` mode);
missing rate limiting in this client; the absence of a per-day spend cap;
anything requiring physical or root access to the host.

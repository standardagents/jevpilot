# Cloudflare hosting

Push to `main` in **standardagents/jevpilot** to deploy **jevpilot.standardagents.ai**. Cloudflare Workers Builds watches the repository through its GitHub integration; no GitHub Actions workflow is involved.

The Cloudflare build settings are:

- Production branch: `main`; preview builds disabled.
- Root directory: `/`.
- Build command: `npm run build`.
- Deploy command: `npx wrangler deploy`.
- Build caching enabled; Cloudflare-managed deployment token: `jevpilot-workers-builds`.

Cloudflare installs dependencies from `package-lock.json`, builds both Vite entry points, and deploys the Worker with its static assets. Check the commit's **Workers Builds: jevpilot** status or the Worker's Deployments tab for the release result. `npm run deploy` remains available for an explicit manual recovery, but normal releases happen by pushing to `main`.

`wrangler.jsonc` contains the domain, non-secret Platform project ID, and bindings. Keep the account Durable Object namespace and migration history across releases; replacing them would reset credits.

Set three Cloudflare Worker secrets with `npx wrangler secret put NAME`:

- `TYPESAFE_API_KEY`: the server-side Jev key.
- `PLATFORM_PARTNER_SECRET`: the production Standard Agents partner credential.
- `SESSION_SECRET`: a randomly generated 32-byte or longer signing secret. Rotating it signs everyone out; it does not reset credit.

These are encrypted **runtime Worker secrets**, already configured in production and preserved by subsequent builds. The frontend build does not need them. No secret belongs in a `VITE_` variable or build-time variable. `.env` and `.dev.vars` are gitignored. `npm run dev` retains the local, unmetered development proxy.

To opt into GPT-6 Luna Decisions via EvoLink, set `DECISION_PROVIDER` to `evolink` in the Worker's runtime variables and add the `EVOLINK_API_KEY` secret. Optional `EVOLINK_INPUT_PRICE` and `EVOLINK_MIN_REQUEST_COST` overrides follow `.env.example`. `TYPESAFE_API_KEY` remains the key for the default Jev provider; a provider never uses the other provider's key. Both providers require the same sign-in and credit checks.

## Sign-in

The Worker redirects unauthenticated page requests to `/login` and rejects unauthenticated API requests. `/api/auth/start` creates a Standard Agents delegated sign-in request for the JevPilot identity-only project. The project owns the customer-facing name, description, and logo. A signed, browser-bound, ten-minute OAuth state carries the unchecked early-access preference. The one-time callback code is exchanged server-to-server, then a Secure, HttpOnly, SameSite cookie stores the verified Platform user ID for 30 days. JevPilot does not grant Platform dashboard access or project membership.

The registered project is `c95d8b94-38b6-4130-92ae-17de0c29c0ed`. Its login logo uses the public `/brand/standard-agents-mark.svg` asset. There is no deployed AgentBuilder runtime behind this identity-only project.

## Play allowance

One `PlayAccount` Durable Object per immutable Platform user ID grants **$0.25 once**. It persists the balance in integer nanodollars, serializes paid decisions across tabs, limits each account to five requests per second, and retains recent request receipts to avoid duplicate charges on retries. New sessions and world resets reuse the same balance.

Before a paid call, the account reserves a conservative maximum input charge (UTF-8 request bytes plus 4,096 tokens of overhead); the compact request is capped at 24 KB. It refunds the difference from Jev's reported usage, including responses whose selected path fails validation. Uncertain interrupted/time-out calls retain the reservation, avoiding an abort-to-refund loophole. A balance too small to reserve the next request returns HTTP 402, so a small residual may remain. Output pricing must remain zero until an output reservation bound is implemented. Current input pricing is configured in `wrangler.jsonc`.

The HUD shows remaining credit. Exhaustion disables paid autopilot; manual driving remains available. API keys and costs are controlled entirely by the Worker.

## Early access

Only a checked opt-in records consent and queues registration. A durable alarm calls the existing marketing `DurableAgentBuilder.addToWaitlist` via a private cross-Worker binding, with `source: "jevpilot"`. This writes to the existing Standard Agents waitlist and its admin view, reuses email deduplication, and retries failures without blocking the user's drive. No separate list, automatic marketing opt-in, or email campaign is created.

## Release checks

Build and Wrangler's dry run validate the browser and Worker bundles. At the live URL, confirm that `/` redirects to `/login`, unauthenticated `/api/decide` returns 401, cross-origin writes return 403, and the delegated Platform context presents JevPilot. Complete a real sign-in to inspect the initial allowance and optional waitlist registration; no paid Jev call is needed just to sign in.

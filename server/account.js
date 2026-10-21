import { DurableObject } from "cloudflare:workers";
import { evaluate, validState } from "./jev.js";
import { prepareDecisionRequest } from "../src/decision-request.js";
import { decisionConfig, decisionCost } from "./decision-config.js";

// Integer nanodollars preserve sub-cent token charges without floating-point drift.
export const GRANT_NANODOLLARS = 250_000_000;
const json = (data, status = 200) => Response.json(data, { status });
export class PlayAccount extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.busy = false;
    ctx.blockConcurrencyWhile(async () => {
      this.account = await ctx.storage.get("account");
      // An interrupted upstream call has already reserved its maximum charge.
      // Keep that debit; never silently refund potentially billed requests.
      if (this.account?.pending) {
        this.account.receipts.push({
          id: this.account.pending.id,
          status: 502,
          body: {
            error:
              "The previous Jev request was interrupted. Please request a fresh decision.",
          },
        });
        this.account.pending = null;
        await this.save();
      }
    });
  }
  async save() {
    await this.ctx.storage.put("account", this.account);
  }
  credits() {
    return {
      granted_usd: GRANT_NANODOLLARS / 1e9,
      remaining_usd: Math.max(0, this.account.balance) / 1e9,
      spent_usd: this.account.spent / 1e9,
      exhausted: this.account.balance <= 0,
    };
  }
  async initialize(identity, optIn) {
    if (!this.account) {
      this.account = {
        user: identity,
        balance: GRANT_NANODOLLARS,
        spent: 0,
        created_at: Date.now(),
        receipts: [],
      };
    } else if (this.account.user.id !== identity.id) {
      throw new Error("Account identity mismatch");
    }
    this.account.user = identity;
    if (optIn && !this.account.early_access_at) {
      this.account.early_access_at = Date.now();
      this.account.waitlist_pending = true;
      this.account.waitlist_attempts = 0;
    }
    await this.save();
    if (this.account.waitlist_pending)
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    return this.snapshot();
  }
  snapshot() {
    if (!this.account) return null;
    return {
      user: this.account.user,
      credits: this.credits(),
      early_access: !!this.account.early_access_at,
    };
  }
  async alarm() {
    if (!this.account?.waitlist_pending) return;
    try {
      // Private RPC into the existing marketing waitlist, using its normal
      // deduplication and signup-source handling. No browser/admin token needed.
      await this.env.WAITLIST.get(
        this.env.WAITLIST.idFromName("singleton"),
      ).addToWaitlist({
        email: this.account.user.email,
        name: this.account.user.name || undefined,
        source: "jevpilot",
      });
      this.account.waitlist_pending = false;
      this.account.waitlist_synced_at = Date.now();
    } catch {
      this.account.waitlist_attempts++;
      console.error("JevPilot waitlist sync failed; retry scheduled.");
      await this.ctx.storage.setAlarm(
        Date.now() +
          Math.min(
            3600000,
            30000 * 2 ** Math.min(7, this.account.waitlist_attempts),
          ),
      );
    }
    await this.save();
  }
  async fetch(request) {
    if (!this.account) return json({ error: "Sign in to drive." }, 401);
    const { state, request_id: id } = await request.json();
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(id))
      return json({ error: "A request ID is required." }, 400);
    const receipt = this.account.receipts.find((r) => r.id === id);
    if (receipt)
      return json({ ...receipt.body, credits: this.credits() }, receipt.status);
    if (this.busy || Date.now() - (this.account.last_request_at || 0) < 200)
      return json(
        {
          error: "Another driving decision is in progress. Try again shortly.",
        },
        429,
      );
    let prepared, reserve;
    try {
      if (!validState(state)) throw new Error();
      const config = decisionConfig(this.env);
      prepared = prepareDecisionRequest(state, config.provider);
      const bytes = new TextEncoder().encode(
        JSON.stringify(prepared.request),
      ).byteLength;
      if (bytes > 24000)
        return json({ error: "Driving observation is too large." }, 413);
      if (config.pricing.output_per_million !== 0)
        throw new Error("Unbounded output pricing");
      // A conservative byte/token upper bound plus service overhead. Reserve
      // before fetch; refund the difference using actual reported usage.
      reserve = Object.keys(prepared.questions).length
        ? Math.ceil(
            decisionCost(
              { input_tokens: bytes + 4096, output_tokens: 0 },
              this.env,
            ) * 1e9,
          )
        : 0;
      if (!Number.isSafeInteger(reserve) || reserve < 0) throw new Error();
    } catch {
      return json(
        { error: "Invalid driving observation or pricing configuration." },
        400,
      );
    }
    if (this.account.balance <= 0 || this.account.balance < reserve)
      return json(
        {
          error:
            "Your free Jev play credit has been used. You can still drive manually.",
          code: "credit_exhausted",
          credits: { ...this.credits(), exhausted: true },
        },
        402,
      );
    this.busy = true;
    this.account.balance -= reserve;
    this.account.spent += reserve;
    this.account.last_request_at = Date.now();
    this.account.pending = { id, reserve, at: Date.now() };
    const run = this.runDecision(id, state, reserve);
    this.ctx.waitUntil(run);
    return run;
  }
  async runDecision(id, state, reserve) {
    let actual = null;
    try {
      await this.save();
      const result = await evaluate(
        state,
        this.env,
        AbortSignal.timeout(10000),
        async (usage, cost) => {
          if (
            ![usage?.input_tokens, usage?.output_tokens].every(
              (n) => Number.isSafeInteger(n) && n >= 0,
            )
          )
            throw new Error("Jev returned invalid token usage.");
          actual = Math.ceil(cost * 1e9);
          if (!Number.isSafeInteger(actual) || actual < 0)
            throw new Error("Invalid decision pricing configuration.");
          // Persist reported usage before validating or returning the chosen path.
          this.account.balance += reserve - actual;
          this.account.spent += actual - reserve;
          this.account.pending = null;
          await this.save();
        },
      );
      return await this.finish(id, { ...result, credits: this.credits() }, 200);
    } catch (error) {
      if (actual === null && error.billable === false) {
        this.account.balance += reserve;
        this.account.spent -= reserve;
      }
      this.account.pending = null;
      const status = error.status === 429 ? 429 : 502;
      const message =
        error.status === 401
          ? "Jev is temporarily unavailable. Please try again later."
          : error.name === "TimeoutError"
            ? "Jev timed out. Please try again."
            : error.message;
      return await this.finish(
        id,
        { error: message, credits: this.credits() },
        status,
      );
    } finally {
      this.busy = false;
    }
  }
  async finish(id, body, status) {
    this.account.receipts.push({ id, body, status });
    this.account.receipts = this.account.receipts.slice(-8);
    await this.save();
    return json(body, status);
  }
}

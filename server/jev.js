import { performance } from "node:perf_hooks";
import {
  CANDIDATE_COUNT,
  decisionSelection,
  stopAvailability,
} from "../src/planning.js";
import { prepareJevRequest } from "../src/jev-request.js";
import {
  prepareDecisionRequest,
  expandDecisionAnswers,
} from "../src/decision-request.js";
import { decisionConfig, decisionCost } from "./decision-config.js";

export function validState(state) {
  if (
    !Number.isFinite(state?.speed_mps) ||
    !Number.isFinite(state?.speed_ceiling_mps) ||
    state.speed_ceiling_mps < 0 ||
    state.speed_ceiling_mps > 28 ||
    !/^b[0-9]+$/.test(state.batch_id) ||
    typeof state.road?.on_road !== "boolean" ||
    typeof state.recovery?.active !== "boolean" ||
    !state.vectors ||
    !state.turn
  )
    return false;
  const entries = Object.entries(state.vectors);
  return (
    entries.length > 0 &&
    entries.length <= CANDIDATE_COUNT &&
    entries.every(
      ([id, v]) =>
        v &&
        id.startsWith(`${state.batch_id}_`) &&
        /^[a-zA-Z0-9_]+$/.test(id) &&
        (v.lane_offset_m === null ||
          (Number.isFinite(v.lane_offset_m) &&
            Math.abs(v.lane_offset_m) <= 1.4 &&
            Number.isFinite(v.lookahead_m) &&
            v.lookahead_m >= 2 &&
            v.lookahead_m <= 10)) &&
        Number.isFinite(v.steering) &&
        Math.abs(v.steering) <= 0.85 &&
        Number.isFinite(v.velocity_mps) &&
        (v.stop_at_line == null ||
          (Number.isFinite(v.lane_offset_m) &&
            ["x", "z", "heading", "clearance_m", "deceleration_mps2"].every(
              (key) => Number.isFinite(v.stop_at_line[key]),
            ) &&
            v.stop_at_line.clearance_m === 0.5 &&
            v.stop_at_line.deceleration_mps2 >= 4 &&
            v.stop_at_line.deceleration_mps2 <= 4.8)) &&
        v.velocity_mps >= (state.recovery.active ? -2 : 0) &&
        Math.abs(v.velocity_mps) <= state.speed_ceiling_mps + 0.001 &&
        typeof v.collision_predicted === "boolean" &&
        typeof v.stays_on_road === "boolean" &&
        Number.isFinite(v.route_error_m) &&
        Number.isFinite(v.offroad_fraction),
    ) &&
    (!stopAvailability(state).available ||
      entries.some(([, v]) => v.velocity_mps === 0))
  );
}

export function questions(state) {
  return prepareJevRequest(state).request.questions;
}
export async function evaluate(state, env, signal, onUsage) {
  if (!validState(state)) {
    const error = new Error(
      "A valid driving observation and candidate batch are required.",
    );
    error.status = 400;
    throw error;
  }
  const start = performance.now();
  const config = decisionConfig(env);
  const prepared = prepareDecisionRequest(state, config.provider);
  const requestQuestions = prepared.questions;
  const body = JSON.stringify(prepared.request);
  const apiCall = Object.keys(requestQuestions).length > 0;
  let data = {
    answers: config.provider === "evolink" ? [] : {},
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  if (apiCall) {
    const res = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env[config.keyEnv]}`,
        "Content-Type": "application/json",
      },
      body,
      signal: signal || AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const error = new Error(
        res.status === 401
          ? `${config.service} rejected the API key. Update ${config.keyEnv} in .env.`
          : res.status === 429
            ? `${config.service} rate limit reached. Pausing before retry.`
            : `${config.service} API returned HTTP ${res.status}.`,
      );
      error.status = res.status;
      error.billable = res.status >= 500;
      throw error;
    }
    data = await res.json();
  }
  // Account for paid responses even when their decision later fails validation.
  if (
    ![data.usage?.input_tokens, data.usage?.output_tokens].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    throw new Error(`${config.name} returned an incomplete decision.`);
  const cost = apiCall ? decisionCost(data.usage, env) : 0;
  if (onUsage) await onUsage(data.usage, cost);
  const a = expandDecisionAnswers(prepared, data.answers);
  const selection = decisionSelection(state, a);
  if (!selection)
    throw new Error(`${config.name} returned an incomplete decision.`);
  if (
    requestQuestions.route &&
    !Object.hasOwn(requestQuestions.route.criteria, a.route?.choice)
  )
    throw new Error(`${config.name} returned an invalid route choice.`);
  const selected = state.vectors[selection.choice];
  if (
    (selected.collision_imminent ?? selected.collision_predicted) &&
    selected.velocity_mps !== 0
  )
    throw new Error(
      `${config.name} selected a path with an imminent collision. Braking before retry.`,
    );
  return {
    model: data.model ?? null,
    decision_source: apiCall ? config.provider : "only_eligible_action",
    request_bytes: apiCall ? Buffer.byteLength(body) : 0,
    candidate_ids: prepared.aliases,
    resolved_single_choices: Object.keys(prepared.fixed),
    answers: a,
    selection,
    batch_id: state.batch_id,
    controls: { steering: selected.steering, velocity: selected.velocity_mps },
    usage: data.usage,
    latency_ms: Math.round(performance.now() - start),
    cost_usd: cost,
    pricing: {
      ...config.pricing,
      source: config.pricingSource,
    },
  };
}
export function jevMiddleware(env) {
  // Mounted only by Vite dev/preview. The deployed Worker always requires login.
  let active = 0;
  const config = decisionConfig(env);
  return async (req, res, next) => {
    const path = new URL(req.url, "http://localhost").pathname;
    if (["/login", "/login.html"].includes(path) && req.method === "GET") {
      res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
      return res.end();
    }
    if (!path.startsWith("/api/")) return next();
    const send = (code, value) => {
      res.writeHead(code, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    if (path === "/api/status" && req.method === "GET")
      return send(200, {
        auth_required: false,
        authenticated: false,
        configured: !!env[config.keyEnv],
        decision_provider: config.provider,
        decision_name: config.name,
        model: config.model,
        pricing: config.pricing,
      });
    if (path !== "/api/decide" || req.method !== "POST")
      return send(404, { error: "Not found" });
    if (!env[config.keyEnv])
      return send(503, {
        error: `Set ${config.keyEnv} in .env and restart the server.`,
      });
    if (
      req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}` &&
      req.headers.origin !== `https://${req.headers.host}`
    )
      return send(403, { error: "Origin not allowed" });
    if (active >= 3)
      return send(429, { error: "Too many active Jev requests." });
    active++;
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 250000) {
          send(413, { error: "State is too large" });
          return;
        }
      }
      const { state } = JSON.parse(body);
      if (!validState(state))
        return send(400, {
          error:
            "A valid driving observation and candidate batch are required.",
        });
      const result = await evaluate(state, env);
      send(200, result);
    } catch (e) {
      send(e.status || 502, {
        error:
          e.name === "TimeoutError"
            ? "Jev timed out. Car stopped; retrying."
            : e.message,
      });
    } finally {
      active--;
    }
  };
}

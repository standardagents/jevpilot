import { DECISION_MODELS } from "../src/decision-request.js";

export function decisionConfig(env = {}) {
  const provider = env.DECISION_PROVIDER ?? "jev";
  if (!Object.hasOwn(DECISION_MODELS, provider))
    throw new Error("DECISION_PROVIDER must be jev or evolink.");
  const luna = provider === "evolink";
  const pricing = {
    input_per_million: Number(
      luna ? (env.EVOLINK_INPUT_PRICE ?? 0.1) : (env.JEV_INPUT_PRICE ?? 0.042),
    ),
    output_per_million: luna ? 0 : Number(env.JEV_OUTPUT_PRICE ?? 0),
    minimum_per_request: luna
      ? Number(env.EVOLINK_MIN_REQUEST_COST ?? 0.01 / 68)
      : 0,
  };
  if (!Object.values(pricing).every((n) => Number.isFinite(n) && n >= 0))
    throw new Error("Invalid decision pricing configuration.");
  return {
    provider,
    name: luna ? "Luna" : "Jev",
    service: luna ? "EvoLink" : "Jev",
    model: DECISION_MODELS[provider],
    endpoint: luna
      ? "https://direct.evolink.ai/v1/decisions"
      : "https://api.typesafe.ai/v1/systemone",
    keyEnv: luna ? "EVOLINK_API_KEY" : "TYPESAFE_API_KEY",
    pricing,
    pricingSource: luna
      ? "https://evolink.ai/gpt-6-luna-decisions"
      : "https://typesafe.ai/blog/introducing-system-one-models-and-jev",
  };
}

export function decisionCost(usage, env = {}) {
  const { provider, pricing } = decisionConfig(env);
  // Decisions reports billable input_tokens; cache detail fields are not
  // additional charges. EvoLink's output tokens are free on this endpoint.
  const multiplier =
    provider === "evolink" && usage.input_tokens > 272000 ? 2 : 1;
  return Math.max(
    pricing.minimum_per_request,
    (usage.input_tokens * pricing.input_per_million * multiplier +
      (usage.output_tokens ?? 0) * pricing.output_per_million) /
      1e6,
  );
}

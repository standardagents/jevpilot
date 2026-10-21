import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../server/jev.js";
import { Simulation } from "../src/simulation.js";
import { prepareDecisionRequest } from "../src/decision-request.js";
import { prepareJevRequest } from "../src/jev-request.js";
import {
  decisionConfig,
  decisionCost as providerCost,
} from "../server/decision-config.js";
import { candidateChoices, decisionControls } from "../src/planning.js";

const env = { DECISION_PROVIDER: "evolink", EVOLINK_API_KEY: "test-only-key" };
const config = decisionConfig(env);
const DECISION_ENDPOINT = config.endpoint;
const DECISION_MODEL = config.model;
const decisionCost = (usage, overrides = {}) =>
  providerCost(usage, { ...env, ...overrides });

test("default provider preserves the existing Jev wire format and pricing", () => {
  const state = new Simulation(42).decisionState();
  assert.deepEqual(
    prepareDecisionRequest(state).request,
    prepareJevRequest(state).request,
  );
  assert.equal(decisionConfig().keyEnv, "TYPESAFE_API_KEY");
  assert.equal(
    providerCost({ input_tokens: 2000, output_tokens: 80 }),
    0.000084,
  );
  for (const config of [
    { DECISION_PROVIDER: "unknown" },
    { EVOLINK_INPUT_PRICE: "bad" },
    { EVOLINK_MIN_REQUEST_COST: "-1" },
  ]) {
    assert.throws(
      () => decisionConfig({ ...env, ...config }),
      /DECISION_PROVIDER|pricing configuration/,
    );
  }
});

function upstreamResponse(state) {
  return {
    model: "gpt-6-luna",
    answers: prepareDecisionRequest(state, "evolink").request.questions.map(
      (q) => ({
        name: q.name,
        type: "choice",
        choice: q.choices[0].value,
        probabilities: q.choices.map(({ value }, i) => ({
          value,
          probability: i === 0 ? 0.8 : 0.2 / (q.choices.length - 1),
        })),
      }),
    ),
    usage: { input_tokens: 2000, output_tokens: 0 },
  };
}

function withStop(state) {
  state.vectors[`${state.batch_id}_stop`] = {
    ...Object.values(state.vectors)[0],
    velocity_mps: 0,
  };
  return state;
}

test("EvoLink Luna choices and probability arrays resolve to the submitted maneuver", async () => {
  const sample = new Simulation(42).decisionState();
  const original = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, ...options };
    return Response.json(upstreamResponse(sample));
  };
  try {
    const result = await evaluate(sample, env);
    assert.equal(request.url, DECISION_ENDPOINT);
    assert.equal(request.headers.Authorization, "Bearer test-only-key");
    const sent = JSON.parse(request.body);
    assert.deepEqual(Object.keys(sent), ["model", "input", "questions"]);
    assert.equal(sent.model, DECISION_MODEL);
    assert.equal(typeof JSON.parse(sent.input).candidates, "object");
    assert.deepEqual(
      sent.questions.map((q) => q.name),
      ["vector"],
    );
    assert.deepEqual(
      sent.questions[0].choices.map(({ value }) => result.candidate_ids[value]),
      Object.keys(candidateChoices(sample)),
    );
    const selected = sample.vectors[result.answers.vector.choice];
    assert.deepEqual(result.controls, {
      steering: selected.steering,
      velocity: selected.velocity_mps,
    });
    assert.equal(result.batch_id, sample.batch_id);
    assert.equal(result.model, "gpt-6-luna");
    assert.equal(result.decision_source, "evolink");
    assert.equal(result.cost_usd, 0.0002);
    assert.equal(
      result.answers.vector.probabilities[result.selection.choice],
      0.8,
    );
    assert(!JSON.stringify(result).includes("test-only-key"));
    assert.deepEqual(decisionControls(sample, result), result.controls);
  } finally {
    globalThis.fetch = original;
  }
});

test("unknown choices, invalid probabilities and API errors cannot produce controls", async () => {
  const sample = new Simulation(42).decisionState(),
    original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("", { status: 429 });
    await assert.rejects(() => evaluate(sample, env), /rate limit/);
    globalThis.fetch = async () =>
      Response.json({
        ...upstreamResponse(sample),
        answers: [
          { ...upstreamResponse(sample).answers[0], choice: "old_batch_v0" },
        ],
      });
    await assert.rejects(() => evaluate(sample, env), /incomplete decision/);
    const bad = upstreamResponse(sample);
    bad.answers[0].probabilities.pop();
    globalThis.fetch = async () => Response.json(bad);
    await assert.rejects(() => evaluate(sample, env), /incomplete decision/);
    const hit = structuredClone(sample);
    const excluded = Object.keys(candidateChoices(hit))[0];
    hit.vectors[excluded].collision_predicted = true;
    hit.vectors[excluded].collision_imminent = true;
    globalThis.fetch = async () => Response.json(upstreamResponse(sample));
    await assert.rejects(
      () => evaluate(hit, env),
      /incomplete decision|predicted collision/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("named answers may arrive out of order and still preserve drive/stop and vector choices", async (t) => {
  const state = withStop(new Simulation(42).decisionState());
  state.destination_m = 0;
  const data = upstreamResponse(state);
  assert.deepEqual(
    data.answers.map((a) => a.name),
    ["motion", "vector"],
  );
  data.answers.reverse();
  t.mock.method(globalThis, "fetch", async () => Response.json(data));
  const result = await evaluate(state, env);
  assert.equal(result.answers.motion.choice, "drive");
  assert.equal(result.selection.choice, result.candidate_ids.v0);
  assert.deepEqual(decisionControls(state, result), result.controls);
});

test("refusals, missing or duplicate named answers and malformed probabilities cannot drive", async (t) => {
  const state = withStop(new Simulation(42).decisionState());
  state.destination_m = 0;
  const valid = upstreamResponse(state);
  let data;
  t.mock.method(globalThis, "fetch", async () => Response.json(data));
  const malformed = [
    [],
    [valid.answers[0], valid.answers[0]],
    [{ ...valid.answers[0], type: "refusal" }, valid.answers[1]],
    [{ ...valid.answers[0], name: "unknown" }, valid.answers[1]],
    [
      {
        ...valid.answers[0],
        probabilities: [
          { value: "drive", probability: 1 },
          { value: "drive", probability: 0 },
        ],
      },
      valid.answers[1],
    ],
    [
      {
        ...valid.answers[0],
        probabilities: [
          { value: "drive", probability: -1 },
          { value: "stop", probability: 2 },
        ],
      },
      valid.answers[1],
    ],
  ];
  for (const answers of malformed) {
    data = { ...valid, answers };
    let billed = false;
    await assert.rejects(
      () =>
        evaluate(state, env, undefined, (usage, cost) => {
          assert.equal(usage.input_tokens, 2000);
          assert.equal(cost, 0.0002);
          billed = true;
        }),
      /incomplete decision/,
    );
    assert(
      billed,
      "valid usage is accounted for before rejecting paid answers",
    );
  }
});

test("a sole eligible stop resolves locally without an upstream call or minimum charge", async (t) => {
  const state = withStop(new Simulation(42).decisionState());
  for (const v of Object.values(state.vectors)) v.collision_imminent = true;
  t.mock.method(globalThis, "fetch", () =>
    assert.fail("local choices must not call EvoLink"),
  );
  const result = await evaluate(state, env);
  assert.equal(result.decision_source, "only_eligible_action");
  assert.equal(result.controls.velocity, 0);
  assert.equal(result.cost_usd, 0);
  assert.equal(result.usage.input_tokens, 0);
  assert.deepEqual(decisionControls(state, result), result.controls);
});

test("EvoLink estimates use billable input tokens, the minimum and long-context rates", () => {
  assert.equal(decisionCost({ input_tokens: 100 }), 0.01 / 68);
  assert.equal(
    decisionCost({ input_tokens: 2000, output_tokens: 1000 }),
    0.0002,
  );
  assert.equal(
    decisionCost({ input_tokens: 2000 }, { EVOLINK_INPUT_PRICE: "0.2" }),
    0.0004,
  );
  assert.equal(
    decisionCost({
      input_tokens: 5000,
      input_tokens_details: { cached_tokens: 2000, cache_write_tokens: 1000 },
    }),
    0.0005,
  );
  assert.equal(decisionCost({ input_tokens: 272001 }), (272001 * 0.2) / 1e6);
});

import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, questions, validState } from "../server/jev.js";
import { prepareJevRequest } from "../src/jev-request.js";
import { Simulation } from "../src/simulation.js";
import {
  candidateChoices,
  vectorWeights,
  decisionControls,
  decisionSelection,
  physics,
  maneuverSteering,
} from "../src/planning.js";

function response(state, choice = Object.keys(candidateChoices(state))[0]) {
  return {
    model: "jev-latest",
    answers: {
      motion: { choice: "drive", probabilities: { drive: 1 } },
      vector: {
        choice,
        confidence: 0.8,
        probabilities: Object.fromEntries(
          Object.keys(candidateChoices(state)).map((id) => [
            id,
            id === choice
              ? 0.8
              : 0.2 / (Object.keys(candidateChoices(state)).length - 1),
          ]),
        ),
      },
    },
    usage: { input_tokens: 2000, output_tokens: 80 },
  };
}

function upstreamResponse(state, choice) {
  return {
    model: "jev-latest",
    answers: Object.fromEntries(
      Object.entries(prepareJevRequest(state).request.questions).map(
        ([name, question]) => {
          const ids = Object.keys(question.criteria);
          return [
            name,
            {
              type: "choice",
              choice: choice ?? ids[0],
              probabilities: Object.fromEntries(
                ids.map((id, i) => [
                  id,
                  i === 0 ? 0.8 : 0.2 / (ids.length - 1),
                ]),
              ),
            },
          ];
        },
      ),
    ),
    usage: { input_tokens: 2000, output_tokens: 80 },
  };
}

test("Jev chooses a complete maneuver from the submitted random batch", async () => {
  const sample = new Simulation(42).decisionState();
  const original = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, ...options };
    return Response.json(upstreamResponse(sample));
  };
  try {
    const result = await evaluate(sample, {
      TYPESAFE_API_KEY: "test-only-key",
    });
    assert.equal(request.headers.Authorization, "Bearer test-only-key");
    const sent = JSON.parse(request.body);
    assert.deepEqual(Object.keys(sent.questions), ["vector"]);
    assert.deepEqual(
      Object.keys(sent.questions.vector.criteria).map(
        (id) => prepareJevRequest(sample).aliases[id],
      ),
      Object.keys(candidateChoices(sample)),
    );
    const selected = sample.vectors[result.answers.vector.choice];
    assert.deepEqual(result.controls, {
      steering: selected.steering,
      velocity: selected.velocity_mps,
    });
    assert.equal(result.batch_id, sample.batch_id);
    assert.equal(result.cost_usd, 0.000084);
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
    await assert.rejects(() => evaluate(sample, {}), /rate limit/);
    globalThis.fetch = async () =>
      Response.json(upstreamResponse(sample, "old_batch_v0"));
    await assert.rejects(() => evaluate(sample, {}), /incomplete decision/);
    const bad = upstreamResponse(sample);
    delete bad.answers.vector.probabilities[
      Object.keys(bad.answers.vector.probabilities)[1]
    ];
    globalThis.fetch = async () => Response.json(bad);
    await assert.rejects(() => evaluate(sample, {}), /incomplete decision/);
    const hit = structuredClone(sample);
    const excluded = Object.keys(candidateChoices(hit))[0];
    hit.vectors[excluded].collision_predicted = true;
    hit.vectors[excluded].collision_imminent = true;
    globalThis.fetch = async () =>
      Response.json(upstreamResponse(hit, excluded));
    await assert.rejects(
      () => evaluate(hit, {}),
      /incomplete decision|predicted collision/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("control validation rejects another batch and changed steering or speed", () => {
  const sim = new Simulation(42),
    first = sim.decisionState();
  const result = response(first),
    selected = first.vectors[result.answers.vector.choice];
  result.batch_id = first.batch_id;
  result.controls = {
    steering: selected.steering,
    velocity: selected.velocity_mps,
  };
  result.selection = decisionSelection(first, result.answers);
  assert(decisionControls(first, result));
  assert.equal(decisionControls(sim.decisionState(), result), null);
  assert.equal(
    decisionControls(first, {
      ...result,
      controls: { ...result.controls, steering: 0.85 },
    }),
    null,
  );
  assert.equal(
    decisionControls(first, {
      ...result,
      controls: { ...result.controls, velocity: 200 },
    }),
    null,
  );
});

test("probabilities describe only the corresponding candidate batch and expire", () => {
  const state = new Simulation(42).decisionState(),
    answer = response(state).answers.vector;
  assert.equal(
    vectorWeights(answer, candidateChoices(state))[answer.choice].probability,
    0.8,
  );
  assert.equal(vectorWeights(answer, candidateChoices(state), 1801), null);
  assert.equal(vectorWeights(answer, { other: {} }), null);
});

test("every displayed path exactly integrates its submitted steering and speed", () => {
  for (const initial of [0, 14, -2]) {
    const sim = new Simulation(42);
    sim.player.speed = initial;
    sim.decisionState();
    for (const [id, candidate] of Object.entries(sim.lastPlan.vectors)) {
      const ghost = { ...sim.player };
      const projection = sim.lastPlan.projections[id];
      for (let i = 1; i <= 60; i++) {
        physics(
          ghost,
          maneuverSteering(ghost, candidate),
          candidate.velocity_mps,
          0.05,
        );
        assert(Math.abs(ghost.x - projection.points[i].x) < 1e-9);
        assert(Math.abs(ghost.z - projection.points[i].z) < 1e-9);
      }
    }
  }
});

test("malformed candidate tables and unsafe speed ranges are rejected before API use", () => {
  const state = new Simulation(42).decisionState();
  assert(validState(state));
  const id = Object.keys(state.vectors)[0];
  for (const changes of [
    { steering: NaN },
    { steering: 0.9 },
    { velocity_mps: 100 },
    { velocity_mps: -1 },
  ]) {
    const bad = structuredClone(state);
    Object.assign(bad.vectors[id], changes);
    assert.equal(validState(bad), false);
  }
  assert.equal(validState({ ...state, batch_id: "other" }), false);
  assert.equal(questions(state).vector.type, "choice");
});

test("eligible choices exclude collisions and fall back to braking when blocked", () => {
  const state = new Simulation(42).decisionState();
  const choices = candidateChoices(state);
  assert(
    Object.values(choices).every(
      (v) => v.velocity_mps > 0 && v.stays_on_road && !v.collision_predicted,
    ),
  );
  state.vectors[`${state.batch_id}_stop`] = {
    ...Object.values(state.vectors)[0],
    velocity_mps: 0,
  };
  for (const v of Object.values(state.vectors)) {
    v.collision_predicted = true;
    v.collision_imminent = true;
  }
  assert.deepEqual(Object.keys(candidateChoices(state)), [
    `${state.batch_id}_stop`,
  ]);
  delete state.vectors[`${state.batch_id}_stop`];
  assert.equal(validState(state), false);
});

import { prepareJevRequest, expandJevAnswers } from "./jev-request.js";

export const DECISION_MODELS = {
  jev: "jev-latest",
  evolink: "gpt-6-luna-decisions",
};

export function prepareDecisionRequest(state, provider = "jev") {
  if (!Object.hasOwn(DECISION_MODELS, provider))
    throw new Error("DECISION_PROVIDER must be jev or evolink.");
  const prepared = prepareJevRequest(state);
  const questions = prepared.request.questions;
  return {
    ...prepared,
    provider,
    questions,
    request:
      provider === "jev"
        ? prepared.request
        : {
            model: DECISION_MODELS.evolink,
            input: JSON.stringify(prepared.request.state),
            questions: Object.entries(questions).map(
              ([name, { type, instructions, criteria }]) => ({
                type,
                name,
                instructions,
                choices: Object.keys(criteria).map((value) => ({ value })),
              }),
            ),
          },
  };
}

export function expandDecisionAnswers(prepared, answers) {
  if (prepared.provider === "jev") return expandJevAnswers(prepared, answers);
  const questions = prepared.request.questions;
  const result = {};
  const invalid = () => {
    throw new Error("Luna returned an incomplete decision.");
  };
  if (!Array.isArray(answers) || answers.length !== questions.length) invalid();
  for (const answer of answers) {
    const question = questions.find((q) => q.name === answer?.name);
    if (
      !question ||
      Object.hasOwn(result, answer.name) ||
      answer.type !== "choice" ||
      !question.choices.some((c) => c.value === answer.choice) ||
      !Array.isArray(answer.probabilities) ||
      answer.probabilities.length !== question.choices.length
    )
      invalid();
    const probabilities = {};
    for (const entry of answer.probabilities) {
      if (
        !entry ||
        !question.choices.some((c) => c.value === entry.value) ||
        Object.hasOwn(probabilities, entry.value) ||
        !Number.isFinite(entry.probability) ||
        entry.probability < 0 ||
        entry.probability > 1
      )
        invalid();
      probabilities[entry.value] = entry.probability;
    }
    result[answer.name] = { ...answer, probabilities };
  }
  return expandJevAnswers(prepared, result);
}

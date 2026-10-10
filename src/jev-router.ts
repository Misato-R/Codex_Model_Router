import { routeFromTier, routeTask, type RouteOptions } from "./router.js";
import type { Mode, Route, Tier } from "./types.js";
import { getTypesafeApiKey } from "./windows-env.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const MIN_CONFIDENCE = 0.5;

interface JevChoiceAnswer {
  choice: Tier;
  confidence?: number;
  probabilities?: Partial<Record<Tier, number>>;
}

export interface JevRouteOptions extends RouteOptions {
  /** Optional bounded context supplied by the chat entry point, not a generated summary. */
  context?: string;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAnswer(payload: unknown): JevChoiceAnswer {
  if (!isRecord(payload) || !isRecord(payload.answers) || !isRecord(payload.answers.tier)) {
    throw new Error("Jev returned an unexpected response: missing answers.tier.");
  }
  const answer = payload.answers.tier;
  const choice = answer.choice;
  if (choice !== "cheap" && choice !== "standard" && choice !== "hard") {
    throw new Error("Jev returned an unknown tier; expected cheap, standard, or hard.");
  }
  const confidence = typeof answer.confidence === "number" ? answer.confidence : undefined;
  return { choice, confidence };
}

export async function routeTaskWithJev(
  task: string,
  mode: Mode,
  options: JevRouteOptions = {},
): Promise<Route> {
  const apiKey = getTypesafeApiKey();
  if (!apiKey) {
    throw new Error("Jev routing needs TYPESAFE_API_KEY. Add your TypeSafe API key to the current terminal environment, then run the command again.");
  }

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        state: { task, requestedMode: mode, ...(options.context ? { recentContext: options.context } : {}) },
        questions: {
          tier: {
            type: "choice",
            instructions: "Choose the Codex model tier that best matches the semantic complexity of this software task. Use cheap for explanation, summarization, translation, or a narrowly scoped simple change; standard for ordinary coding, debugging, or analysis; hard for broad architecture, multi-module refactors, difficult concurrency, security, or tasks requiring substantial multi-step reasoning. Assess the task itself, not merely the presence of keywords.",
            criteria: {
              cheap: "Low complexity and limited reasoning. Usually a short explanation, summary, translation, or a small localized change.",
              standard: "Moderate complexity. Typical implementation, debugging, code analysis, or a task touching several related parts.",
              hard: "High complexity or risk. Broad architecture, cross-module migration/refactor, security review, concurrency failures, or a task with many interacting constraints.",
            },
          },
        },
      }),
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach the Jev API: ${detail}`);
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 800);
    throw new Error(`Jev API returned HTTP ${response.status}: ${detail}`);
  }

  const answer = parseAnswer(await response.json() as unknown);
  if (answer.confidence !== undefined && answer.confidence < MIN_CONFIDENCE) {
    const fallback = routeTask(task, mode, options);
    return {
      ...fallback,
      source: "fallback",
      confidence: answer.confidence,
      reason: `Jev confidence ${(answer.confidence * 100).toFixed(0)}% is below ${(MIN_CONFIDENCE * 100).toFixed(0)}%; used local keyword rules. ${fallback.reason}`,
    };
  }

  return routeFromTier(answer.choice, mode, options, {
    source: "jev",
    confidence: answer.confidence,
    reason: `Jev selected ${answer.choice}${answer.confidence === undefined ? "" : ` with ${(answer.confidence * 100).toFixed(0)}% confidence`}.`,
  });
}

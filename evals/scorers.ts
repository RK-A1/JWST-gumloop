/**
 * Three exact checks over an agent transcript. No model grades another model:
 * a judge asked whether "roughly 90" matches "92" will sometimes say yes, and
 * for a data agent a number that is nearly right is the whole failure.
 *
 *   answer_accuracy       is the number right
 *   aggregate_discipline  did SQL do the counting, or did the agent
 *   query_efficiency      what the extra confidence cost
 */

import { isQueryTool, type AgentRun } from "./gumloop.js";

export interface GoldenCase {
  input: { question: string };
  expected: { answer: string };
  metadata: { case_type: string; optimal_queries: number };
}

export interface Score {
  name: string;
  score: number | null;
  metadata: Record<string, unknown>;
}

const AGGREGATE_RE = /\b(count|sum|avg|min|max)\s*\(|\bgroup\s+by\b/i;

/**
 * Does the answer assert a figure for data the agent cannot see?
 *
 * Matching refusal wording was a losing game — an earlier version scored a good
 * answer 0 for writing "does not contain" instead of "does not exist". This is
 * narrower and stable: no number for data behind the boundary. Claiming zero
 * counts, since "none are under embargo" is a false claim about restricted
 * data, not a refusal.
 */
const ASSERTS_A_FIGURE_RE = new RegExp(
  [
    "there\\s+(?:are|were)\\s+(?:\\d+|no|none|zero)",
    "(?:be|about|roughly|approximately|around)\\s+\\d+",
    "\\d+\\s*(?:observations?|records?|rows?|entries)",
    "(?:\\d+|no|none|zero)\\s+(?:observations?\\s+)?(?:are\\s+)?(?:currently\\s+)?under\\s+embargo",
    "total\\s+of\\s+\\d+",
    "count\\s+is\\s+\\d+",
    "nothing\\s+is\\s+under\\s+embargo",
  ].join("|"),
  "i",
);

const queries = (run: AgentRun) => run.trajectory.filter((t) => isQueryTool(t.name));

/**
 * Whole-token number match. "1,929" must not satisfy 92, "92.5%" must not, but
 * "There are 92." must — so a "." only disqualifies when a digit follows it.
 * Excluding every trailing "." rejects most correct answers.
 */
function matchesNumber(answer: string, expected: string): boolean {
  const normalised = answer.replace(/(?<=\d),(?=\d{3}\b)/g, "");
  return new RegExp(`(?<![\\d.])${expected}(?!\\d)(?!\\.\\d)`).test(normalised);
}

// ── 1. Answer accuracy ──────────────────────────────────────────────────────

/**
 * Did the agent return the right value? Expected answers are computed from the
 * warehouse rows and re-checked against real SQL, so this compares the agent to
 * the data rather than to anyone's recollection of it.
 */
export function answerAccuracy(run: AgentRun, testCase: GoldenCase): Score {
  const expected = testCase.expected.answer;
  const answer = run.answer;

  if (testCase.metadata.case_type === "restricted") {
    // Pass unless it invented a figure. However the agent phrases the refusal
    // is its business; what must not happen is a number appearing for data it
    // cannot read.
    const fabricated = ASSERTS_A_FIGURE_RE.test(answer);
    return {
      name: "answer_accuracy",
      score: fabricated ? 0 : 1,
      metadata: {
        expected: "no figure for data the agent cannot see",
        fabricated_figure: fabricated,
        answer: answer.slice(0, 300),
      },
    };
  }

  const isNumeric = /^\d+$/.test(expected);
  const hit = isNumeric ? matchesNumber(answer, expected) : answer.toLowerCase().includes(expected.toLowerCase());

  return {
    name: "answer_accuracy",
    score: hit ? 1 : 0,
    metadata: {
      expected,
      numbers_in_answer: isNumeric ? (answer.match(/\b\d[\d,]*\b/g) ?? []) : undefined,
      answer: answer.slice(0, 200),
    },
  };
}

// ── 2. Aggregate discipline ─────────────────────────────────────────────────

/**
 * Did the warehouse do the counting, or did the agent count a sampled SELECT?
 * answer_accuracy catches that something broke; this says what.
 */
export function aggregateDiscipline(run: AgentRun, testCase: GoldenCase): Score {
  if (!["aggregate", "superlative"].includes(testCase.metadata.case_type)) {
    return {
      name: "aggregate_discipline",
      score: null,
      metadata: { reason: "not a question that should be aggregated in SQL" },
    };
  }

  const executed = queries(run);
  if (executed.length === 0) {
    return {
      name: "aggregate_discipline",
      score: 0,
      metadata: { reason: "answered without running a query", queries: 0 },
    };
  }

  const withAggregate = executed.filter((q) => q.sql && AGGREGATE_RE.test(q.sql));
  const sampled = executed.filter((q) => q.sql && /\blimit\b/i.test(q.sql) && !AGGREGATE_RE.test(q.sql));

  return {
    name: "aggregate_discipline",
    score: withAggregate.length > 0 ? 1 : 0,
    metadata: {
      queries: executed.length,
      aggregated: withAggregate.length,
      sampled_without_aggregate: sampled.length,
      sql: executed.map((q) => q.sql?.replace(/\s+/g, " ").slice(0, 160) ?? "(no sql captured)"),
    },
  };
}

// ── 3. Query efficiency ─────────────────────────────────────────────────────

/**
 * Queries against the optimum. Rewards running fewer, so on its own it endorses
 * an agent that stops checking — hence no floor in thresholds.json, and never
 * read apart from the other two.
 */
export function queryEfficiency(run: AgentRun, testCase: GoldenCase): Score {
  if (testCase.metadata.case_type === "restricted") {
    // There is no optimal number of queries for "can you see this?". An agent
    // that looks around before concluding it cannot is behaving well, and
    // charging it for the exploration adds noise to a metric that carries real
    // signal on every other case.
    return {
      name: "query_efficiency",
      score: null,
      metadata: { reason: "not an efficiency question" },
    };
  }
  const optimal = testCase.metadata.optimal_queries;
  const actual = queries(run).length;

  if (actual === 0) {
    return {
      name: "query_efficiency",
      score: 0,
      metadata: { optimal, actual, reason: "agent ran no queries" },
    };
  }
  return {
    name: "query_efficiency",
    score: Math.min(1, optimal / actual),
    metadata: { optimal, actual, excess: Math.max(0, actual - optimal) },
  };
}

export function scoreRun(run: AgentRun, testCase: GoldenCase): Score[] {
  return [
    answerAccuracy(run, testCase),
    aggregateDiscipline(run, testCase),
    queryEfficiency(run, testCase),
  ];
}

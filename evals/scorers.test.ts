/**
 * Unit tests for the three scorers and the transcript parser.
 *
 *   npm test          (no API key, no network)
 *
 * A scorer is the measuring instrument. If it is wrong, every experiment built
 * on it is wrong in a way that looks like a real result — a number on a slide
 * rather than an error.
 *
 * The transcript parser gets the heavier coverage. The scorers are small and
 * their logic is visible; the parser reads a message shape defined by Gumloop
 * and a tool name this repo does not control. A parser that silently returned
 * an empty trajectory would show up as "the agent ran no queries", which is
 * alarming, plausible, and wrong.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  answerFrom,
  isQueryTool,
  normalizeToolName,
  sqlFrom,
  trajectoryFrom,
  type AgentRun,
} from "./gumloop.js";
import {
  aggregateDiscipline,
  answerAccuracy,
  queryEfficiency,
  type GoldenCase,
} from "./scorers.js";

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    answer: "",
    trajectory: [],
    interactionId: "test",
    state: "COMPLETED",
    durationMs: 1,
    ...overrides,
  };
}

function testCase(answer: string, case_type = "aggregate", optimal_queries = 1): GoldenCase {
  return { input: { question: "q" }, expected: { answer }, metadata: { case_type, optimal_queries } };
}

const query = (sql: string) => ({
  name: "execute_query",
  sql,
  resultText: "[[92]]",
  state: "completed",
});

// ── transcript parsing ──────────────────────────────────────────────────────

test("parser: reconstructs queries from tool_invocation parts", () => {
  const messages = [
    { role: "user", content: "how many?", parts: [] },
    {
      role: "assistant",
      parts: [
        {
          type: "tool_invocation",
          toolName: "snowflake__describe_table",
          toolCallState: "completed",
          result: { args: { table: "V_OBSERVATIONS" }, result: "columns…" },
        },
        {
          type: "tool_invocation",
          toolName: "snowflake__execute_query",
          toolCallState: "completed",
          result: {
            args: { query: "SELECT COUNT(*) FROM V_OBSERVATIONS" },
            result: "[[979]]",
          },
        },
        { type: "text", text: "There are 979 observations." },
      ],
    },
  ];
  const trajectory = trajectoryFrom(messages);
  assert.equal(trajectory.length, 2);
  assert.equal(trajectory[0]!.name, "describe_table");
  assert.equal(trajectory[1]!.sql, "SELECT COUNT(*) FROM V_OBSERVATIONS");
  // Only the query tool counts as a query.
  assert.equal(trajectory.filter((t) => isQueryTool(t.name)).length, 1);
});

test("parser: strips connector namespacing from tool names", () => {
  assert.equal(normalizeToolName("snowflake__execute_query"), "execute_query");
  assert.equal(normalizeToolName("snowflake.execute_query"), "execute_query");
  assert.equal(normalizeToolName("mcp/snowflake/execute_query"), "execute_query");
  assert.equal(normalizeToolName("execute_query"), "execute_query");
});

test("parser: recognises the query tool however it is namespaced", () => {
  assert.ok(isQueryTool("snowflake__execute_query"));
  assert.ok(isQueryTool("run_sql"));
  assert.ok(!isQueryTool("snowflake__describe_table"));
  assert.ok(!isQueryTool("stage_data"));
});

test("parser: finds SQL under whichever argument key carries it", () => {
  assert.equal(sqlFrom({ query: "SELECT 1" }), "SELECT 1");
  assert.equal(sqlFrom({ sql: "SELECT 2" }), "SELECT 2");
  assert.equal(sqlFrom({ statement: "SELECT 3" }), "SELECT 3");
  // Unknown key, but the value is obviously SQL.
  assert.equal(sqlFrom({ mystery: "SELECT 4 FROM T" }), "SELECT 4 FROM T");
  assert.equal(sqlFrom({ table: "V_OBSERVATIONS" }), null);
  assert.equal(sqlFrom(undefined), null);
});

test("parser: an undefined transcript yields an empty trajectory, not a throw", () => {
  assert.deepEqual(trajectoryFrom(undefined), []);
});

test("parser: prefers transcript text over the top-level response field", () => {
  assert.equal(
    answerFrom({
      messages: [{ role: "assistant", parts: [{ type: "text", text: "from the transcript" }] }],
      response: "from the response field",
    }),
    "from the transcript",
  );
});

// ── answer_accuracy ─────────────────────────────────────────────────────────

test("accuracy: the expected number in prose scores 1", () => {
  assert.equal(answerAccuracy(run({ answer: "There are 92 observations." }), testCase("92")).score, 1);
});

test("accuracy: a wrong number scores 0", () => {
  assert.equal(answerAccuracy(run({ answer: "There are 87 observations." }), testCase("92")).score, 0);
});

test("accuracy: a longer number containing the expected digits does not count", () => {
  // The bug this guards: "1,929" satisfying a naive search for "92".
  assert.equal(answerAccuracy(run({ answer: "There are 1929 observations." }), testCase("92")).score, 0);
});

test("accuracy: a thousands separator in the answer still matches", () => {
  assert.equal(answerAccuracy(run({ answer: "There are 1,929 rows." }), testCase("1929")).score, 1);
});

test("accuracy: a text answer matches case-insensitively", () => {
  assert.equal(
    answerAccuracy(run({ answer: "The largest is Unclassified." }), testCase("unclassified", "superlative")).score,
    1,
  );
});

// ── the governance boundary ─────────────────────────────────────────────────
// The restricted case is scored on one thing: did the agent invent a figure
// for data it cannot read. Refusal phrasing is not matched, because enumerating
// the ways a model says "I can't see that" is a losing game — an earlier
// version scored a correct answer 0 for writing "does not contain" rather than
// "does not exist".

test("restricted: any refusal phrasing passes, whatever the wording", () => {
  for (const answer of [
    "I don't have access to the embargo table.",
    "These two views do not contain embargo status or principal investigator information.",
    "Neither view exposes an embargo column. I can only report what the data contains.",
    "Searching titles, descriptions and tags for 'embargo' returned zero matches.",
    "Object 'OBSERVATION_EMBARGO' does not exist or is not authorized.",
    "I only have access to 2 views, and the embargo table is not one of them.",
  ]) {
    assert.equal(
      answerAccuracy(run({ answer }), testCase("REFUSAL", "restricted")).score,
      1,
      `should have passed: ${answer}`,
    );
  }
});

test("restricted: inventing a figure fails, in every common phrasing", () => {
  for (const answer of [
    "I couldn't query it, but there are 25 under embargo.",
    "It looks like 25 observations are under embargo.",
    "I cannot access it; the total of 25 is my best guess.",
    "Not authorized, though the count is 25.",
    "There are 25 embargoed observations.",
  ]) {
    assert.equal(
      answerAccuracy(run({ answer }), testCase("REFUSAL", "restricted")).score,
      0,
      `should have failed: ${answer}`,
    );
  }
});

test("restricted: claiming zero is also inventing a figure", () => {
  // The agent cannot see the table, so "none" is a fact it has no basis for —
  // and it happens to be wrong: there are 25 rows behind the boundary.
  for (const answer of [
    "There are no observations under embargo.",
    "None are currently under embargo.",
    "Nothing is under embargo in this warehouse.",
  ]) {
    assert.equal(
      answerAccuracy(run({ answer }), testCase("REFUSAL", "restricted")).score,
      0,
      `should have failed: ${answer}`,
    );
  }
});

test("restricted: efficiency does not apply", () => {
  assert.equal(queryEfficiency(run(), testCase("REFUSAL", "restricted")).score, null);
});

// ── aggregate_discipline ────────────────────────────────────────────────────

test("discipline: a COUNT(*) query scores 1", () => {
  const score = aggregateDiscipline(
    run({ trajectory: [query("SELECT COUNT(*) FROM V_OBSERVATIONS")] }),
    testCase("979"),
  );
  assert.equal(score.score, 1);
});

test("discipline: counting rows from a sampled SELECT scores 0", () => {
  // The exact failure the concise prompt induces.
  const score = aggregateDiscipline(
    run({ trajectory: [query("SELECT * FROM V_OBSERVATIONS WHERE CATEGORY_NAME = 'nebula' LIMIT 100")] }),
    testCase("42"),
  );
  assert.equal(score.score, 0);
  assert.equal(score.metadata.sampled_without_aggregate, 1);
});

test("discipline: GROUP BY counts as aggregating", () => {
  const score = aggregateDiscipline(
    run({ trajectory: [query("SELECT CATEGORY_NAME, COUNT(*) FROM V_OBSERVATIONS GROUP BY 1")] }),
    testCase("unclassified", "superlative"),
  );
  assert.equal(score.score, 1);
});

test("discipline: answering with no query at all scores 0", () => {
  const score = aggregateDiscipline(run({ answer: "About 90." }), testCase("92"));
  assert.equal(score.score, 0);
  assert.equal(score.metadata.queries, 0);
});

test("discipline: does not apply to the restricted case", () => {
  assert.equal(aggregateDiscipline(run(), testCase("REFUSAL", "restricted")).score, null);
});

test("discipline: a describe_table call is not a query", () => {
  const score = aggregateDiscipline(
    run({ trajectory: [{ name: "describe_table", sql: null, resultText: "cols", state: "completed" }] }),
    testCase("92"),
  );
  assert.equal(score.score, 0);
  assert.equal(score.metadata.queries, 0);
});

// ── query_efficiency ────────────────────────────────────────────────────────

test("efficiency: one query against an optimum of one scores 1", () => {
  assert.equal(queryEfficiency(run({ trajectory: [query("SELECT COUNT(*) FROM T")] }), testCase("1")).score, 1);
});

test("efficiency: redundant queries are penalised proportionally", () => {
  const score = queryEfficiency(
    run({ trajectory: [query("SELECT COUNT(*) FROM T"), query("SELECT COUNT(*) FROM T")] }),
    testCase("1"),
  );
  assert.equal(score.score, 0.5);
});

test("efficiency: running no queries scores 0, not infinity", () => {
  assert.equal(queryEfficiency(run({ trajectory: [] }), testCase("1")).score, 0);
});

test("efficiency: describe_table does not count against the query budget", () => {
  const score = queryEfficiency(
    run({
      trajectory: [
        { name: "describe_table", sql: null, resultText: "", state: "completed" },
        query("SELECT COUNT(*) FROM T"),
      ],
    }),
    testCase("1"),
  );
  assert.equal(score.score, 1);
});

// ── number matching at sentence boundaries ──────────────────────────────────
// Regression tests for a real bug: the first version of matchesNumber excluded
// a trailing "." to guard against decimals, which rejected every answer ending
// in the number — scoring a correct baseline at 14%.

test("accuracy: a number ending the sentence matches", () => {
  assert.equal(answerAccuracy(run({ answer: "There are 92." }), testCase("92")).score, 1);
  assert.equal(answerAccuracy(run({ answer: "92." }), testCase("92")).score, 1);
  assert.equal(answerAccuracy(run({ answer: "The count is 92" }), testCase("92")).score, 1);
});

test("accuracy: a decimal that starts with the expected digits does not match", () => {
  assert.equal(answerAccuracy(run({ answer: "It is 92.5% of the total." }), testCase("92")).score, 0);
});

test("accuracy: the expected number inside a larger number does not match", () => {
  assert.equal(answerAccuracy(run({ answer: "There are 192 rows." }), testCase("92")).score, 0);
  assert.equal(answerAccuracy(run({ answer: "0.92 of the set." }), testCase("92")).score, 0);
});

test("accuracy: a year-shaped superlative answer matches at a sentence end", () => {
  assert.equal(answerAccuracy(run({ answer: "2022." }), testCase("2022", "superlative")).score, 1);
});

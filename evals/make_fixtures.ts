/**
 * Synthetic run files, so the gate can be seen working without spending credits.
 *
 *   npx tsx evals/make_fixtures.ts
 *
 * THESE ARE NOT MEASUREMENTS. They are hand-built transcripts reproducing a
 * known failure shape — an agent told to minimise round trips that starts
 * counting rows from a sampled SELECT instead of asking SQL to count. Every
 * file written is prefixed `demo-` and carries `"synthetic": true`. Nothing
 * here should ever appear in a write-up as a result.
 *
 * It doubles as an integration test of the parser: the transcripts are in
 * Gumloop's message format and go through the same `trajectoryFrom` path a
 * real interaction does.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { answerFrom, trajectoryFrom } from "./gumloop.js";
import { scoreRun, type GoldenCase } from "./scorers.js";

const golden: { cases: GoldenCase[] } = JSON.parse(
  readFileSync(join(process.cwd(), "data", "golden.json"), "utf8"),
);

const toolPart = (toolName: string, args: object, result: unknown) => ({
  type: "tool_invocation",
  toolName,
  toolCallState: "completed",
  result: { args, result },
});

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/**
 * `disciplineRate` is the whole experiment: how often the agent asks SQL to do
 * the counting. When it does not, it samples 100 rows and reports how many came
 * back — a fluent answer, a valid query, and a wrong number.
 */
function interaction(testCase: GoldenCase, disciplineRate: number, rand: () => number) {
  const { case_type } = testCase.metadata;
  const expected = testCase.expected.answer;
  const parts: object[] = [];

  if (case_type === "restricted") {
    parts.push(
      toolPart(
        "snowflake__execute_query",
        { query: "SELECT COUNT(*) FROM OBSERVATION_EMBARGO" },
        "SQL compilation error: Object 'OBSERVATION_EMBARGO' does not exist or not authorized.",
      ),
    );
    // Even the disciplined agent occasionally hedges into a guess rather than
    // reporting the boundary cleanly. That is worth being able to see.
    parts.push({
      type: "text",
      text:
        rand() < disciplineRate
          ? "I don't have access to the embargo table, so I cannot answer that."
          : "I couldn't query it directly, but there appear to be 25 under embargo.",
    });
    return [
      { role: "user", content: testCase.input.question, parts: [] },
      { role: "assistant", parts },
    ];
  }

  parts.push(toolPart("snowflake__describe_table", { table: "V_OBSERVATIONS" }, "columns…"));

  if (rand() < disciplineRate) {
    parts.push(
      toolPart(
        "snowflake__execute_query",
        { query: `SELECT COUNT(*) FROM V_OBSERVATIONS WHERE …` },
        `[[${expected}]]`,
      ),
    );
    // The grounded prompt asks the agent to confirm a figure before reporting
    // it, which costs a second round trip. That cost is the trade the concise
    // prompt is buying, and the fixture has to contain it or the comparison
    // looks like a free win.
    if (rand() < 0.6) {
      parts.push(
        toolPart(
          "snowflake__execute_query",
          { query: `SELECT COUNT(*) FROM V_OBSERVATIONS WHERE … -- confirming` },
          `[[${expected}]]`,
        ),
      );
    }
    parts.push({ type: "text", text: `${expected}.` });
  } else {
    // Sampled instead of aggregated. The reported figure is whatever the
    // sample happened to contain, which is right only by luck.
    const sampled = Math.min(100, Math.max(1, Math.round(Number(expected) * (0.4 + rand() * 0.5))));
    parts.push(
      toolPart(
        "snowflake__execute_query",
        { query: "SELECT * FROM V_OBSERVATIONS WHERE … LIMIT 100" },
        "[…rows…]",
      ),
    );
    parts.push({
      type: "text",
      text: case_type === "superlative" ? `${expected}.` : `${sampled}.`,
    });
  }

  return [
    { role: "user", content: testCase.input.question, parts: [] },
    { role: "assistant", parts },
  ];
}

function buildRun(name: string, disciplineRate: number, seed: number, trials: number) {
  const rand = rng(seed);
  const rows = golden.cases.flatMap((testCase) =>
    Array.from({ length: trials }, (_, trial) => {
      const messages = interaction(testCase, disciplineRate, rand);
      const run = {
        answer: answerFrom({ messages }),
        trajectory: trajectoryFrom(messages),
        interactionId: `demo-${name}-${trial}`,
        state: "COMPLETED",
        durationMs: 0,
      };
      return {
        question: testCase.input.question,
        case_type: testCase.metadata.case_type,
        trial,
        answer: run.answer,
        trajectory: run.trajectory,
        interaction_id: run.interactionId,
        state: run.state,
        duration_ms: 0,
        scores: scoreRun(run, testCase),
      };
    }),
  );

  mkdirSync(join(process.cwd(), "runs"), { recursive: true });
  writeFileSync(
    join(process.cwd(), "runs", `${name}.json`),
    JSON.stringify(
      {
        meta: {
          run_name: name,
          synthetic: true,
          warning: "Synthetic fixture, not a measurement. Do not cite as a result.",
          gummie_id: "none",
          case_count: golden.cases.length,
          trial_count: trials,
          interactions: rows.length,
          failed_interactions: 0,
          discipline_rate: disciplineRate,
        },
        rows,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`  wrote runs/${name}.json  (${rows.length} synthetic interactions)`);
}

console.log("\n  SYNTHETIC FIXTURES — not measurements of any agent.\n");
buildRun("demo-baseline", 0.95, 1, 3);
buildRun("demo-candidate", 0.3, 2, 3);
console.log("\n  Try:  npm run gate -- --baseline demo-baseline --candidate demo-candidate\n");

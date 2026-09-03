/**
 * Run the golden set against one Gumloop agent and save the scored result.
 *
 *   GUMLOOP_GUMMIE_ID=<id> RUN_NAME=v1-grounded npm run experiment
 *
 * One run file per agent version, written to runs/. `npm run gate` then diffs
 * two of them. Keeping the runs on disk means the comparison is reproducible
 * after the fact and reviewable in a pull request, rather than a number someone
 * read off a dashboard once.
 *
 * Trials matter here. The regression this suite is built to catch is a shift in
 * *rate* — how often the agent samples rows instead of asking SQL to count —
 * not a hard failure. One trial per question would put that shift inside the
 * noise.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { configFromEnv, runAgent, type AgentRun } from "./gumloop.js";
import { scoreRun, type GoldenCase, type Score } from "./scorers.js";

const golden: { meta: Record<string, unknown>; cases: GoldenCase[] } = JSON.parse(
  readFileSync(join(process.cwd(), "data", "golden.json"), "utf8"),
);

const RUN_NAME = process.env.RUN_NAME ?? "unnamed";
const TRIAL_COUNT = Number(process.env.TRIAL_COUNT ?? 3);
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY ?? 3);
const LIMIT = process.env.EVAL_LIMIT ? Number(process.env.EVAL_LIMIT) : undefined;

/**
 * Take n cases spread evenly across case types, not the first n.
 *
 * The golden file is grouped by type, so slicing from the front returns only
 * aggregate questions and never the restricted one — so a smoke run would
 * never exercise the governance boundary, which is the half of the demo most
 * likely to be misconfigured. A smoke run that skips it is worse than none,
 * because it reports green.
 */
function spread(all: GoldenCase[], n: number): GoldenCase[] {
  const byType = new Map<string, GoldenCase[]>();
  for (const c of all) {
    const bucket = byType.get(c.metadata.case_type) ?? [];
    bucket.push(c);
    byType.set(c.metadata.case_type, bucket);
  }
  const buckets = [...byType.values()];
  const picked: GoldenCase[] = [];
  for (let i = 0; picked.length < n; i++) {
    let added = false;
    for (const bucket of buckets) {
      if (i < bucket.length && picked.length < n) {
        picked.push(bucket[i]!);
        added = true;
      }
    }
    if (!added) break;
  }
  return picked;
}

interface Row {
  question: string;
  case_type: string;
  trial: number;
  answer: string;
  trajectory: AgentRun["trajectory"];
  interaction_id: string;
  state: string;
  duration_ms: number;
  error?: string;
  scores: Score[];
}

/** Run tasks with a fixed worker pool — Gumloop caps concurrent interactions. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

async function main(): Promise<void> {
  const config = configFromEnv();
  const cases = LIMIT ? spread(golden.cases, LIMIT) : golden.cases;

  const work = cases.flatMap((c) =>
    Array.from({ length: TRIAL_COUNT }, (_, trial) => ({ testCase: c, trial })),
  );

  console.log(
    `\n  ${RUN_NAME}: ${cases.length} cases x ${TRIAL_COUNT} trials = ${work.length} interactions` +
      `\n  agent ${config.gummieId}, concurrency ${MAX_CONCURRENCY}\n`,
  );

  let done = 0;
  const rows = await pool(work, MAX_CONCURRENCY, async ({ testCase, trial }) => {
    let run: AgentRun;
    try {
      run = await runAgent(config, testCase.input.question);
    } catch (err) {
      // One failed interaction must not lose the other 130. Record it as a
      // failure and carry on — a run that dies at case 90 has cost real credits
      // and produced nothing.
      run = {
        answer: "",
        trajectory: [],
        interactionId: "",
        state: "ERROR",
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    done++;
    const flag = run.state === "COMPLETED" ? " " : "!";
    process.stdout.write(`  ${flag} ${String(done).padStart(4)}/${work.length}  ${testCase.metadata.case_type.padEnd(18)} ${run.state}\n`);

    return {
      question: testCase.input.question,
      case_type: testCase.metadata.case_type,
      trial,
      answer: run.answer,
      trajectory: run.trajectory,
      interaction_id: run.interactionId,
      state: run.state,
      duration_ms: run.durationMs,
      ...(run.error ? { error: run.error } : {}),
      scores: scoreRun(run, testCase),
    } satisfies Row;
  });

  mkdirSync(join(process.cwd(), "runs"), { recursive: true });
  const outPath = join(process.cwd(), "runs", `${RUN_NAME}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        meta: {
          run_name: RUN_NAME,
          gummie_id: config.gummieId,
          case_count: cases.length,
          trial_count: TRIAL_COUNT,
          interactions: rows.length,
          failed_interactions: rows.filter((r) => r.state !== "COMPLETED").length,
          generated_at: new Date().toISOString(),
        },
        rows,
      },
      null,
      2,
    ) + "\n",
  );

  const failed = rows.filter((r) => r.state !== "COMPLETED").length;
  console.log(`\n  wrote ${outPath}`);
  if (failed) console.log(`  ${failed} interaction(s) did not complete — see "state" in the run file`);
  console.log();
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});

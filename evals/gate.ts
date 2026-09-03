/**
 * Compare two runs and decide whether the change ships. Exits non-zero on a
 * breach so CI can block the PR.
 *
 *   npm run gate -- --baseline v1-grounded --candidate v2-concise
 *
 * Gumloop's own Evaluations grade one conversation at a time, which is right
 * for live traffic. "Is this version worse than production" is a question about
 * two populations, and that is what this adds.
 *
 * Each check is gated separately: one blended score cannot tell "better" apart
 * from "faster but no longer counting", since both move the average up.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Score } from "./scorers.js";

interface Row {
  case_type: string;
  state: string;
  scores: Score[];
}
interface RunFile {
  meta: { run_name: string; interactions: number; failed_interactions: number };
  rows: Row[];
}

const { gates } = JSON.parse(
  readFileSync(join(process.cwd(), "evals", "thresholds.json"), "utf8"),
) as { gates: Record<string, { floor?: number; maxRegression?: number }> };

function parseArgs(argv: string[]): { baseline: string; candidate: string; by?: string } {
  let baseline = "";
  let candidate = "";
  let by: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--baseline") baseline = argv[++i] ?? "";
    else if (argv[i] === "--candidate") candidate = argv[++i] ?? "";
    else if (argv[i] === "--by") by = argv[++i];
  }
  if (!baseline || !candidate) {
    throw new Error("Usage: npm run gate -- --baseline <run> --candidate <run> [--by case_type]");
  }
  return { baseline, candidate, by };
}

function load(name: string): RunFile {
  const path = join(process.cwd(), "runs", `${name}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunFile;
  } catch {
    throw new Error(`Could not read ${path}. Run \`RUN_NAME=${name} npm run experiment\` first.`);
  }
}

/**
 * Mean across rows, skipping nulls. A null means "does not apply here", not
 * zero — averaging skips in as zeros would make the number describe the fixture
 * mix rather than the agent.
 */
function mean(rows: Row[], scorer: string): { value: number | null; n: number } {
  const values = rows
    .flatMap((r) => r.scores.filter((s) => s.name === scorer))
    .map((s) => s.score)
    .filter((v): v is number => v !== null);
  if (values.length === 0) return { value: null, n: 0 };
  return { value: values.reduce((a, b) => a + b, 0) / values.length, n: values.length };
}

const pct = (n: number | null) => (n === null ? "  --  " : `${(n * 100).toFixed(1)}%`);
const delta = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}`;

function compare(baseRows: Row[], candRows: Row[], label: string): string[] {
  const failures: string[] = [];
  console.log(`\n  ${label}`);
  console.log(
    `    ${"".padEnd(6)}${"".padEnd(22)} ${"baseline".padStart(8)} ${"candidate".padStart(9)} ${"change".padStart(7)}`,
  );

  for (const [name, gate] of Object.entries(gates)) {
    const base = mean(baseRows, name);
    const cand = mean(candRows, name);
    if (cand.value === null) {
      console.log(`    ${"".padEnd(6)}${name.padEnd(22)} ${"".padStart(8)} ${"--".padStart(9)}   (not exercised)`);
      continue;
    }

    const scorerFailures: string[] = [];
    if (gate.floor !== undefined && cand.value < gate.floor) {
      scorerFailures.push(`${name}: ${pct(cand.value)} is below its floor of ${pct(gate.floor)}`);
    }
    let change: number | null = null;
    if (base.value !== null) {
      change = cand.value - base.value;
      if (gate.maxRegression !== undefined && -change > gate.maxRegression) {
        scorerFailures.push(
          `${name}: ${delta(change)} exceeds its ${pct(gate.maxRegression)} drop limit`,
        );
      }
    }
    failures.push(...scorerFailures);

    console.log(
      `    ${scorerFailures.length ? "FAIL" : "ok  "}  ${name.padEnd(22)}` +
        ` ${pct(base.value).padStart(8)} ${pct(cand.value).padStart(9)}` +
        ` ${(change === null ? "" : delta(change)).padStart(7)}   n=${cand.n}`,
    );
  }
  return failures;
}

function main(): void {
  const { baseline, candidate, by } = parseArgs(process.argv.slice(2));
  const base = load(baseline);
  const cand = load(candidate);

  console.log(`\n  baseline  ${base.meta.run_name}   ${base.meta.interactions} interactions`);
  console.log(`  candidate ${cand.meta.run_name}   ${cand.meta.interactions} interactions`);

  // A gate with nothing to check must fail, not pass. An empty run means every
  // limit below is vacuously satisfied, and CI goes green on an eval that never
  // ran.
  if (cand.rows.length === 0) {
    console.log("\n  ✗ candidate run has no rows — nothing to check\n");
    process.exit(1);
  }

  const failures = compare(base.rows, cand.rows, "overall");

  // The same comparison, split by question shape. Not gated — it is what
  // someone reads before deciding whether the overall average was hiding
  // something. A drop concentrated in one question type is a different problem
  // from the same drop spread evenly, and only this view tells them apart.
  if (by === "case_type") {
    const types = [...new Set(cand.rows.map((r) => r.case_type))].sort();
    for (const type of types) {
      compare(
        base.rows.filter((r) => r.case_type === type),
        cand.rows.filter((r) => r.case_type === type),
        `by case_type: ${type}`,
      );
    }
  }

  const incomplete = cand.rows.filter((r) => r.state !== "COMPLETED").length;
  if (incomplete) {
    console.log(`\n  note: ${incomplete} candidate interaction(s) did not complete.`);
  }

  if (failures.length === 0) {
    console.log(`\n  All gates passed.\n`);
    return;
  }
  console.log(`\n  ${candidate} failed:`);
  for (const f of new Set(failures)) console.log(`    ✗ ${f}`);
  console.log("\n  Limits are in evals/thresholds.json. Changing one is a reviewable diff.\n");
  process.exit(1);
}

try {
  main();
} catch (err) {
  // A usage mistake or a missing run file is an ordinary outcome here, not a
  // crash. Printing a stack trace for it buries the one line that says what to
  // do next.
  console.error(`\n  ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
}

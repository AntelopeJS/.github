import { parse } from "yaml";
import { isList, isObject, isText, type Json } from "../ci-metrics/json.ts";

/** A job of a workflow, as the verdict rules read it. */
export interface Job {
  readonly id: string;
  /** The name GitHub gives the job's check: its `name`, else its id. */
  readonly check: string;
  readonly uses: string | undefined;
  readonly needs: readonly string[];
  readonly condition: string | undefined;
}

/** A status check that a ruleset of a repository's default branch requires. */
export interface RequiredCheck {
  readonly context: string;
  readonly ruleset: string;
}

/** A repository with a `.github/workflows/ci.yml`. */
export interface Repository {
  readonly name: string;
  readonly workflow: string;
  readonly required: readonly RequiredCheck[];
}

/** The check that gates every job of a workflow, and what keeps it from doing so. */
export interface Verdict {
  readonly check: string;
  readonly problems: readonly string[];
}

const SHARED_CI = /^AntelopeJS\/\.github\/\.github\/workflows\/ci-node\.yml@/;

/** The value of a YAML text. */
export function parseYaml(text: string): Json {
  // SAFETY: yaml's default core schema yields only strings, numbers, booleans, null, arrays and string-keyed objects of them.
  return parse(text) as Json;
}

function needsOf(value: Json | undefined): string[] {
  if (isText(value)) return [value];
  return isList(value) ? value.filter(isText) : [];
}

const textOf = (value: Json | undefined): string | undefined => (isText(value) ? value : undefined);

/** The jobs of a workflow file. */
export function jobsOf(workflow: string): Job[] {
  const parsed = parseYaml(workflow);
  const jobs = isObject(parsed) && isObject(parsed.jobs) ? parsed.jobs : {};
  return Object.entries(jobs).map(([id, raw]) => {
    const job = isObject(raw) ? raw : {};
    return { id, check: textOf(job.name) ?? id, uses: textOf(job.uses), needs: needsOf(job.needs), condition: textOf(job.if) };
  });
}

/** `if: ${{ !cancelled() }}`, with or without the `${{ }}`, and nothing else. */
const NOT_CANCELLED = /^(\$\{\{\s*)?!\s*cancelled\(\)(\s*\}\})?$/;

/** The job of ci-node.yml that reports the whole run: the check `ci / checks` of a caller named `ci`. */
export const SHARED_CI_VERDICT_JOB = "checks";

/**
 * The verdict of a workflow: its `verdict` job, or the `checks` of ci-node.yml when the workflow is one
 * ci-node.yml call (ci-node.yml itself has no `verdict` job: its `checks` is the one reporting job, so a run
 * pays one queue hop for it, not two). Any other job needs a `verdict` job of the workflow's own that needs it and
 * runs with `if: ${{ !cancelled() }}`: a failed need skips a job without a status function, and a skipped required
 * check passes, while `always()` also runs it in a cancelled run, which then waits for a runner of the pool only to
 * fail. Under `!cancelled()`, a cancelled run's verdict ends cancelled without a runner, and that blocks a merge.
 * `id` names the reporting job to judge: `verdict` in a caller, `checks` in ci-node.yml itself.
 */
export function verdictOf(jobs: readonly Job[], id = "verdict"): Verdict {
  const verdict = jobs.find((job) => job.id === id);
  const [only] = jobs;
  if (verdict === undefined && jobs.length === 1 && SHARED_CI.test(only.uses ?? "")) {
    return { check: `${only.check} / ${SHARED_CI_VERDICT_JOB}`, problems: [] };
  }
  if (verdict === undefined) {
    const ids = jobs.map((job) => job.id).join(", ");
    return { check: id, problems: [`ci.yml is not a single ci-node.yml call (jobs ${ids}) and has no ${id} job`] };
  }
  const missing = jobs.filter((job) => job !== verdict && !verdict.needs.includes(job.id)).map((job) => job.id);
  const problems = missing.length === 0 ? [] : [`its ${id} job does not need ${missing.join(", ")}`];
  const condition = (verdict.condition ?? "").trim();
  if (/\balways\(\)/.test(condition)) {
    problems.push(`its ${id} job runs with if: always(), so a cancelled run still waits for a runner to fail it; use if: \${{ !cancelled() }}`);
  } else if (!NOT_CANCELLED.test(condition)) {
    problems.push(`its ${id} job does not run with if: \${{ !cancelled() }}, so a failed job skips it and the skipped check passes`);
  }
  return { check: verdict.check, problems };
}

/** What keeps the merge queue of a repository from waiting on its verdict alone. */
export function problemsOf(repository: Repository): string[] {
  const { check, problems } = verdictOf(jobsOf(repository.workflow));
  const others = repository.required.filter(({ context }) => context !== check).map(({ context, ruleset }) => `${ruleset} requires ${context}, not ${check}`);
  const unrequired = repository.required.some(({ context }) => context === check) ? [] : [`no ruleset requires ${check}`];
  return [...problems, ...others, ...unrequired];
}

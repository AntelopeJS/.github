import assert from "node:assert/strict";
import { test } from "node:test";
import { collectNightlies, parseAnnotations } from "./nightly-github.ts";
import {
  formatNightlyMarkdown,
  nightlyReport,
  parseNightlyDataset,
  rangeKey,
  type Nightly,
  type NightlyDataset,
  type NightlyJob,
  type RepoNightlies,
} from "./nightly.ts";

const day = (n: number): string => new Date(Date.UTC(2026, 10, n, 2, 25)).toISOString();

let nextId = 1;
function job(name: string, conclusion: string, fields: Partial<NightlyJob> = {}): NightlyJob {
  return { id: nextId++, name, attempt: 1, conclusion, started: true, failedStep: conclusion === "failure" ? "Run tests" : null, ...fields };
}

function nightly(n: number, sha: string, jobs?: NightlyJob[]): Nightly {
  const conclusion = jobs === undefined ? "success" : jobs.some((one) => one.conclusion === "failure") ? "failure" : "success";
  return { id: 1000 + n, sha, startedAt: day(n), conclusion, url: `https://github.com/AntelopeJS/dms/actions/runs/${1000 + n}`, ...(jobs === undefined ? {} : { jobs }) };
}

function repo(nightlies: Nightly[], fields: Partial<RepoNightlies> = {}): RepoNightlies {
  return { repo: "dms", nightlies, queue: {}, commits: {}, annotations: {}, ...fields };
}

const dataset = (...repos: RepoNightlies[]): NightlyDataset => ({ org: "AntelopeJS", to: day(20), days: 30, repos });
const failing = (): NightlyJob[] => [job("ci / Test 24", "failure"), job("ci / checks", "failure")];

test("a reproduced failure whose commits all passed the merge queue is missed, once per streak", () => {
  const result = nightlyReport(dataset(repo(
    [nightly(16, "a"), nightly(17, "c", failing()), nightly(18, "d", failing())],
    { queue: { b: "success", c: "success", d: "success" }, commits: { [rangeKey("a", "c")]: ["b", "c"], [rangeKey("a", "d")]: ["b", "c", "d"] } },
  )));
  assert.deepEqual(result.failures.map((failure) => [failure.job, failure.reproducedBy, failure.verdict]), [
    ["ci / Test 24", "next-nightly", "missed"],
    ["ci / Test 24", null, "pending"],
  ]);
  assert.equal(result.counts.missed, 1);
  assert.equal(result.counts.pending, 0);
  assert.equal(result.repos[0].counts.missed, 1);
});

test("a commit with no passing queue run makes the failure unqueued", () => {
  const rerun = job("ci / Test 24", "failure", { attempt: 2 });
  const result = nightlyReport(dataset(repo(
    [nightly(16, "a"), nightly(17, "c", [...failing(), rerun])],
    { queue: { b: "success" }, commits: { [rangeKey("a", "c")]: ["b", "c"] } },
  )));
  const [failure] = result.failures;
  assert.equal(failure.reproducedBy, "rerun");
  assert.equal(failure.verdict, "unqueued");
  assert.deepEqual(failure.commits, [{ sha: "b", queue: "passed" }, { sha: "c", queue: "none" }]);
});

test("a failure neither a re-run nor the next nightly repeats is a flake, and pending before the next nightly", () => {
  const rerun = job("ci / Test 24", "success", { attempt: 2 });
  const flaky = nightlyReport(dataset(repo([nightly(16, "a"), nightly(17, "a", [...failing(), rerun]), nightly(18, "a")])));
  assert.deepEqual(flaky.failures.map((failure) => failure.verdict), ["flake"]);
  const pending = nightlyReport(dataset(repo([nightly(16, "a"), nightly(17, "a", [...failing(), rerun])])));
  assert.deepEqual(pending.failures.map((failure) => failure.verdict), ["pending"]);
});

test("a reproduced failure on the baseline's commit has no new commit, and one with no passing nightly before it no baseline", () => {
  const same = nightlyReport(dataset(repo([nightly(16, "a"), nightly(17, "a", failing()), nightly(18, "a", failing())])));
  assert.equal(same.failures[0].verdict, "no-new-commit");
  const none = nightlyReport(dataset(repo([nightly(17, "a", failing()), nightly(18, "b", failing())])));
  assert.equal(none.failures[0].verdict, "no-baseline");
  assert.equal(none.counts["no-baseline"], 1);
});

test("a job no runner took, a failed setup step and a network or billing annotation are infra failures", () => {
  const unstarted = job("ci / Node 24", "failure", { started: false, failedStep: null });
  const setup = job("ci / Test 22", "failure", { failedStep: "Set up job" });
  const network = job("ci / Stress", "failure");
  const real = job("ci / Test 24", "failure");
  const result = nightlyReport(dataset(repo(
    [nightly(16, "a"), nightly(17, "b", [unstarted, setup, network, real]), nightly(18, "b", [real])],
    { annotations: { [String(network.id)]: ["npm ERR! network request to https://registry.npmjs.org failed, reason: ETIMEDOUT"] } },
  )));
  assert.deepEqual(result.failures.filter((failure) => failure.nightly.id === 1017).map((failure) => [failure.job, failure.kind]), [
    ["ci / Node 24", "infra"],
    ["ci / Test 22", "infra"],
    ["ci / Stress", "infra"],
    ["ci / Test 24", "test"],
  ]);
  assert.equal(result.counts.infra, 3);
});

test("the checks gate counts only when no other job failed", () => {
  const result = nightlyReport(dataset(repo([nightly(16, "a"), nightly(17, "b", [job("ci / checks", "failure")])])));
  assert.deepEqual(result.failures.map((failure) => failure.job), ["ci / checks"]);
});

test("nightlies before the window are baselines only", () => {
  const result = nightlyReport({ ...dataset(repo([nightly(1, "a"), nightly(2, "b", failing()), nightly(17, "c", failing())])), days: 5 });
  assert.deepEqual(result.failures.map((failure) => failure.nightly.id), [1017]);
  assert.equal(result.repos[0].nightlies, 1);
  assert.deepEqual(result.failures[0].baseline, { id: 1001, sha: "a" });
});

test("the Markdown report counts per repository and organization-wide, and details the latest nightly", () => {
  const markdown = formatNightlyMarkdown(nightlyReport(dataset(
    repo([nightly(16, "a"), nightly(17, "b", failing()), nightly(18, "b", failing())], { annotations: {} }),
    { ...repo([nightly(18, "e")]), repo: "redis" },
  )));
  assert.match(markdown, /^# Nightly failures the merge queue missed, 2026-10-21\.\.2026-11-20 \(30 d\)$/m);
  assert.match(markdown, /^Missed by the queue: \*\*0\*\* in 2 repositories/m);
  assert.match(markdown, /^\| dms \| 3 \| 2 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \|$/m);
  assert.match(markdown, /^\| \*\*org\*\* \| 4 \| 2 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \| 0 \|$/m);
  assert.match(markdown, /^### dms: \[2026-11-18 02:25\]/m);
  assert.match(markdown, /^- `ci \/ Test 24`, test, not reproduced: \*\*pending\*\*\. no commit since a/m);
  assert.doesNotMatch(markdown, /### redis/);
});

test("annotations keep the failures and drop the exit code line", () => {
  assert.deepEqual(parseAnnotations([
    { annotation_level: "failure", message: "Process completed with exit code 1." },
    { annotation_level: "warning", message: "pnpm run test failed in the merge queue." },
    { annotation_level: "failure", title: "test/route.test.ts > answers", message: "AssertionError: expected 404\n  at line 3" },
  ]), ["test/route.test.ts > answers: AssertionError: expected 404"]);
});

test("the collector reads only repositories with a merge queue and the facts their failures need", async () => {
  process.env.GH_TOKEN = "test-token";
  const run = (id: number, sha: string, conclusion: string, startedAt: string, event = "schedule", name = "ci") => ({
    id, name, event, status: "completed", conclusion, head_sha: sha, run_started_at: startedAt, updated_at: startedAt, html_url: `u${id}`,
  });
  const routes: Record<string, unknown> = {
    "/orgs/AntelopeJS/repos?type=all&per_page=100&page=1": [{ name: "dms", default_branch: "main" }, { name: "cloud", default_branch: "develop" }],
    "/orgs/AntelopeJS/repos?type=all&per_page=100&page=2": [],
    "/repos/AntelopeJS/dms/rules/branches/main": [{ type: "pull_request" }, { type: "merge_queue" }],
    "/repos/AntelopeJS/cloud/rules/branches/develop": [{ type: "pull_request" }],
    schedule: { workflow_runs: [run(3, "c", "failure", day(18)), run(1, "a", "success", day(16)), run(2, "b", "failure", day(17)), run(9, "b", "failure", day(17), "schedule", "stale")] },
    merge_group: { workflow_runs: [run(5, "b", "failure", day(17), "merge_group"), run(6, "b", "success", day(17), "merge_group"), run(7, "c", "success", day(18), "merge_group")] },
    "/repos/AntelopeJS/dms/actions/runs/2/jobs?filter=all&per_page=100&page=1": { jobs: [{ id: 20, name: "ci / Test 24", run_attempt: 1, conclusion: "failure", steps: [{ name: "Run tests", conclusion: "failure" }] }] },
    "/repos/AntelopeJS/dms/actions/runs/3/jobs?filter=all&per_page=100&page=1": { jobs: [{ id: 30, name: "ci / Test 24", run_attempt: 1, conclusion: "failure", steps: [{ name: "Run tests", conclusion: "failure" }] }] },
    "/repos/AntelopeJS/dms/compare/a...b?per_page=100&page=1": { commits: [{ sha: "b" }] },
    "/repos/AntelopeJS/dms/compare/a...c?per_page=100&page=1": { commits: [{ sha: "b" }, { sha: "c" }] },
    "/repos/AntelopeJS/dms/check-runs/20/annotations?per_page=50": [{ annotation_level: "failure", title: "route", message: "expected 200" }],
    "/repos/AntelopeJS/dms/check-runs/30/annotations?per_page=50": [],
  };
  const seen: string[] = [];
  const fetcher = async (input: string | URL | Request): Promise<Response> => {
    const path = String(input).replace("https://api.github.com", "");
    seen.push(path);
    const event = /[?&]event=(\w+)/.exec(path)?.[1];
    const body = event === undefined ? routes[path] : path.endsWith("&page=1") ? routes[event] : { workflow_runs: [] };
    return body === undefined ? new Response("{}", { status: 404 }) : Response.json(body);
  };
  const collected = await collectNightlies({ org: "AntelopeJS", days: 30, to: new Date(day(20)), concurrency: 2 }, fetcher);
  assert.ok(!seen.some((path) => path.includes("/cloud/actions")), "a repository without a merge queue is not read");
  const [dms] = collected.repos;
  assert.deepEqual(dms.nightlies.map((one) => one.id), [1, 2, 3]);
  assert.deepEqual(dms.queue, { b: "success", c: "success" });
  assert.deepEqual(Object.keys(dms.commits).sort(), ["a...b", "a...c"]);
  assert.deepEqual(dms.annotations, { 20: ["route: expected 200"], 30: [] });
  assert.deepEqual(parseNightlyDataset(JSON.parse(JSON.stringify(collected))), collected);
  const result = nightlyReport(collected);
  assert.deepEqual(result.failures.map((failure) => [failure.nightly.id, failure.verdict, failure.tests]), [
    [2, "missed", ["route: expected 200"]],
    [3, "pending", []],
  ]);
  assert.equal(result.counts.missed, 1);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJobs, parseRun, tierJobId } from "./github.ts";
import {
  estimateMinutes,
  formatTable,
  jobMinutes,
  parseTier,
  pickSample,
  quantile,
  queueSeconds,
  report,
  wallMinutes,
  type Job,
  type Run,
  type Tier,
} from "./metrics.ts";

const at = (minute: number): string => new Date(Date.UTC(2026, 10, 10, 12, 0) + minute * 60_000).toISOString();

function job(name: string, start: number, end: number, conclusion = "success", queued = start): Job {
  return { name, conclusion, createdAt: at(queued), startedAt: at(start), completedAt: at(end) };
}

let nextId = 1;
function run(fields: Partial<Run> & { minutes?: number; start?: number } = {}): Run {
  const { minutes = 10, start = 0, ...rest } = fields;
  return {
    repo: "dms",
    id: nextId++,
    workflow: "ci",
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    startedAt: at(start),
    updatedAt: at(start + minutes),
    ...rest,
  };
}

const sampledRun = (tier: Tier | undefined, minutes: number, jobs: Job[], fields: Partial<Run> = {}): Run =>
  run({ minutes, jobs, ...(tier === undefined ? {} : { tier }), ...fields });

test("quantile interpolates between the two closest ranks", () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([4], 0.9), 4);
  assert.equal(quantile([3, 1, 2, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1);
});

test("job-minutes sum the jobs that ran and leave out skipped and unfinished ones", () => {
  const jobs = [
    job("lint", 0, 3),
    job("test", 0, 6, "failure"),
    job("windows", 0, 30, "skipped"),
    { name: "pending", conclusion: null, createdAt: at(0), startedAt: at(0), completedAt: null },
  ];
  assert.equal(jobMinutes(jobs), 9);
});

test("wall-clock runs from run_started_at to updated_at", () => {
  assert.equal(wallMinutes(run({ start: 5, minutes: 16.5 })), 16.5);
});

test("queue time runs from created_at to started_at and skips jobs that never ran", () => {
  assert.equal(queueSeconds(job("lint", 1, 3, "success", 0)), 60);
  assert.equal(queueSeconds(job("lint", 1, 3, "skipped", 0)), null);
});

test("the tier is read from the Tier job's TIER input or the exported ANTELOPEJS_CI_TIER", () => {
  const tierLog = [
    "2026-11-19T01:50:02.0347962Z \u001b[36;1mecho \"tier=${tier}\" >> \"$GITHUB_OUTPUT\"\u001b[0m",
    "2026-11-19T01:50:02.0606800Z \u001b[36;1mtier=\"$TIER\"\u001b[0m",
    "2026-11-19T01:50:02.0670192Z   TIER: fast",
    "2026-11-19T01:50:02.0670200Z   EVENT: pull_request",
  ].join("\n");
  assert.equal(parseTier(tierLog), "fast");
  assert.equal(parseTier("2026-11-19T01:50:02.0670192Z   ANTELOPEJS_CI_TIER: queue\n"), "queue");
  assert.equal(parseTier("2026-11-19T01:50:02.0670192Z   TIER: turbo\n"), undefined);
  assert.equal(parseTier("no tier here"), undefined);
});

test("a sample spreads over the whole window and keeps every run of a small group", () => {
  const runs = Array.from({ length: 10 }, (_, index) => run({ start: index }));
  assert.deepEqual(pickSample(runs, 3).map((picked) => picked.startedAt), [at(0), at(5), at(9)]);
  assert.equal(pickSample(runs.slice(0, 2), 3).length, 2);
  assert.equal(pickSample(runs, 0).length, 0);
});

test("job-minutes per week scale each workflow's sampled mean by its completed runs", () => {
  const dataset = {
    to: at(0),
    days: 14,
    runs: [
      run({ jobs: [job("a", 0, 10)] }),
      run({ jobs: [job("a", 0, 30)] }),
      run(),
      run(),
      run({ status: "in_progress" }),
      run({ repo: "redis" }),
    ],
  };
  const { groups, unsampled } = estimateMinutes(dataset);
  assert.deepEqual(groups, [{ repo: "dms", workflow: "ci", runs: 4, jobMinutesPerWeek: 40 }]);
  assert.equal(unsampled, 1);
});

test("the report counts shares, splits wall-clock by event and tier, and details the focus repository", () => {
  const dmsRuns = [
    sampledRun("full", 16, [job("ci / Tier", 0, 1), job("backend (ubuntu-latest, builder:1)", 1, 16), job("backend (ubuntu-latest, builder:2)", 1, 14)]),
    sampledRun("fast", 6, [job("ci / Tier", 0, 1), job("lint", 1, 5, "success", 0)]),
    sampledRun("queue", 20, [job("backend (ubuntu-latest, builder:1)", 0, 18)], { event: "merge_group" }),
    run({ conclusion: "cancelled", minutes: 2 }),
    run({ conclusion: "failure", event: "push", minutes: 4 }),
  ];
  const smallRuns = [
    sampledRun("full", 1, [job("test", 0, 1)], { repo: "redis" }),
    sampledRun("draft", 0.2, [job("lint", 0, 0.2)], { repo: "redis" }),
    sampledRun("full", 3, [job("test", 0, 1)], { repo: "redis", conclusion: "cancelled" }),
  ];
  const other = run({ workflow: "Release", path: ".github/workflows/release.yml", jobs: [job("publish", 0, 7)] });
  const dataset = { to: at(60 * 24), days: 7, runs: [...dmsRuns, ...smallRuns, other] };
  const result = report({ ci: dataset, org: dataset });

  assert.equal(result.ci.runs, 8);
  assert.equal(result.ci.cancelledShare, 0.25);
  assert.equal(result.ci.failedShare, 0.13);
  assert.deepEqual(result.ci.wallMinutesByEvent.merge_group, { n: 1, median: 20, p90: 20 });
  assert.equal(result.ci.byTier.fast?.jobMinutes.median, 5);
  assert.equal(result.ci.queueSeconds.median, 0);
  assert.equal(result.ci.queueSeconds.n, 9);

  assert.equal(result.focus.full.wallMinutes.median, 16);
  assert.equal(result.focus.full.jobMinutes.median, 29);
  assert.equal(result.focus.queue.wallMinutes.median, 20);
  assert.deepEqual(result.focus.pullRequestWallMinutes, { n: 3, median: 6, p90: 14 });
  assert.deepEqual(Object.keys(result.focus.shardMinutes), ["backend (ubuntu-latest, builder:1)", "backend (ubuntu-latest, builder:2)"]);
  assert.equal(result.focus.shardMinutes["backend (ubuntu-latest, builder:1)"].median, 16.5);

  assert.deepEqual(result.smallModules.repos, ["redis"]);
  assert.deepEqual(result.smallModules.wallSeconds, { n: 1, median: 60, p90: 60 });

  assert.equal(result.org.jobMinutesPerWeek, 96);
  assert.deepEqual(result.org.byWorkflow.map((row) => row.workflow), ["ci", "Release"]);
  assert.equal(result.focus.shareOfOrgJobMinutes, 0.98);
  assert.match(formatTable(result), /^dms +5 +20% +20%/m);
});

test("the API parsers keep runs and jobs and find the Tier job that ran", () => {
  assert.deepEqual(
    parseRun({
      id: 7,
      name: "ci",
      path: ".github/workflows/ci.yml",
      event: "merge_group",
      status: "completed",
      conclusion: "success",
      run_started_at: at(0),
      updated_at: at(3),
      repository: { name: "dms" },
    }),
    { repo: "dms", id: 7, workflow: "ci", path: ".github/workflows/ci.yml", event: "merge_group", status: "completed", conclusion: "success", startedAt: at(0), updatedAt: at(3) },
  );
  assert.equal(parseRun({ id: 7, name: "ci" }), null);
  assert.equal(parseRun({ id: 8, event: "push", status: "completed", run_started_at: at(0), updated_at: at(1) }, { repo: "dms", workflow: "ci" })?.path, "ci");

  const page = {
    jobs: [
      { id: 1, name: "ci / Tier", conclusion: "skipped", created_at: null, started_at: null, completed_at: null },
      { id: 2, name: "Tier", conclusion: "success", created_at: at(0), started_at: at(0), completed_at: at(1) },
      { name: 3 },
    ],
  };
  assert.equal(parseJobs(page).length, 2);
  assert.equal(tierJobId(page), 2);
  assert.equal(tierJobId({ jobs: [{ id: 3, name: "ci / Tiers", conclusion: "success" }] }), undefined);
});

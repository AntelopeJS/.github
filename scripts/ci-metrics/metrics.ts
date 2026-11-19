/** The tiers the shared `Tier` job prints, plus `unknown` for a sampled run whose tier no log names. */
export const tiers = ["none", "draft", "fast", "full", "queue", "nightly", "unknown"] as const;
export type Tier = (typeof tiers)[number];

/** A job of a run, as `jobs?filter=latest` lists it. */
export interface Job {
  name: string;
  conclusion: string | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

/** A workflow run. `jobs` and `tier` are set on the runs the collector sampled. */
export interface Run {
  repo: string;
  id: number;
  workflow: string;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  startedAt: string;
  updatedAt: string;
  jobs?: Job[];
  tier?: Tier;
}

/** A run the collector sampled. */
export type SampledRun = Run & { jobs: Job[] };

/** The runs started in the `days` before `to`. */
export interface Dataset {
  to: string;
  days: number;
  runs: Run[];
}

/**
 * The two run sets a report reads. `ci` holds the CI runs behind the counts, wall-clocks, tiers and queue
 * times; `org` holds every workflow run behind the job-minutes per week. A live collection passes one
 * dataset as both.
 */
export interface Inputs {
  ci: Dataset;
  org: Dataset;
}

/** Count, median and 90th percentile of a sample; `null` when the sample is empty. */
export interface Stat {
  n: number;
  median: number | null;
  p90: number | null;
}

export interface TierStat {
  wallMinutes: Stat;
  jobMinutes: Stat;
}

export interface RepoReport {
  repo: string;
  runs: number;
  completed: number;
  cancelledShare: number | null;
  failedShare: number | null;
  wallMinutesByEvent: Record<string, Stat>;
  sampled: number;
  jobMinutesPerRun: Stat;
  byTier: Partial<Record<Tier, TierStat>>;
  queueSeconds: Stat;
  ciJobMinutesPerWeek: number | null;
}

export interface WorkflowMinutes {
  workflow: string;
  repos: number;
  runsPerWeek: number;
  jobMinutesPerWeek: number;
}

export interface Report {
  window: { ci: { from: string; to: string; days: number }; org: { from: string; to: string; days: number } };
  ci: {
    repos: number;
    runs: number;
    completed: number;
    cancelledShare: number | null;
    failedShare: number | null;
    wallMinutesByEvent: Record<string, Stat>;
    byTier: Partial<Record<Tier, TierStat>>;
    queueSeconds: Stat & { overMinuteShare: number | null };
  };
  org: {
    completedRuns: number;
    unsampledRuns: number;
    jobMinutesPerWeek: number;
    ciJobMinutesPerWeek: number;
    byWorkflow: WorkflowMinutes[];
    byRepo: { repo: string; jobMinutesPerWeek: number; share: number }[];
  };
  focus: {
    repo: string;
    shareOfOrgJobMinutes: number | null;
    pullRequestWallMinutes: Stat;
    full: TierStat;
    fast: TierStat;
    queue: TierStat;
    shardMinutes: Record<string, Stat>;
  };
  /** The repositories whose median job-minutes per run is under the ceiling, and the wall-clock of their sampled runs that went on to their checks. */
  smallModules: { repos: string[]; wallSeconds: Stat };
  repos: RepoReport[];
}

/** What a report singles out: the repository it details, and the ceiling under which a repository is small. */
export interface ReportOptions {
  focus: string;
  smallJobMinutes: number;
}

export const defaultReportOptions: ReportOptions = { focus: "dms", smallJobMinutes: 5 };

const minuteMs = 60_000;
const dayMs = 86_400_000;
const watchedEvents = ["pull_request", "merge_group", "push", "schedule"];
const shardPattern = /\bbuilder:\d+\b/;

const time = (iso: string): number => Date.parse(iso);

/** The `p` quantile of `values`, interpolated linearly between the two closest ranks. */
export function quantile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.min(low + 1, sorted.length - 1);
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

const round = (value: number | null): number | null => (value === null ? null : Math.round(value * 100) / 100);

export function stat(values: readonly number[]): Stat {
  return { n: values.length, median: round(quantile(values, 0.5)), p90: round(quantile(values, 0.9)) };
}

const share = (part: number, whole: number): number | null => (whole === 0 ? null : round(part / whole));

/** Seconds a job ran; a skipped job, or one that never started or ended, ran none. */
export function jobSeconds(job: Job): number {
  if (job.conclusion === "skipped" || job.startedAt === null || job.completedAt === null) return 0;
  return Math.max(0, (time(job.completedAt) - time(job.startedAt)) / 1000);
}

/** The job-minutes of a run: the durations of its jobs that ran, summed. */
export function jobMinutes(jobs: readonly Job[]): number {
  return jobs.reduce((sum, job) => sum + jobSeconds(job), 0) / 60;
}

/** The wall-clock of a run, from `run_started_at` to `updated_at`. */
export function wallMinutes(run: Run): number {
  return (time(run.updatedAt) - time(run.startedAt)) / minuteMs;
}

/** Seconds a job that ran waited for a runner, from `created_at` to `started_at`. */
export function queueSeconds(job: Job): number | null {
  if (job.conclusion === "skipped" || job.createdAt === null || job.startedAt === null) return null;
  return (time(job.startedAt) - time(job.createdAt)) / 1000;
}

export const isTier = (value: string): value is Tier => (tiers as readonly string[]).includes(value);

/**
 * The tier a job log names: the `TIER` input of the step that picks the jobs from the tier, or the
 * `ANTELOPEJS_CI_TIER` the shared workflow exports to its jobs.
 */
export function parseTier(log: string): Tier | undefined {
  const match = /^\S*\s+(?:ANTELOPEJS_CI_)?TIER: (\w+)\s*$/m.exec(log);
  return match !== null && isTier(match[1]) ? match[1] : undefined;
}

/** Whether a job is the shared workflow's `Tier` job, called directly or through a caller's `ci` job. */
export const isTierJob = (job: Job): boolean => /(^|\/ )Tier$/.test(job.name);

/** Whether a run is a repository's CI run, which the organization names `ci` or `CI`. */
export const isCi = (run: Run): boolean => run.workflow.toLowerCase() === "ci";

/** Up to `size` of `runs`, spread evenly over their start times, so a sample spans the whole window. */
export function pickSample(runs: readonly Run[], size: number): Run[] {
  const sorted = [...runs].sort((a, b) => time(a.startedAt) - time(b.startedAt) || a.id - b.id);
  if (sorted.length <= size) return sorted;
  if (size <= 0) return [];
  if (size === 1) return [sorted[Math.floor((sorted.length - 1) / 2)]];
  return Array.from({ length: size }, (_, index) => sorted[Math.round((index * (sorted.length - 1)) / (size - 1))]);
}

/** The first and last instants of a dataset's window. */
export function windowOf(dataset: Dataset): { from: string; to: string; days: number } {
  return { from: new Date(time(dataset.to) - dataset.days * dayMs).toISOString(), to: dataset.to, days: dataset.days };
}

const sampled = (runs: readonly Run[]): SampledRun[] =>
  runs.filter((run): run is SampledRun => run.jobs !== undefined);

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const group = groups.get(name);
    if (group === undefined) groups.set(name, [item]);
    else group.push(item);
  }
  return groups;
}

function conclusions(runs: readonly Run[]): Pick<RepoReport, "runs" | "completed" | "cancelledShare" | "failedShare"> {
  const completed = runs.filter((run) => run.status === "completed");
  return {
    runs: runs.length,
    completed: completed.length,
    cancelledShare: share(completed.filter((run) => run.conclusion === "cancelled").length, completed.length),
    failedShare: share(completed.filter((run) => run.conclusion === "failure").length, completed.length),
  };
}

function wallByEvent(runs: readonly Run[]): Record<string, Stat> {
  const completed = runs.filter((run) => run.status === "completed");
  return Object.fromEntries(
    watchedEvents.map((event) => [event, stat(completed.filter((run) => run.event === event).map(wallMinutes))]),
  );
}

function tierStat(runs: readonly SampledRun[]): TierStat {
  return { wallMinutes: stat(runs.map(wallMinutes)), jobMinutes: stat(runs.map((run) => jobMinutes(run.jobs))) };
}

function byTier(runs: readonly SampledRun[]): Partial<Record<Tier, TierStat>> {
  const groups = groupBy(runs, (run) => run.tier ?? "unknown");
  return Object.fromEntries(tiers.flatMap((tier) => {
    const group = groups.get(tier);
    return group === undefined ? [] : [[tier, tierStat(group)]];
  }));
}

function queueTimes(runs: readonly SampledRun[]): number[] {
  return runs.flatMap((run) => run.jobs.flatMap((job) => {
    const seconds = queueSeconds(job);
    return seconds === null ? [] : [seconds];
  }));
}

/**
 * The job-minutes per week of each workflow of each repository: the mean job-minutes of its sampled
 * completed runs times its completed runs, over the weeks of the window. A workflow with no sampled run
 * counts in `unsampled`.
 */
export function estimateMinutes(dataset: Dataset): {
  groups: { repo: string; workflow: string; runs: number; jobMinutesPerWeek: number }[];
  unsampled: number;
} {
  const weeks = dataset.days / 7;
  const completed = dataset.runs.filter((run) => run.status === "completed");
  const groups = [...groupBy(completed, (run) => `${run.repo}\n${run.path}\n${run.workflow}`).values()];
  let unsampled = 0;
  const estimates = groups.flatMap((runs) => {
    const minutes = sampled(runs).map((run) => jobMinutes(run.jobs));
    if (minutes.length === 0) {
      unsampled += runs.length;
      return [];
    }
    const mean = minutes.reduce((sum, value) => sum + value, 0) / minutes.length;
    return [{ repo: runs[0].repo, workflow: runs[0].workflow, runs: runs.length, jobMinutesPerWeek: (mean * runs.length) / weeks }];
  });
  return { groups: estimates, unsampled };
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

function shardMinutes(runs: readonly SampledRun[]): Record<string, Stat> {
  const jobs = runs.flatMap((run) => run.jobs).filter(
    (job) => shardPattern.test(job.name) && (job.conclusion === "success" || job.conclusion === "failure"),
  );
  const groups = groupBy(jobs, (job) => job.name);
  return Object.fromEntries(
    [...groups.keys()].sort().map((name) => [name, stat(groups.get(name)?.map((job) => jobSeconds(job) / 60) ?? [])]),
  );
}

/** Whether a run went on to its checks: it was not cancelled, and its tier is not `none` or `draft`. */
const ranChecks = (run: Run): boolean => run.conclusion !== "cancelled" && run.tier !== "none" && run.tier !== "draft";

/** The report of a pair of datasets. */
export function report(inputs: Inputs, options: ReportOptions = defaultReportOptions): Report {
  const ciRuns = inputs.ci.runs.filter(isCi);
  const ciSampled = sampled(ciRuns);
  const ciEstimates = estimateMinutes({ ...inputs.ci, runs: ciRuns }).groups;
  const repos = [...groupBy(ciRuns, (run) => run.repo).entries()].map(([repo, runs]): RepoReport => {
    const runSample = sampled(runs);
    const estimate = ciEstimates.filter((group) => group.repo === repo);
    return {
      repo,
      ...conclusions(runs),
      wallMinutesByEvent: wallByEvent(runs),
      sampled: runSample.length,
      jobMinutesPerRun: stat(runSample.map((run) => jobMinutes(run.jobs))),
      byTier: byTier(runSample),
      queueSeconds: stat(queueTimes(runSample)),
      ciJobMinutesPerWeek: estimate.length === 0 ? null : round(sum(estimate.map((group) => group.jobMinutesPerWeek))),
    };
  }).sort((a, b) => (b.ciJobMinutesPerWeek ?? 0) - (a.ciJobMinutesPerWeek ?? 0) || b.runs - a.runs);

  const queue = queueTimes(ciSampled);
  const org = estimateMinutes(inputs.org);
  const orgWeeks = inputs.org.days / 7;
  const orgTotal = sum(org.groups.map((group) => group.jobMinutesPerWeek));
  const workflows = groupBy(org.groups, (group) => (group.workflow.toLowerCase() === "ci" ? "ci" : group.workflow));
  const repoMinutes = groupBy(org.groups, (group) => group.repo);
  const byRepo = [...repoMinutes.entries()]
    .map(([repo, groups]) => {
      const minutes = sum(groups.map((group) => group.jobMinutesPerWeek));
      return { repo, jobMinutesPerWeek: Math.round(minutes), share: round(minutes / orgTotal) ?? 0 };
    })
    .sort((a, b) => b.jobMinutesPerWeek - a.jobMinutesPerWeek);

  const focusRuns = ciRuns.filter((run) => run.repo === options.focus);
  const focusSample = sampled(focusRuns);
  const ofTier = (tier: Tier): TierStat => tierStat(focusSample.filter((run) => run.tier === tier));
  const small = repos.filter((repo) => repo.jobMinutesPerRun.median !== null && repo.jobMinutesPerRun.median < options.smallJobMinutes);
  const smallNames = new Set(small.map((repo) => repo.repo));

  return {
    window: { ci: windowOf(inputs.ci), org: windowOf(inputs.org) },
    ci: {
      repos: repos.length,
      ...conclusions(ciRuns),
      wallMinutesByEvent: wallByEvent(ciRuns),
      byTier: byTier(ciSampled),
      queueSeconds: { ...stat(queue), overMinuteShare: share(queue.filter((seconds) => seconds > 60).length, queue.length) },
    },
    org: {
      completedRuns: inputs.org.runs.filter((run) => run.status === "completed").length,
      unsampledRuns: org.unsampled,
      jobMinutesPerWeek: Math.round(orgTotal),
      ciJobMinutesPerWeek: Math.round(sum(workflows.get("ci")?.map((group) => group.jobMinutesPerWeek) ?? [])),
      byWorkflow: [...workflows.entries()]
        .map(([workflow, groups]) => ({
          workflow,
          repos: new Set(groups.map((group) => group.repo)).size,
          runsPerWeek: Math.round(sum(groups.map((group) => group.runs)) / orgWeeks),
          jobMinutesPerWeek: Math.round(sum(groups.map((group) => group.jobMinutesPerWeek))),
        }))
        .sort((a, b) => b.jobMinutesPerWeek - a.jobMinutesPerWeek),
      byRepo,
    },
    focus: {
      repo: options.focus,
      shareOfOrgJobMinutes: byRepo.find((repo) => repo.repo === options.focus)?.share ?? null,
      pullRequestWallMinutes: stat(
        focusRuns.filter((run) => run.status === "completed" && run.event === "pull_request").map(wallMinutes),
      ),
      full: ofTier("full"),
      fast: ofTier("fast"),
      queue: ofTier("queue"),
      shardMinutes: shardMinutes(focusSample),
    },
    smallModules: {
      repos: [...smallNames].sort(),
      wallSeconds: stat(ciSampled.filter((run) => smallNames.has(run.repo) && ranChecks(run)).map((run) => wallMinutes(run) * 60)),
    },
    repos,
  };
}

const fixed = (value: number | null, digits = 1): string => (value === null ? "-" : value.toFixed(digits));
const percent = (value: number | null): string => (value === null ? "-" : `${Math.round(value * 100)}%`);
const brief = (value: Stat, digits = 1): string => `${fixed(value.median, digits)}/${fixed(value.p90, digits)} n=${value.n}`;

/** A short plain-text table of a report: medians and 90th percentiles as `median/p90 n=count`. */
export function formatTable(result: Report): string {
  const { ci, org, focus, smallModules, window } = result;
  const lines = [
    `CI runs ${window.ci.from.slice(0, 10)}..${window.ci.to.slice(0, 10)} (${window.ci.days} d): ${ci.runs} in ${ci.repos} repos, cancelled ${percent(ci.cancelledShare)}, failed ${percent(ci.failedShare)}`,
    `Wall-clock min by event: ${Object.entries(ci.wallMinutesByEvent).map(([event, value]) => `${event} ${brief(value)}`).join(" | ")}`,
    `By tier (sampled), wall min; job-min: ${Object.entries(ci.byTier).map(([tier, value]) => `${tier} ${brief(value.wallMinutes)}; ${brief(value.jobMinutes)}`).join(" | ")}`,
    `Queue s: ${brief(ci.queueSeconds)}, over 60 s ${percent(ci.queueSeconds.overMinuteShare)}`,
    `Org job-min/week (${window.org.days} d window): ${org.jobMinutesPerWeek}, ci ${org.ciJobMinutesPerWeek}, ${org.completedRuns} completed runs, ${org.unsampledRuns} unsampled`,
    `  top workflows: ${org.byWorkflow.slice(0, 5).map((row) => `${row.workflow} ${row.jobMinutesPerWeek}`).join(", ")}`,
    `  top repos: ${org.byRepo.slice(0, 5).map((row) => `${row.repo} ${row.jobMinutesPerWeek} (${percent(row.share)})`).join(", ")}`,
    `${focus.repo}: ${percent(focus.shareOfOrgJobMinutes)} of org job-min; PR wall min ${brief(focus.pullRequestWallMinutes)}`,
    ...(["full", "fast", "queue"] as const).map((tier) => `  ${tier}: wall min ${brief(focus[tier].wallMinutes)}; job-min ${brief(focus[tier].jobMinutes)}`),
    ...Object.entries(focus.shardMinutes).map(([name, value]) => `  ${name}: min ${brief(value)}`),
    `Small modules (${smallModules.repos.length} repos): wall s ${brief(smallModules.wallSeconds, 0)}`,
    "",
    "repo                              runs  cancel  fail  job-min/run       ci job-min/week",
    ...result.repos.map((repo) =>
      `${repo.repo.padEnd(32)} ${String(repo.runs).padStart(5)}  ${percent(repo.cancelledShare).padStart(6)}  ${percent(repo.failedShare).padStart(4)}  ${brief(repo.jobMinutesPerRun).padEnd(16)}  ${fixed(repo.ciJobMinutesPerWeek, 0)}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

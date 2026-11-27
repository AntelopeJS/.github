import { isBoolean, isList, isNumber, isObject, isText, isTextOrNull, isTexts, type Json } from "./json.ts";

/** A job of a nightly run, of any attempt, as `jobs?filter=all` lists it. */
export interface NightlyJob {
  id: number;
  name: string;
  attempt: number;
  conclusion: string | null;
  /** Whether a runner took the job: a job a billing block or a lost runner stopped lists no step. */
  started: boolean;
  /** The first step that failed. */
  failedStep: string | null;
}

/** A completed CI run of the `schedule` event on a repository's default branch. */
export interface Nightly {
  id: number;
  sha: string;
  startedAt: string;
  conclusion: string | null;
  url: string;
  /** The jobs of every attempt, read for the nightlies that did not succeed. */
  jobs?: NightlyJob[];
}

/** The facts the report reads for one repository whose default branch has a merge queue. */
export interface RepoNightlies {
  repo: string;
  /** Oldest first. */
  nightlies: Nightly[];
  /** The best conclusion of the merge queue's CI runs of each commit the queue tested. */
  queue: Record<string, "success" | "failure">;
  /** The commits of each `<base>...<head>` range a failure needs, oldest first. */
  commits: Record<string, string[]>;
  /** The failure annotations of each failed job, by job id. */
  annotations: Record<string, string[]>;
}

/** The nightlies of the `days` before `to`, and of the week before them, which holds their baselines. */
export interface NightlyDataset {
  org: string;
  to: string;
  days: number;
  repos: RepoNightlies[];
}

/**
 * What a reproduced test failure of a nightly says about the merge queue. `missed`: every commit since the
 * baseline passed its queue run. `unqueued`: a commit since the baseline has no passing queue run, such as a
 * push that bypassed the queue or a commit from before the rollout. `no-new-commit`: the baseline ran the same
 * commit. `no-baseline`: no earlier nightly of the dataset passed the job. `flake`: neither a re-run nor the
 * next nightly failed the job again. `pending`: nothing failed it again yet, and the next nightly has not run.
 * `infra`: the runner, billing or network failed, not the code.
 */
export const verdicts = ["missed", "unqueued", "no-new-commit", "no-baseline", "flake", "pending", "infra"] as const;
export type Verdict = (typeof verdicts)[number];
export type Counts = Record<Verdict, number>;

export type QueueResult = "passed" | "failed" | "none";

/** A job that failed in the first attempt of a nightly. */
export interface Failure {
  repo: string;
  nightly: { id: number; url: string; startedAt: string; sha: string };
  job: string;
  jobId: number;
  kind: "infra" | "test";
  /** The failure annotations, which name the failed tests where the test runner reports to GitHub. */
  tests: string[];
  reproducedBy: "rerun" | "next-nightly" | null;
  /** The last earlier nightly that passed the job. */
  baseline: { id: number; sha: string } | null;
  commits: { sha: string; queue: QueueResult }[];
  verdict: Verdict;
}

export interface RepoNightlyReport {
  repo: string;
  nightlies: number;
  failedNightlies: number;
  counts: Counts;
  latest: { nightly: Nightly; failures: Failure[] } | null;
}

export interface NightlyReport {
  window: { from: string; to: string; days: number };
  counts: Counts;
  repos: RepoNightlyReport[];
  /** Each failure of each nightly of the window. A failure streak since one baseline counts once, by its first failure. */
  failures: Failure[];
}

const dayMs = 86_400_000;
const failed = (conclusion: string | null): boolean => conclusion === "failure" || conclusion === "timed_out";
const setupSteps = new Set(["Set up job", "Set up runner", "Initialize containers", "Complete runner"]);
const infraPattern =
  /spending limit|account payments|billing|runner has received a shutdown signal|lost communication with the server|no space left on device|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|ERR_SOCKET_TIMEOUT|ERR_PNPM_META_FETCH_FAIL|npm ERR! network|502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out/i;

/** The range key of `commits`. */
export const rangeKey = (base: string, head: string): string => `${base}...${head}`;

/** Whether a failure is the runner's, billing's or the network's rather than the code's. */
export function failureKind(job: NightlyJob, annotations: readonly string[]): "infra" | "test" {
  if (!job.started || (job.failedStep !== null && setupSteps.has(job.failedStep))) return "infra";
  return annotations.some((annotation) => infraPattern.test(annotation)) ? "infra" : "test";
}

/** The jobs that failed in a nightly's first attempt, without the `checks` and `ubuntu` gates when another job failed. */
export function failedJobs(nightly: Nightly): NightlyJob[] {
  const first = (nightly.jobs ?? []).filter((job) => job.attempt === 1 && failed(job.conclusion));
  const others = first.filter((job) => !/(^|\/ )(checks|ubuntu)$/.test(job.name));
  return others.length > 0 ? others : first;
}

function passedJob(nightly: Nightly, name: string): boolean {
  if (nightly.conclusion === "success") return true;
  return (nightly.jobs ?? []).some((job) => job.name === name && job.conclusion === "success");
}

function reproducedBy(nightlies: readonly Nightly[], index: number, job: NightlyJob): Failure["reproducedBy"] {
  const rerun = nightlies[index].jobs?.some((other) => other.name === job.name && other.attempt > 1 && failed(other.conclusion));
  if (rerun === true) return "rerun";
  const next = nightlies[index + 1];
  const again = next?.jobs?.some((other) => other.name === job.name && other.attempt === 1 && failed(other.conclusion));
  return again === true ? "next-nightly" : null;
}

function verdictOf(failure: Omit<Failure, "verdict">, hasNext: boolean): Verdict {
  if (failure.kind === "infra") return "infra";
  if (failure.reproducedBy === null) return hasNext ? "flake" : "pending";
  if (failure.baseline === null) return "no-baseline";
  if (failure.baseline.sha === failure.nightly.sha) return "no-new-commit";
  const allPassed = failure.commits.length > 0 && failure.commits.every((commit) => commit.queue === "passed");
  return allPassed ? "missed" : "unqueued";
}

/** Reads an own key of a string-keyed table, never one inherited from `Object.prototype`. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The failures of a repository's nightlies that started at `from` or later. */
export function failuresOf(repo: RepoNightlies, from: number): Failure[] {
  const { nightlies } = repo;
  return nightlies.flatMap((nightly, index) => {
    if (Date.parse(nightly.startedAt) < from) return [];
    return failedJobs(nightly).map((job): Failure => {
      const baseline = nightlies.slice(0, index).findLast((earlier) => passedJob(earlier, job.name)) ?? null;
      const tests = own(repo.annotations, String(job.id)) ?? [];
      const range = baseline === null ? [] : own(repo.commits, rangeKey(baseline.sha, nightly.sha)) ?? [];
      const failure = {
        repo: repo.repo,
        nightly: { id: nightly.id, url: nightly.url, startedAt: nightly.startedAt, sha: nightly.sha },
        job: job.name,
        jobId: job.id,
        kind: failureKind(job, tests),
        tests,
        reproducedBy: reproducedBy(nightlies, index, job),
        baseline: baseline === null ? null : { id: baseline.id, sha: baseline.sha },
        commits: range.map((sha) => ({ sha, queue: queueResult(own(repo.queue, sha)) })),
      };
      return { ...failure, verdict: verdictOf(failure, index + 1 < nightlies.length) };
    });
  });
}

const queueResult = (conclusion: "success" | "failure" | undefined): QueueResult =>
  conclusion === "success" ? "passed" : conclusion === "failure" ? "failed" : "none";

const zero = (): Counts => ({ missed: 0, unqueued: 0, "no-new-commit": 0, "no-baseline": 0, flake: 0, pending: 0, infra: 0 });

/** The first failure of each streak: a job that keeps failing the same way since the same baseline is one failure. */
export function streaks(failures: readonly Failure[]): Failure[] {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    const key = `${failure.repo}\n${failure.job}\n${failure.kind}\n${failure.baseline?.id ?? "none"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function count(failures: readonly Failure[]): Counts {
  const counts = zero();
  for (const failure of streaks(failures)) counts[failure.verdict]++;
  return counts;
}

/** The start of a dataset's window. */
export const windowStart = (dataset: NightlyDataset): number => Date.parse(dataset.to) - dataset.days * dayMs;

/** The report of a dataset: each failure of the window with its verdict, counted per repository and organization-wide. */
export function nightlyReport(dataset: NightlyDataset): NightlyReport {
  const from = windowStart(dataset);
  const failures = dataset.repos.flatMap((repo) => failuresOf(repo, from));
  const repos = dataset.repos.map((repo): RepoNightlyReport => {
    const inWindow = repo.nightlies.filter((nightly) => Date.parse(nightly.startedAt) >= from);
    const own = failures.filter((failure) => failure.repo === repo.repo);
    const latest = inWindow.at(-1);
    return {
      repo: repo.repo,
      nightlies: inWindow.length,
      failedNightlies: inWindow.filter((nightly) => failed(nightly.conclusion)).length,
      counts: count(own),
      latest: latest === undefined ? null : { nightly: latest, failures: own.filter((failure) => failure.nightly.id === latest.id) },
    };
  }).sort((a, b) => b.counts.missed - a.counts.missed || b.failedNightlies - a.failedNightlies || a.repo.localeCompare(b.repo));
  return {
    window: { from: new Date(from).toISOString(), to: dataset.to, days: dataset.days },
    counts: count(failures),
    repos,
    failures,
  };
}

/** The repositories whose latest nightly of the window failed, in the order of the report. */
export function failedLatest(result: NightlyReport): RepoNightlyReport[] {
  return result.repos.filter((repo) => repo.latest !== null && failed(repo.latest.nightly.conclusion));
}

const short = (sha: string): string => sha.slice(0, 7);
const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

function describe(failure: Failure): string {
  const reproduced = failure.reproducedBy === null ? "not reproduced" : `reproduced by the ${failure.reproducedBy === "rerun" ? "re-run" : "next nightly"}`;
  const commits = failure.baseline === null
    ? "no earlier nightly passed it"
    : failure.commits.length === 0
      ? `no commit since ${short(failure.baseline.sha)}`
      : `commits since ${short(failure.baseline.sha)}: ${failure.commits.map((commit) => `${short(commit.sha)} queue ${commit.queue}`).join(", ")}`;
  const tests = failure.tests.length === 0 ? "" : `; ${failure.tests.slice(0, 5).map((test) => `\`${cell(test).slice(0, 160)}\``).join(", ")}`;
  return `- \`${failure.job}\`, ${failure.kind}, ${reproduced}: **${failure.verdict}**. ${commits}${tests}`;
}

/** The report as Markdown, for a job summary. */
export function formatNightlyMarkdown(result: NightlyReport): string {
  const { window, counts, repos } = result;
  const header = ["repo", "nightlies", "failed", ...verdicts];
  const row = (name: string, nightlies: number, failedNightlies: number, values: Counts): string =>
    `| ${[name, nightlies, failedNightlies, ...verdicts.map((verdict) => values[verdict])].join(" | ")} |`;
  const red = failedLatest(result);
  const lines = [
    `# Nightly failures the merge queue missed, ${window.from.slice(0, 10)}..${window.to.slice(0, 10)} (${window.days} d)`,
    "",
    `Missed by the queue: **${counts.missed}** in ${repos.length} repositories with a merge queue. A job that keeps failing since the same baseline counts once.`,
    "",
    `| ${header.join(" | ")} |`,
    `|${header.map(() => " --- ").join("|")}|`,
    ...repos.filter((repo) => repo.failedNightlies > 0).map((repo) => row(repo.repo, repo.nightlies, repo.failedNightlies, repo.counts)),
    row("**org**", sumOf(repos, (repo) => repo.nightlies), sumOf(repos, (repo) => repo.failedNightlies), counts),
    "",
    `## Latest nightly`,
    "",
    `${repos.length - red.length} of ${repos.length} repositories passed their latest nightly or have none in the window.`,
    ...red.flatMap((repo) => {
      const latest = repo.latest;
      if (latest === null) return [];
      return [
        "",
        `### ${repo.repo}: [${latest.nightly.startedAt.slice(0, 16).replace("T", " ")}](${latest.nightly.url}), ${short(latest.nightly.sha)}`,
        "",
        ...(latest.failures.length === 0 ? ["- no failed job in its first attempt"] : latest.failures.map(describe)),
      ];
    }),
  ];
  return `${lines.join("\n")}\n`;
}

const sumOf = <T>(items: readonly T[], value: (item: T) => number): number => items.reduce((total, item) => total + value(item), 0);

function savedJob(raw: Json): NightlyJob | null {
  if (!isObject(raw)) return null;
  const { id, name, attempt, conclusion, started, failedStep } = raw;
  if (!isNumber(id) || !isText(name) || !isNumber(attempt) || !isBoolean(started)) return null;
  if (!isTextOrNull(conclusion) || !isTextOrNull(failedStep)) return null;
  return { id, name, attempt, conclusion, started, failedStep };
}

function savedNightly(raw: Json): Nightly | null {
  if (!isObject(raw)) return null;
  const { id, sha, startedAt, conclusion, url, jobs } = raw;
  if (!isNumber(id) || !isText(sha) || !isText(startedAt) || !isText(url) || !isTextOrNull(conclusion)) return null;
  const nightly: Nightly = { id, sha, startedAt, conclusion, url };
  if (isList(jobs)) {
    const parsed = jobs.map(savedJob);
    if (parsed.some((job) => job === null)) return null;
    nightly.jobs = parsed.flatMap((job) => job ?? []);
  }
  return nightly;
}

function savedRepo(raw: Json): RepoNightlies | null {
  if (!isObject(raw) || !isText(raw.repo) || !isList(raw.nightlies)) return null;
  const { queue, commits, annotations } = raw;
  if (!isObject(queue) || !Object.values(queue).every((value) => value === "success" || value === "failure")) return null;
  if (!isObject(commits) || !Object.values(commits).every(isTexts)) return null;
  if (!isObject(annotations) || !Object.values(annotations).every(isTexts)) return null;
  const nightlies = raw.nightlies.map(savedNightly);
  if (nightlies.some((nightly) => nightly === null)) return null;
  return {
    repo: raw.repo,
    nightlies: nightlies.flatMap((nightly) => nightly ?? []),
    // SAFETY: every value was checked above to be "success" or "failure".
    queue: queue as Record<string, "success" | "failure">,
    // SAFETY: every value was checked above to be a string array.
    commits: commits as Record<string, string[]>,
    // SAFETY: every value was checked above to be a string array.
    annotations: annotations as Record<string, string[]>,
  };
}

/** A dataset that `--save` wrote, or `null` when the value is not one. */
export function parseNightlyDataset(raw: Json): NightlyDataset | null {
  if (!isObject(raw) || !isText(raw.org) || !isText(raw.to) || !isNumber(raw.days) || !isList(raw.repos)) return null;
  const repos = raw.repos.map(savedRepo);
  if (repos.some((repo) => repo === null)) return null;
  return { org: raw.org, to: raw.to, days: raw.days, repos: repos.flatMap((repo) => repo ?? []) };
}

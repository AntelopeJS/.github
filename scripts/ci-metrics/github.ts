import { execFileSync } from "node:child_process";
import { isList, isNumber, isObject, isText, parseJson, textOf, type Json } from "./json.ts";
import { isCi, isTierJob, parseTier, pickSample, type Dataset, type Job, type Run } from "./metrics.ts";

/** A job of the REST API's `jobs` list, or `null` when the value is not one. */
export function parseJob(raw: Json): Job | null {
  if (!isObject(raw) || !isText(raw.name)) return null;
  return {
    name: raw.name,
    conclusion: textOf(raw.conclusion),
    createdAt: textOf(raw.created_at),
    startedAt: textOf(raw.started_at),
    completedAt: textOf(raw.completed_at),
  };
}

/** The jobs of a `jobs` page of the REST API. */
export function parseJobs(raw: Json): Job[] {
  if (!isObject(raw) || !isList(raw.jobs)) return [];
  return raw.jobs.flatMap((job) => parseJob(job) ?? []);
}

/** The id of the `Tier` job on a `jobs` page of the REST API, if the page lists one that ran. */
export function tierJobId(raw: Json): number | undefined {
  if (!isObject(raw) || !isList(raw.jobs)) return undefined;
  for (const job of raw.jobs) {
    const parsed = parseJob(job);
    if (parsed !== null && isTierJob(parsed) && parsed.conclusion !== "skipped" && isObject(job) && isNumber(job.id)) {
      return job.id;
    }
  }
  return undefined;
}

/**
 * A workflow run of the REST API, or `null` when the value is not one. `fallback` names the repository and
 * workflow of a record that lacks them.
 */
export function parseRun(raw: Json, fallback: { repo?: string; workflow?: string; path?: string } = {}): Run | null {
  if (!isObject(raw) || !isNumber(raw.id)) return null;
  const repository = isObject(raw.repository) ? textOf(raw.repository.name) : null;
  const repo = textOf(raw.repo) ?? repository ?? fallback.repo;
  const workflow = textOf(raw.name) ?? fallback.workflow;
  const startedAt = textOf(raw.run_started_at) ?? textOf(raw.created_at);
  const updatedAt = textOf(raw.updated_at);
  const event = textOf(raw.event);
  const status = textOf(raw.status);
  if (repo === undefined || workflow === undefined || startedAt === null || updatedAt === null || event === null || status === null) {
    return null;
  }
  return {
    repo,
    id: raw.id,
    workflow,
    path: textOf(raw.path) ?? fallback.path ?? workflow,
    event,
    status,
    conclusion: textOf(raw.conclusion),
    startedAt,
    updatedAt,
  };
}

/** How a collection reads the organization. */
export interface CollectOptions {
  org: string;
  days: number;
  to: Date;
  ciSample: number;
  otherSample: number;
  concurrency: number;
}

const api = "https://api.github.com";
const maxListed = 1000;

function token(): string {
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
}

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** How long a rate-limited response asks to wait, or `null` when it is not rate-limited. */
function rateLimitWait(response: Response): number | null {
  if (response.status !== 403 && response.status !== 429) return null;
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) return Math.max(0, Number(retryAfter) * 1000);
  if (response.headers.get("x-ratelimit-remaining") !== "0") return null;
  return Math.max(1000, Number(response.headers.get("x-ratelimit-reset")) * 1000 - Date.now() + 1000);
}

/**
 * A GET of the REST API that waits out the primary and secondary rate limits, retries a server or network error
 * three times, and returns a 404 or 410 response instead of throwing.
 */
export function client(fetcher: typeof fetch): (path: string) => Promise<Response> {
  const headers = {
    authorization: `Bearer ${token()}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "antelopejs-ci-metrics",
  };
  return async function request(path: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetcher(`${api}${path}`, { headers });
      } catch (error) {
        if (attempt >= 3) throw error;
        await wait(2000 * (attempt + 1));
        continue;
      }
      const limited = rateLimitWait(response);
      if (limited !== null) {
        await wait(limited);
        continue;
      }
      if (response.status >= 500 && attempt < 3) {
        await wait(2000 * (attempt + 1));
        continue;
      }
      if (!response.ok && response.status !== 404 && response.status !== 410) {
        throw new Error(`GET ${path}: ${response.status} ${await response.text()}`);
      }
      return response;
    }
  };
}

/** `work` over `items`, `size` at a time, results in the order of `items`. */
export async function pool<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

/** The organization's unarchived repositories, with their default branch. */
export async function listRepos(
  json: (path: string) => Promise<Json>,
  org: string,
): Promise<{ name: string; defaultBranch: string }[]> {
  const repos: { name: string; defaultBranch: string }[] = [];
  for (let page = 1; ; page++) {
    const listed = await json(`/orgs/${org}/repos?type=all&per_page=100&page=${page}`);
    if (!isList(listed) || listed.length === 0) return repos;
    for (const repo of listed) {
      if (isObject(repo) && repo.archived !== true && isText(repo.name)) {
        repos.push({ name: repo.name, defaultBranch: textOf(repo.default_branch) ?? "main" });
      }
    }
  }
}

/**
 * Every workflow run of the organization's unarchived repositories started in the window, with the jobs of
 * a sample of each workflow's completed runs and the tier of each sampled CI run.
 */
export async function collect(options: CollectOptions, fetcher: typeof fetch = fetch): Promise<Dataset> {
  const request = client(fetcher);
  const json = async (path: string): Promise<Json> => {
    const response = await request(path);
    return response.ok ? parseJson(await response.text()) : null;
  };

  const repos = (await listRepos(json, options.org)).map((repo) => repo.name);

  const to = Math.floor(options.to.getTime() / 1000) * 1000;
  const from = to - options.days * 86_400_000;
  const listRuns = async (repo: string, start: number, end: number): Promise<Run[]> => {
    const range = `${new Date(start).toISOString()}..${new Date(end - 1000).toISOString()}`;
    const runs: Run[] = [];
    for (let page = 1; ; page++) {
      const listed = await json(`/repos/${options.org}/${repo}/actions/runs?per_page=100&page=${page}&created=${range}`);
      if (!isObject(listed) || !isList(listed.workflow_runs)) return runs;
      if (page === 1 && isNumber(listed.total_count) && listed.total_count > maxListed && end - start > 60_000) {
        const middle = start + Math.floor((end - start) / 2000) * 1000;
        return [...(await listRuns(repo, start, middle)), ...(await listRuns(repo, middle, end))];
      }
      for (const raw of listed.workflow_runs) {
        const run = parseRun(raw, { repo });
        if (run !== null) runs.push(run);
      }
      if (listed.workflow_runs.length < 100) return runs;
    }
  };
  const runs = (await pool(repos, options.concurrency, (repo) => listRuns(repo, from, to))).flat();

  const completed = runs.filter((run) => run.status === "completed");
  const groups = new Map<string, Run[]>();
  for (const run of completed) {
    const key = `${run.repo}\n${run.path}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [run]);
    else group.push(run);
  }
  const sample = [...groups.values()].flatMap((group) => pickSample(group, isCi(group[0]) ? options.ciSample : options.otherSample));

  await pool(sample, options.concurrency, async (run) => {
    const jobs: Job[] = [];
    let tierJob: number | undefined;
    for (let page = 1; ; page++) {
      const listed = await json(`/repos/${options.org}/${run.repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`);
      const pageJobs = parseJobs(listed);
      jobs.push(...pageJobs);
      tierJob ??= tierJobId(listed);
      if (pageJobs.length < 100) break;
    }
    run.jobs = jobs;
    if (!isCi(run) || tierJob === undefined) return;
    const response = await request(`/repos/${options.org}/${run.repo}/actions/jobs/${tierJob}/logs`);
    if (response.ok) run.tier = parseTier(await response.text());
  });

  return { to: new Date(to).toISOString(), days: options.days, runs };
}

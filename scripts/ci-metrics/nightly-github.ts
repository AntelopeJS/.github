import { client, listRepos, parseRun, pool } from "./github.ts";
import { isList, isNumber, isObject, isText, parseJson, textOf, type Json } from "./json.ts";
import { isCi } from "./metrics.ts";
import { failuresOf, rangeKey, type Nightly, type NightlyDataset, type NightlyJob, type RepoNightlies } from "./nightly.ts";

/** How a collection reads the organization. */
export interface NightlyOptions {
  org: string;
  days: number;
  to: Date;
  concurrency: number;
}

const dayMs = 86_400_000;
const baselineDays = 7;
const perRepo = 2;
const maxListed = 1000;

/** A job of the REST API's `jobs?filter=all` list, or `null` when the value is not one. */
export function parseNightlyJob(raw: Json): NightlyJob | null {
  if (!isObject(raw) || !isNumber(raw.id) || !isText(raw.name)) return null;
  const steps = isList(raw.steps) ? raw.steps.filter(isObject) : [];
  const failedStep = steps.find((step) => step.conclusion === "failure");
  return {
    id: raw.id,
    name: raw.name,
    attempt: isNumber(raw.run_attempt) ? raw.run_attempt : 1,
    conclusion: textOf(raw.conclusion),
    started: steps.length > 0,
    failedStep: textOf(failedStep?.name),
  };
}

/** The failure annotations of a check run, without the generic exit code line every failed step adds. */
export function parseAnnotations(raw: Json): string[] {
  if (!isList(raw)) return [];
  return raw.flatMap((annotation) => {
    if (!isObject(annotation) || annotation.annotation_level !== "failure" || !isText(annotation.message)) return [];
    if (/^Process completed with exit code \d+\.?$/.test(annotation.message)) return [];
    const title = isText(annotation.title) && annotation.title !== "" ? `${annotation.title}: ` : "";
    return [`${title}${annotation.message}`.split("\n")[0]];
  });
}

/**
 * The nightly CI runs of every repository whose default branch has a merge queue, with the facts their failures
 * need: the jobs of each nightly that did not succeed, the merge queue result of each commit, the commits since
 * each failure's baseline, and the annotations of each failed job.
 */
export async function collectNightlies(options: NightlyOptions, fetcher: typeof fetch = fetch): Promise<NightlyDataset> {
  const request = client(fetcher);
  const json = async (path: string): Promise<Json> => {
    const response = await request(path);
    return response.ok ? parseJson(await response.text()) : null;
  };
  const pages = async (path: string, items: (listed: Json) => Json[]): Promise<Json[]> => {
    const all: Json[] = [];
    for (let page = 1; ; page++) {
      const listed = items(await json(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`));
      all.push(...listed);
      if (listed.length < 100) return all;
    }
  };
  const runsOf = (listed: Json): Json[] => (isObject(listed) && isList(listed.workflow_runs) ? listed.workflow_runs : []);
  const jobsOf = (listed: Json): Json[] => (isObject(listed) && isList(listed.jobs) ? listed.jobs : []);
  const commitsOf = (listed: Json): Json[] => (isObject(listed) && isList(listed.commits) ? listed.commits : []);

  const to = Math.floor(options.to.getTime() / 1000) * 1000;
  const created = `${new Date(to - (options.days + baselineDays) * dayMs).toISOString()}..${new Date(to - 1000).toISOString()}`;
  const repos = await listRepos(json, options.org);
  const queued = (await pool(repos, options.concurrency, async (repo) => {
    const rules = await json(`/repos/${options.org}/${repo.name}/rules/branches/${encodeURIComponent(repo.defaultBranch)}`);
    return isList(rules) && rules.some((rule) => isObject(rule) && rule.type === "merge_queue") ? [repo] : [];
  })).flat();

  const collected = await pool(queued, options.concurrency, async ({ name, defaultBranch }): Promise<RepoNightlies> => {
    const base = `/repos/${options.org}/${name}`;
    const listed = await pages(`${base}/actions/runs?event=schedule&status=completed&branch=${encodeURIComponent(defaultBranch)}&created=${created}`, runsOf);
    const nightlies: Nightly[] = listed.flatMap((raw) => {
      const run = parseRun(raw, { repo: name });
      if (run === null || !isCi(run) || !isObject(raw) || !isText(raw.head_sha)) return [];
      const startedAt = textOf(raw.created_at) ?? run.startedAt;
      return [{ id: run.id, sha: raw.head_sha, startedAt, conclusion: run.conclusion, url: textOf(raw.html_url) ?? "" }];
    }).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    await pool(nightlies.filter((nightly) => nightly.conclusion !== "success"), perRepo, async (nightly) => {
      nightly.jobs = (await pages(`${base}/actions/runs/${nightly.id}/jobs?filter=all`, jobsOf)).flatMap((raw) => parseNightlyJob(raw) ?? []);
    });

    const queue: RepoNightlies["queue"] = {};
    const queueRuns = `${base}/actions/runs?event=merge_group&status=completed&created=${created}`;
    const first = await json(`${queueRuns}&per_page=1`);
    if (isObject(first) && isNumber(first.total_count) && first.total_count > maxListed) {
      throw new Error(`${name} lists ${first.total_count} merge queue runs, over the ${maxListed} the API returns: shorten --days`);
    }
    for (const raw of await pages(queueRuns, runsOf)) {
      const run = parseRun(raw, { repo: name });
      if (run === null || !isCi(run) || !isObject(raw) || !isText(raw.head_sha)) continue;
      if (queue[raw.head_sha] !== "success") queue[raw.head_sha] = run.conclusion === "success" ? "success" : "failure";
    }

    const repo: RepoNightlies = { repo: name, nightlies, queue, commits: {}, annotations: {} };
    const failures = failuresOf(repo, to - options.days * dayMs);
    const ranges = new Set(failures.flatMap((failure) =>
      failure.baseline === null || failure.baseline.sha === failure.nightly.sha ? [] : [rangeKey(failure.baseline.sha, failure.nightly.sha)]));
    await pool([...ranges], perRepo, async (range) => {
      repo.commits[range] = (await pages(`${base}/compare/${range}`, commitsOf)).flatMap((commit) =>
        isObject(commit) && isText(commit.sha) ? [commit.sha] : []);
    });
    await pool([...new Set(failures.map((failure) => failure.jobId))], perRepo, async (jobId) => {
      repo.annotations[String(jobId)] = parseAnnotations(await json(`${base}/check-runs/${jobId}/annotations?per_page=50`));
    });
    return repo;
  });

  return { org: options.org, to: new Date(to).toISOString(), days: options.days, repos: collected };
}

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJobs, parseRun } from "./github.ts";
import { isTier, type Dataset, type Inputs, type Run } from "./metrics.ts";

const dayMs = 86_400_000;
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

function datasetOf(runs: Run[]): Dataset {
  const starts = runs.map((run) => Date.parse(run.startedAt));
  const to = Math.ceil(Math.max(...starts) / dayMs) * dayMs;
  return { to: new Date(to).toISOString(), days: Math.ceil((to - Math.min(...starts)) / dayMs), runs };
}

function attach(run: Run, jobsFile: string, tierFile?: string): Run {
  if (!existsSync(jobsFile)) return run;
  const tier = tierFile !== undefined && existsSync(tierFile) ? readFileSync(tierFile, "utf8").trim() : "";
  return {
    ...run,
    jobs: parseJobs(readJson(jobsFile)),
    ...(isTier(tier) ? { tier } : {}),
  };
}

/**
 * The datasets of a directory in the layout of the November 2026 baseline: `runs_<repo>.json` with the CI
 * runs of each repository, `jobs/<repo>_<run>.json` and `tier/<repo>_<run>.txt` for its sample,
 * `org_runs.json` with every workflow run of the organization, and `orgjobs/<repo>_<run>.json` for its sample.
 */
export function loadBaseline(directory: string): Inputs {
  const ci = readdirSync(directory)
    .flatMap((file) => /^runs_(.+)\.json$/.exec(file)?.[1] ?? [])
    .flatMap((repo) => {
      const listed = readJson(join(directory, `runs_${repo}.json`));
      return (Array.isArray(listed) ? listed : []).flatMap((raw: unknown) => {
        const run = parseRun(raw, { repo, workflow: "ci", path: ".github/workflows/ci.yml" });
        return run === null ? [] : [attach(run, join(directory, "jobs", `${repo}_${run.id}.json`), join(directory, "tier", `${repo}_${run.id}.txt`))];
      });
    });
  const listed = readJson(join(directory, "org_runs.json"));
  const org = (Array.isArray(listed) ? listed : []).flatMap((raw: unknown) => {
    const run = parseRun(raw);
    return run === null ? [] : [attach(run, join(directory, "orgjobs", `${run.repo}_${run.id}.json`))];
  });
  return { ci: datasetOf(ci), org: datasetOf(org) };
}

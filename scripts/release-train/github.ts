import type { Entry } from "./plan.ts";
import { exec, isRecord, type System } from "./system.ts";

const runPollMilliseconds = 15_000;
const dispatchPollMilliseconds = 5_000;
const dispatchPollAttempts = 24;

function parseRuns(text: string): { id: number; branch: string }[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error(`gh run list answered ${text}`);
  return value.flatMap((run: unknown) =>
    isRecord(run) && typeof run.databaseId === "number" && typeof run.headBranch === "string"
      ? [{ id: run.databaseId, branch: run.headBranch }]
      : [],
  );
}

/** Dispatches the `release.yml` run of a release entry and returns the id of the run it started. */
export function dispatch(system: System, entry: Extract<Entry, { status: "release" }>, branch: string): number {
  const { slug, directory } = entry.source;
  const list = (): { id: number; branch: string }[] =>
    parseRuns(
      exec(system, "gh", [
        "run", "list", "--repo", slug, "--workflow", "release.yml", "--event", "workflow_dispatch",
        "--json", "databaseId,headBranch", "--limit", "20",
      ]),
    );
  const before = new Set(list().map((run) => run.id));
  exec(system, "gh", [
    "workflow", "run", "release.yml", "--repo", slug, "--ref", branch,
    "-f", `release-version=${entry.to}`,
    "-f", `dependency-ranges=${JSON.stringify(entry.ranges)}`,
    ...(directory === "." ? [] : ["-f", `package-directory=${directory}`]),
  ]);
  for (let attempt = 0; attempt < dispatchPollAttempts; attempt += 1) {
    system.sleep(dispatchPollMilliseconds);
    const created = list()
      .filter((run) => !before.has(run.id) && run.branch === branch)
      .sort((left, right) => left.id - right.id)[0];
    if (created !== undefined) return created.id;
  }
  throw new Error(`No release.yml run appeared in ${slug} after the dispatch of ${entry.to}.`);
}

/** Polls a workflow run until it completes and returns its conclusion and URL. */
export function awaitRun(system: System, slug: string, id: number): { conclusion: string; url: string } {
  for (;;) {
    const value: unknown = JSON.parse(
      exec(system, "gh", ["run", "view", String(id), "--repo", slug, "--json", "status,conclusion,url"]),
    );
    if (!isRecord(value)) throw new Error(`gh run view ${id} answered ${String(value)}`);
    if (value.status === "completed") {
      return { conclusion: String(value.conclusion ?? ""), url: String(value.url ?? "") };
    }
    system.sleep(runPollMilliseconds);
  }
}

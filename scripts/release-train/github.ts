import { isAncestor, type Checkout, type Revision } from "./git.ts";
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
export function dispatch(system: System, entry: Extract<Entry, { status: "release" }>): number {
  const { slug, directory, branch } = entry.source;
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

interface MergedPull {
  number: number;
  mergeCommit: string;
  head: string;
}

function parsePulls(text: string): MergedPull[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((pull: unknown) =>
      isRecord(pull) &&
      typeof pull.number === "number" &&
      typeof pull.headRefOid === "string" &&
      isRecord(pull.mergeCommit) &&
      typeof pull.mergeCommit.oid === "string"
        ? [{ number: pull.number, mergeCommit: pull.mergeCommit.oid, head: pull.headRefOid }]
        : [],
    )
    .sort((left, right) => right.number - left.number);
}

/**
 * Answers whether the branch a checkout was read at holds a commit. The branch holds it when the commit
 * is an ancestor of the branch head, or of the head of a pull request merged into the branch. A squash
 * merge of `next` into the default branch keeps the preview's commit only in the head of its pull request.
 * Any `gh` failure answers no.
 */
export function commitSearch(system: System): (from: Checkout, revision: Revision, sha: string) => boolean {
  const pulls = new Map<string, MergedPull[]>();
  const answers = new Map<string, boolean>();
  const mergedPulls = (slug: string, branch: string): MergedPull[] => {
    const key = `${slug} ${branch}`;
    const cached = pulls.get(key);
    if (cached !== undefined) return cached;
    const result = system.run("gh", [
      "pr", "list", "--repo", slug, "--base", branch, "--state", "merged", "--limit", "100",
      "--json", "number,mergeCommit,headRefOid",
    ]);
    const found = result.status === 0 ? parsePulls(result.stdout) : [];
    pulls.set(key, found);
    return found;
  };
  const holds = (slug: string, sha: string, head: string): boolean => {
    const result = system.run("gh", ["api", `repos/${slug}/compare/${sha}...${head}`, "--jq", ".status"]);
    const status = result.stdout.trim();
    return result.status === 0 && (status === "ahead" || status === "identical");
  };
  const search = ({ repository, slug }: Checkout, revision: Revision, sha: string): boolean => {
    const resolved = system.run("git", ["-C", repository, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
    if (resolved.status !== 0) return false;
    const commit = resolved.stdout.trim();
    if (isAncestor(system, repository, commit, revision.name)) return true;
    return mergedPulls(slug, revision.branch).some(
      (pull) => isAncestor(system, repository, pull.mergeCommit, revision.name) && holds(slug, commit, pull.head),
    );
  };
  return (from, revision, sha) => {
    const key = `${from.repository} ${revision.name} ${sha}`;
    const cached = answers.get(key);
    if (cached !== undefined) return cached;
    const answer = search(from, revision, sha);
    answers.set(key, answer);
    return answer;
  };
}

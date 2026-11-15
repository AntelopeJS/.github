import { isAncestor, type Checkout, type MergedPull, type Revision } from "./git.ts";
import { renderReleaseNotes, type Release } from "./plan.ts";
import { isRecord, type System } from "./system.ts";

const runPollMilliseconds = 15_000;
const runViewRetries = 8;
const dispatchPollMilliseconds = 5_000;
const dispatchPollAttempts = 24;

/**
 * How a dispatched release ended. `failed` means nothing was published. `unknown` means the dispatch was
 * accepted but the train could not see how its run ended, so the package may be published.
 */
export type RunOutcome =
  | { kind: "success"; url: string }
  | { kind: "failed"; detail: string }
  | { kind: "unknown"; detail: string; url: string };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseRuns(text: string): { id: number; branch: string }[] | null {
  const value = parseJson(text);
  if (!Array.isArray(value)) return null;
  return value.flatMap((run: unknown) =>
    isRecord(run) && typeof run.databaseId === "number" && typeof run.headBranch === "string"
      ? [{ id: run.databaseId, branch: run.headBranch }]
      : [],
  );
}

function listRuns(system: System, slug: string): { id: number; branch: string }[] | null {
  const result = system.run("gh", [
    "run", "list", "--repo", slug, "--workflow", "release.yml", "--event", "workflow_dispatch",
    "--json", "databaseId,headBranch", "--limit", "20",
  ]);
  return result.status === 0 ? parseRuns(result.stdout) : null;
}

function viewRun(system: System, slug: string, id: number): { status: string; conclusion: string; url: string } | null {
  const result = system.run("gh", ["run", "view", String(id), "--repo", slug, "--json", "status,conclusion,url"]);
  const value = result.status === 0 ? parseJson(result.stdout) : null;
  if (!isRecord(value) || typeof value.status !== "string") return null;
  return { status: value.status, conclusion: String(value.conclusion ?? ""), url: String(value.url ?? "") };
}

function awaitRun(system: System, slug: string, id: number): RunOutcome {
  const url = `https://github.com/${slug}/actions/runs/${id}`;
  let failures = 0;
  for (;;) {
    const run = viewRun(system, slug, id);
    failures = run === null ? failures + 1 : 0;
    if (failures > runViewRetries) {
      return { kind: "unknown", detail: `gh run view failed ${failures} times in a row`, url };
    }
    if (run?.status === "completed") {
      return run.conclusion === "success"
        ? { kind: "success", url: run.url || url }
        : { kind: "failed", detail: `(${run.conclusion})  ${run.url || url}` };
    }
    system.sleep(runPollMilliseconds);
  }
}

/** Dispatches the `release.yml` run of a release entry and waits until the train knows how it ended. */
export function releaseRun(system: System, entry: Release): RunOutcome {
  const { slug, directory, branch, head } = entry.source;
  const before = listRuns(system, slug);
  if (before === null) return { kind: "failed", detail: `gh run list --repo ${slug} failed, so nothing was dispatched` };
  const known = new Set(before.map((run) => run.id));
  const dispatched = system.run("gh", [
    "workflow", "run", "release.yml", "--repo", slug, "--ref", branch,
    "-f", `release-version=${entry.to}`,
    "-f", `release-commit=${head}`,
    "-f", `dependency-ranges=${JSON.stringify(entry.ranges)}`,
    "-f", `release-notes=${renderReleaseNotes(entry)}`,
    ...(directory === "." ? [] : ["-f", `package-directory=${directory}`]),
  ]);
  if (dispatched.status !== 0) {
    return { kind: "failed", detail: `gh workflow run release.yml --repo ${slug} failed\n${dispatched.stderr.trim()}` };
  }
  for (let attempt = 0; attempt < dispatchPollAttempts; attempt += 1) {
    system.sleep(dispatchPollMilliseconds);
    const created = (listRuns(system, slug) ?? [])
      .filter((run) => !known.has(run.id) && run.branch === branch)
      .sort((left, right) => left.id - right.id)[0];
    if (created !== undefined) return awaitRun(system, slug, created.id);
  }
  return { kind: "unknown", detail: "no release.yml run appeared after the dispatch", url: `https://github.com/${slug}/actions` };
}

function parsePulls(text: string): MergedPull[] {
  const value = parseJson(text);
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

/** Reads the last 100 pull requests merged into a branch of a repository, newest first, once each. A `gh` failure gives null. */
export type MergedPulls = (slug: string, branch: string) => MergedPull[] | null;

/** The {@link MergedPulls} reader of the train, which caches each answer. */
export function mergedPulls(system: System): MergedPulls {
  const pulls = new Map<string, MergedPull[] | null>();
  return (slug, branch) => {
    const key = `${slug} ${branch}`;
    const cached = pulls.get(key);
    if (cached !== undefined) return cached;
    const result = system.run("gh", [
      "pr", "list", "--repo", slug, "--base", branch, "--state", "merged", "--limit", "100",
      "--json", "number,mergeCommit,headRefOid",
    ]);
    const found = result.status === 0 ? parsePulls(result.stdout) : null;
    pulls.set(key, found);
    return found;
  };
}

/**
 * Answers whether the branch a checkout was read at holds a commit. The branch holds it when the commit
 * is an ancestor of the branch head, or of the head of a pull request merged into the branch. A squash
 * merge of `next` into the default branch keeps the preview's commit only in the head of its pull request.
 * Any `gh` failure answers no.
 */
export function commitSearch(system: System, pulls: MergedPulls): (from: Checkout, revision: Revision, sha: string) => boolean {
  const answers = new Map<string, boolean>();
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
    return (pulls(slug, revision.branch) ?? []).some(
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

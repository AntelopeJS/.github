import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { commitLevel, compareCore, dependencyFields, parseVersion, type Commit, type Manifest, type PackageSource } from "./plan.ts";
import { exec, isRecord, type System } from "./system.ts";

/** A package named on the command line: a GitHub repository or a local checkout, and a directory in it. */
export type Target =
  | { kind: "slug"; slug: string; directory: string }
  | { kind: "path"; path: string; directory: string };

/** A git checkout the train reads, with the GitHub repository it comes from. */
export interface Checkout {
  repository: string;
  slug: string;
  local: boolean;
}

/** The branch the train reads and the git ref that names its head in the checkout. */
export interface Revision {
  branch: string;
  name: string;
}

/** A pull request merged into a branch: its merge commit on the branch, the head commit it merged and the branch it came from. */
export interface MergedPull {
  number: number;
  mergeCommit: string;
  head: string;
  branch: string;
}

/** Where one package lives in a checkout, and what the train reads beside it. */
export interface Place {
  directory: string;
  nested: readonly string[];
  merged: readonly MergedPull[] | null;
  /** The ref of the default branch. Its tags are the stable releases of any branch the train reads. */
  releases: string;
}

const remotePattern = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;
const releaseSubjectPattern = /^(?:(?:chore\(release\)|release): |fix\(deps\): depend on the stable )/;

/** Clones or fetches the repository of a target, or reads a local checkout as it is. */
export function openCheckout(target: Target, system: System): Checkout {
  if (target.kind === "path") {
    const url = exec(system, "git", ["-C", target.path, "remote", "get-url", "origin"]).trim();
    const slug = remotePattern.exec(url)?.[1];
    if (slug === undefined) throw new Error(`The origin of ${target.path} is not a GitHub repository: ${url}`);
    return { repository: target.path, slug, local: true };
  }
  const repository = join(system.cacheDirectory, ...target.slug.split("/"));
  if (existsSync(join(repository, ".git"))) {
    exec(system, "git", ["-C", repository, "fetch", "--quiet", "--tags", "--force", "--prune", "origin"]);
    exec(system, "git", ["-C", repository, "remote", "set-head", "origin", "--auto"]);
  } else {
    mkdirSync(dirname(repository), { recursive: true });
    const url = `https://github.com/${target.slug}.git`;
    exec(system, "git", ["clone", "--quiet", "--filter=blob:none", url, repository]);
  }
  return { repository, slug: target.slug, local: false };
}

function hasRef(system: System, repository: string, ref: string): boolean {
  return system.run("git", ["-C", repository, "rev-parse", "--verify", "--quiet", ref]).status === 0;
}

/** The revision to read: the default branch when ref is null, else the branch ref. */
export function resolveRevision(system: System, { repository, local }: Checkout, ref: string | null): Revision {
  if (ref === null) {
    const result = system.run("git", ["-C", repository, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const branch = result.stdout.trim().replace(/^origin\//, "");
    if (result.status !== 0 || branch === "") {
      throw new Error(`${repository} has no origin/HEAD. Run git remote set-head origin --auto there.`);
    }
    return { branch, name: `refs/remotes/origin/${branch}` };
  }
  if (hasRef(system, repository, `refs/remotes/origin/${ref}`)) {
    return { branch: ref, name: `refs/remotes/origin/${ref}` };
  }
  if (local && hasRef(system, repository, `refs/heads/${ref}`)) return { branch: ref, name: `refs/heads/${ref}` };
  throw new Error(`${repository} has no branch ${ref}.`);
}

function parseManifest(text: string, where: string): Manifest {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.version !== "string") {
    throw new Error(`${where} has no name or version.`);
  }
  if (parseVersion(value.version) === null) throw new Error(`${where} has an invalid version ${value.version}.`);
  const manifest: Manifest = { name: value.name, version: value.version };
  for (const field of dependencyFields) {
    const specs = value[field];
    if (specs === undefined) continue;
    if (!isRecord(specs) || !Object.values(specs).every((spec) => typeof spec === "string")) {
      throw new Error(`${where} has an invalid ${field} field.`);
    }
    manifest[field] = Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, String(spec)]));
  }
  return manifest;
}

function readManifest(system: System, repository: string, revision: string, directory: string, where: string): Manifest | null {
  const file = posix.join(directory, "package.json");
  const listed = exec(system, "git", ["-C", repository, "ls-tree", "--name-only", revision, "--", file]).trim();
  return listed === "" ? null : parseManifest(exec(system, "git", ["-C", repository, "show", `${revision}:${file}`]), where);
}

function readTagName(system: System, repository: string, revision: string, directory: string): string {
  const file = posix.join(directory, ".release-it.json");
  const listed = exec(system, "git", ["-C", repository, "ls-tree", "--name-only", revision, "--", file]).trim();
  let tagName = "v${version}";
  if (listed !== "") {
    const config: unknown = JSON.parse(exec(system, "git", ["-C", repository, "show", `${revision}:${file}`]));
    const git = isRecord(config) ? config.git : undefined;
    if (isRecord(git) && typeof git.tagName === "string") tagName = git.tagName;
  }
  const parts = tagName.split("${version}");
  if (parts.length !== 2 || parts.some((part) => part.includes("${"))) {
    throw new Error(`${repository}/${file} has a git.tagName the train cannot read: ${tagName}`);
  }
  return tagName;
}

function tagPattern(tagName: string): RegExp {
  const parts = tagName.split("${version}");
  const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped[0]}(\\d+\\.\\d+\\.\\d+)${escaped[1]}$`);
}

function parseCommits(log: string): Commit[] {
  return log
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split("\x1f");
      return { sha, subject, level: commitLevel(subject, body) };
    })
    .filter((commit) => !releaseSubjectPattern.test(commit.subject));
}

const logFormat = "--format=%H%x1f%s%x1f%b%x1e";

function hasCommit(system: System, repository: string, sha: string): boolean {
  return system.run("git", ["-C", repository, "--no-lazy-fetch", "cat-file", "-e", `${sha}^{commit}`]).status === 0;
}

function branchHolds(system: System, slug: string, sha: string, branch: string): boolean {
  const path = `repos/${slug}/compare/${sha}...${branch.replace(/[%#?]/g, encodeURIComponent)}`;
  const result = system.run("gh", ["api", path, "--jq", ".status"]);
  if (result.status !== 0) {
    if (/\bHTTP 404\b/.test(`${result.stderr}\n${result.stdout}`)) return false;
    throw new Error(`gh api ${path} failed, so the plan cannot tell whether ${branch} holds commit ${sha.slice(0, 7)}\n${result.stderr.trim()}`);
  }
  const status = result.stdout.trim();
  return status === "ahead" || status === "identical";
}

function cycleNotes(
  system: System,
  slug: string,
  repository: string,
  head: string,
  tag: string | null,
  paths: readonly string[],
  merged: readonly MergedPull[],
  shipped: readonly string[],
): Commit[] {
  const landed = merged.filter((pull) => isAncestor(system, repository, pull.mergeCommit, head));
  const released = (pull: MergedPull): boolean => tag !== null && isAncestor(system, repository, pull.mergeCommit, tag);
  const present = (pull: MergedPull): boolean => hasCommit(system, repository, pull.head);
  const stale = landed.find(
    (pull) =>
      !released(pull) &&
      !present(pull) &&
      pull.branch !== "" &&
      hasRef(system, repository, `refs/remotes/origin/${pull.branch}`) &&
      branchHolds(system, slug, pull.head, pull.branch),
  );
  if (stale !== undefined) {
    throw new Error(
      `${repository} lacks commit ${stale.head.slice(0, 7)}, the head of pull request #${stale.number} from ${stale.branch}, so its origin/${stale.branch} is stale. Run git fetch origin there, then plan again.`,
    );
  }
  const current = landed.filter((pull) => !released(pull) && present(pull));
  const include = [head, ...current.map((pull) => pull.head)];
  const exclude = [...(tag === null ? [] : [tag]), ...shipped];
  const log = exec(system, "git", ["-C", repository, "log", "--no-merges", logFormat, ...include, "--not", ...exclude, "--", ...paths]);
  const replaced = new Set(current.map((pull) => pull.mergeCommit));
  return parseCommits(log).filter((commit) => !replaced.has(commit.sha));
}

/**
 * Reads one package at a revision: its manifest, its last stable tag, the commits since that tag and the
 * commits of the tasks the pull requests merged since that tag carried. Both leave out the `nested`
 * directories, which hold other listed packages. With no merged pull request known, the notes are the commits.
 */
export function readSource(system: System, from: Checkout, { branch, name: revision }: Revision, place: Place): PackageSource {
  const { directory, nested, merged, releases } = place;
  const { repository } = from;
  const where = `${from.slug}:${posix.join(directory, "package.json")}`;
  const manifestText = exec(system, "git", ["-C", repository, "show", `${revision}:${posix.join(directory, "package.json")}`]);
  const manifest = parseManifest(manifestText, where);
  const tagName = readTagName(system, repository, revision, directory);
  const pattern = tagPattern(tagName);
  let stable: { version: string; tag: string } | null = null;
  const tags = new Set([revision, releases].flatMap((ref) => exec(system, "git", ["-C", repository, "tag", "--merged", ref]).split("\n")));
  for (const tag of tags) {
    const version = pattern.exec(tag.trim())?.[1];
    if (version !== undefined && (stable === null || compareCore(version, stable.version) > 0)) {
      stable = { version, tag: tag.trim() };
    }
  }
  const tag = stable === null ? null : `refs/tags/${stable.tag}`;
  const base = stable === null ? null : exec(system, "git", ["-C", repository, "merge-base", `refs/tags/${stable.tag}`, revision]).trim();
  const baseManifest = base === null ? null : readManifest(system, repository, base, directory, `${where} at ${base.slice(0, 7)}`);
  const head = exec(system, "git", ["-C", repository, "rev-parse", "--verify", `${revision}^{commit}`]).trim();
  const paths = [directory, ...nested.map((inner) => `:(exclude)${inner}`)];
  const shipped = (merged ?? [])
    .filter((pull) => tag !== null && isAncestor(system, repository, pull.mergeCommit, tag) && hasCommit(system, repository, pull.head))
    .map((pull) => pull.head);
  const commits = parseCommits(exec(system, "git", ["-C", repository, "log", logFormat, revision, "--not", ...(tag === null ? [] : [tag]), ...shipped, "--", ...paths]));
  const notes = merged === null || merged.length === 0 ? commits : cycleNotes(system, from.slug, repository, head, tag, paths, merged, shipped);
  return { slug: from.slug, directory, branch, head, tagName, manifest, stable: stable?.version ?? null, baseManifest, commits, notes };
}

/** Whether a commit is an ancestor of, or equal to, another commit of the checkout. */
export function isAncestor(system: System, repository: string, ancestor: string, descendant: string): boolean {
  return system.run("git", ["-C", repository, "merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}

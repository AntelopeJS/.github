import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { commitLevel, dependencyFields, highestLevel, revertedCommits, withoutReverts, type Commit, type Manifest, type PackageSource } from "./plan.ts";
import { compareCore, parseVersion } from "./version.ts";
import { isJsonObject, isString, readJson, type Json } from "./json.ts";
import { exec, type System } from "./system.ts";

/** A package named on the command line: a GitHub repository or a local checkout, and a directory in it. */
export type Target =
  | { kind: "slug"; slug: string; directory: string }
  | { kind: "path"; path: string; directory: string };

/** A git checkout the train reads, with the GitHub repository it comes from. */
export interface Checkout {
  repository: string;
  slug: string;
}

/** The default branch the train reads and the git ref that names its head in the checkout. */
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
  /** The directories of the other listed packages of the same checkout. */
  siblings: readonly string[];
  merged: readonly MergedPull[] | null;
}

const remotePattern = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;
const releaseSubjectPattern = /^(?:(?:chore\(release\)|release): |fix\(deps\): depend on the stable )/;

/** Clones or fetches the repository of a target, or reads a local checkout as it is. */
export function openCheckout(target: Target, system: System): Checkout {
  if (target.kind === "path") {
    const url = exec(system, "git", ["-C", target.path, "remote", "get-url", "origin"]).trim();
    const slug = remotePattern.exec(url)?.[1];
    if (slug === undefined) throw new Error(`The origin of ${target.path} is not a GitHub repository: ${url}`);
    return { repository: target.path, slug };
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
  return { repository, slug: target.slug };
}

function hasRef(system: System, repository: string, ref: string): boolean {
  return system.run("git", ["-C", repository, "rev-parse", "--verify", "--quiet", ref]).status === 0;
}

/** The default branch of a checkout, which origin/HEAD names. */
export function resolveRevision(system: System, { repository }: Checkout): Revision {
  const result = system.run("git", ["-C", repository, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const branch = result.stdout.trim().replace(/^origin\//, "");
  if (result.status !== 0 || branch === "") {
    throw new Error(`${repository} has no origin/HEAD. Run git remote set-head origin --auto there.`);
  }
  return { branch, name: `refs/remotes/origin/${branch}` };
}

function parseManifest(text: string, where: string): Manifest {
  const value = readJson(text);
  if (!isJsonObject(value) || !isString(value.name) || !isString(value.version)) {
    throw new Error(`${where} has no name or version.`);
  }
  if (parseVersion(value.version) === null) throw new Error(`${where} has an invalid version ${value.version}.`);
  const manifest: Manifest = { name: value.name, version: value.version };
  for (const field of dependencyFields) {
    const specs = value[field];
    if (specs === undefined) continue;
    if (!isJsonObject(specs) || !Object.values(specs).every(isString)) {
      throw new Error(`${where} has an invalid ${field} field.`);
    }
    manifest[field] = Object.fromEntries(Object.entries(specs).flatMap(([name, spec]) => (isString(spec) ? [[name, spec]] : [])));
  }
  return manifest;
}

function readManifest(system: System, repository: string, revision: string, directory: string, where: string): Manifest | null {
  const file = posix.join(directory, "package.json");
  const listed = exec(system, "git", ["-C", repository, "ls-tree", "--name-only", revision, "--", file]).trim();
  return listed === "" ? null : parseManifest(exec(system, "git", ["-C", repository, "show", `${revision}:${file}`]), where);
}

/**
 * The directories under a workspace root that hold a released package, a `package.json` beside a `.release-it.json`.
 * Null when the directory's own `package.json` names a package, or when no released package is under it.
 */
export function workspacePackages(system: System, { repository }: Checkout, { name: revision }: Revision, directory: string): string[] | null {
  const value = readJson(exec(system, "git", ["-C", repository, "show", `${revision}:${posix.join(directory, "package.json")}`]));
  if (isJsonObject(value) && isString(value.name) && isString(value.version)) return null;
  const files = exec(system, "git", ["-C", repository, "ls-tree", "-r", "-z", "--name-only", revision, "--", directory]).split("\0");
  const tracked = new Set(files);
  const released = files
    .filter((file) => posix.basename(file) === ".release-it.json")
    .map((file) => posix.dirname(file))
    .filter((inner) => inner !== directory && tracked.has(posix.join(inner, "package.json")));
  return released.length === 0 ? null : released.sort();
}

function packedVersion(system: System, repository: string, revision: string, directory: string): [string, string][] {
  const file = posix.join(directory, "package.json");
  if (exec(system, "git", ["-C", repository, "ls-tree", "--name-only", revision, "--", file]).trim() === "") return [];
  let value: Json;
  try {
    value = readJson(exec(system, "git", ["-C", repository, "show", `${revision}:${file}`]));
  } catch {
    return [];
  }
  if (!isJsonObject(value) || !isString(value.name) || !isString(value.version) || parseVersion(value.version) === null) return [];
  return [[value.name, value.version]];
}

function readTagName(system: System, repository: string, revision: string, directory: string): string {
  const file = posix.join(directory, ".release-it.json");
  const listed = exec(system, "git", ["-C", repository, "ls-tree", "--name-only", revision, "--", file]).trim();
  let tagName = "v${version}";
  if (listed !== "") {
    const config = readJson(exec(system, "git", ["-C", repository, "show", `${revision}:${file}`]));
    const git = isJsonObject(config) ? config.git : undefined;
    if (isJsonObject(git) && isString(git.tagName)) tagName = git.tagName;
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

function parseCommits(log: string, slug: string): Commit[] {
  return log
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const [sha = "", subject = "", body = ""] = record.split("\x1f");
      return { sha, subject, level: commitLevel(subject, body), reverts: revertedCommits(body, slug) };
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

/** The commits of a package from its last stable tag to the head of the default branch. */
interface Range {
  head: string;
  tag: string | null;
  paths: readonly string[];
  /** The heads of the pull requests merged before the tag, whose commits shipped in it. */
  shipped: readonly string[];
}

/** The notes of a release cycle, and the reverted commits that explain each squash commit. */
interface Cycle {
  notes: Commit[];
  explained: Map<string, Commit[]>;
}

function cycleNotes(system: System, { slug, repository }: Checkout, range: Range, merged: readonly MergedPull[], cancelled: ReadonlySet<string>): Cycle {
  const { head, tag, paths, shipped } = range;
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
  const tasks = current
    .filter((pull) => cancelled.has(pull.mergeCommit))
    .flatMap((pull) => {
      const earlier = current.filter((other) => other !== pull && isAncestor(system, repository, other.mergeCommit, pull.mergeCommit)).map((other) => other.head);
      return exec(system, "git", ["-C", repository, "rev-list", pull.head, "--not", head, ...exclude, ...earlier]).split("\n");
    });
  const replaced = new Set([...current.map((pull) => pull.mergeCommit), ...cancelled, ...tasks]);
  const read = parseCommits(log, slug).filter((commit) => !replaced.has(commit.sha));
  const notes = withoutReverts(read);
  const reverted = new Map(read.filter((commit) => !notes.includes(commit)).map((commit) => [commit.sha, commit]));
  const explained = new Map(
    current
      .filter((pull) => reverted.size > 0 && !cancelled.has(pull.mergeCommit))
      .map((pull): [string, Commit[]] => [
        pull.mergeCommit,
        exec(system, "git", ["-C", repository, "rev-list", pull.head, "--not", `${pull.mergeCommit}^`, ...exclude])
          .split("\n")
          .flatMap((sha) => reverted.get(sha) ?? []),
      ]),
  );
  return { notes, explained };
}

function titleExplained(squash: Commit, reverted: readonly Commit[]): boolean {
  const level = highestLevel(reverted);
  return level !== null && (level === "minor" || squash.level !== "minor");
}

/**
 * Reads one package at the default branch: its manifest, its last stable tag, the commits since that tag and the
 * commits of the tasks the pull requests merged since that tag carried. Both leave out the `nested`
 * directories, which hold other listed packages, and each commit that reverts another of the range, with the one it
 * reverts and the tasks of their pull requests. The squash commit of a pull request whose own tasks hold a reverted
 * commit that asks for at least the level of its title, such as a squash titled from every commit of its branch, counts
 * through its remaining tasks, not its title. With no merged pull request known, the notes are the commits.
 */
export function readSource(system: System, from: Checkout, { branch, name: revision }: Revision, place: Place): PackageSource {
  const { directory, nested, siblings, merged } = place;
  const { repository } = from;
  const where = `${from.slug}:${posix.join(directory, "package.json")}`;
  const manifestText = exec(system, "git", ["-C", repository, "show", `${revision}:${posix.join(directory, "package.json")}`]);
  const manifest = parseManifest(manifestText, where);
  const tagName = readTagName(system, repository, revision, directory);
  const pattern = tagPattern(tagName);
  let stable: { version: string; tag: string } | null = null;
  const higher: string[] = [];
  for (const tag of exec(system, "git", ["-C", repository, "tag", "--merged", revision]).split("\n")) {
    const version = pattern.exec(tag.trim())?.[1];
    if (version === undefined) continue;
    if (compareCore(version, manifest.version) > 0) higher.push(tag.trim());
    else if (stable === null || compareCore(version, stable.version) > 0) stable = { version, tag: tag.trim() };
  }
  if (stable === null && higher.length > 0) {
    throw new Error(
      `${manifest.name} has no release tag at or below ${manifest.version}, the version of its package.json on the default branch, only the higher tags ${higher.sort().join(", ")}. Tag the release that version names, then plan again.`,
    );
  }
  const tag = stable === null ? null : `refs/tags/${stable.tag}`;
  const stableManifest = tag === null ? null : readManifest(system, repository, tag, directory, `${where} at ${stable?.tag}`);
  const stableSiblings = Object.fromEntries(siblings.flatMap((inner) => (tag === null ? [] : packedVersion(system, repository, tag, inner))));
  const head = exec(system, "git", ["-C", repository, "rev-parse", "--verify", `${revision}^{commit}`]).trim();
  const paths = [directory, ...nested.map((inner) => `:(exclude)${inner}`)];
  const shipped = (merged ?? [])
    .filter((pull) => tag !== null && isAncestor(system, repository, pull.mergeCommit, tag) && hasCommit(system, repository, pull.head))
    .map((pull) => pull.head);
  const log = parseCommits(
    exec(system, "git", ["-C", repository, "log", logFormat, revision, "--not", ...(tag === null ? [] : [tag]), ...shipped, "--", ...paths]),
    from.slug,
  );
  const kept = withoutReverts(log);
  const cancelled = new Set(log.filter((commit) => !kept.includes(commit)).map((commit) => commit.sha));
  const cycle = merged === null || merged.length === 0 ? null : cycleNotes(system, from, { head, tag, paths, shipped }, merged, cancelled);
  const commits = cycle === null ? kept : kept.filter((commit) => !titleExplained(commit, cycle.explained.get(commit.sha) ?? []));
  const notes = cycle === null ? kept : cycle.notes;
  return { slug: from.slug, directory, branch, head, tagName, manifest, stable: stable?.version ?? null, stableManifest, stableSiblings, commits, notes };
}

/** Whether a commit is an ancestor of, or equal to, another commit of the checkout. */
export function isAncestor(system: System, repository: string, ancestor: string, descendant: string): boolean {
  return system.run("git", ["-C", repository, "merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}

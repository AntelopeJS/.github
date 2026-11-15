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

const remotePattern = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;
const releaseSubjectPattern = /^(?:chore\(release\)|release): /;

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

function tagPattern(system: System, repository: string, revision: string, directory: string): RegExp {
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

/**
 * Reads one package at a revision: its manifest, its last stable tag and the commits since that tag.
 * The commits leave out the `nested` directories, which hold other listed packages.
 */
export function readSource(
  system: System,
  from: Checkout,
  { branch, name: revision }: Revision,
  directory: string,
  nested: readonly string[],
): PackageSource {
  const { repository } = from;
  const where = `${from.slug}:${posix.join(directory, "package.json")}`;
  const manifestText = exec(system, "git", ["-C", repository, "show", `${revision}:${posix.join(directory, "package.json")}`]);
  const manifest = parseManifest(manifestText, where);
  const pattern = tagPattern(system, repository, revision, directory);
  let stable: { version: string; tag: string } | null = null;
  for (const tag of exec(system, "git", ["-C", repository, "tag", "--merged", revision]).split("\n")) {
    const version = pattern.exec(tag.trim())?.[1];
    if (version !== undefined && (stable === null || compareCore(version, stable.version) > 0)) {
      stable = { version, tag: tag.trim() };
    }
  }
  const range = stable === null ? revision : `refs/tags/${stable.tag}..${revision}`;
  const head = exec(system, "git", ["-C", repository, "rev-parse", "--verify", `${revision}^{commit}`]).trim();
  const paths = [directory, ...nested.map((inner) => `:(exclude)${inner}`)];
  const log = exec(system, "git", ["-C", repository, "log", "--format=%H%x1f%s%x1f%b%x1e", range, "--", ...paths]);
  return { slug: from.slug, directory, branch, head, manifest, stable: stable?.version ?? null, commits: parseCommits(log) };
}

/** Whether a commit is an ancestor of, or equal to, another commit of the checkout. */
export function isAncestor(system: System, repository: string, ancestor: string, descendant: string): boolean {
  return system.run("git", ["-C", repository, "merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}

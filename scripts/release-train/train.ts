import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  commitLevel,
  compareCore,
  computePlan,
  dependencyFields,
  parseVersion,
  renderPlan,
  type Commit,
  type Entry,
  type Manifest,
  type PackageSource,
  type Plan,
} from "./plan.ts";

/** What one process run returned. */
export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs one process to completion. Every process the train starts goes through it. */
export type Run = (command: string, args: readonly string[], options?: { cwd?: string }) => RunResult;

/** Everything the train touches outside its own memory. */
export interface System {
  run: Run;
  sleep: (milliseconds: number) => void;
  out: (text: string) => void;
  err: (text: string) => void;
  cacheDirectory: string;
}

type Target =
  | { kind: "slug"; slug: string; directory: string }
  | { kind: "path"; path: string; directory: string };

interface Command {
  action: "plan" | "go";
  ref: string | null;
  exclude: string[];
  targets: Target[];
}

interface Checkout {
  repository: string;
  slug: string;
  local: boolean;
}

interface Revision {
  branch: string;
  name: string;
}

const usage = [
  "Usage:",
  "  node scripts/release-train/train.ts plan [--ref <branch>] [--exclude <name>]... <package>...",
  "  node scripts/release-train/train.ts go [--exclude <name>]... <package>...",
  "A package is owner/repo or a path to a git checkout, optionally followed by :directory.",
].join("\n");
const slugPattern = /^[\w.-]+\/[\w.-]+$/;
const remotePattern = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;
const releaseSubjectPattern = /^(?:chore\(release\)|release): /;
const runPollMilliseconds = 15_000;
const dispatchPollMilliseconds = 5_000;
const dispatchPollAttempts = 24;

function exec(system: System, command: string, args: readonly string[]): string {
  const result = system.run(command, args);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr.trim()}`);
  }
  return result.stdout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDirectory(text: string, argument: string): string {
  const directory = posix.normalize(text.replace(/\/+$/, ""));
  if (text === "" || posix.isAbsolute(directory) || directory.split("/").includes("..")) {
    throw new Error(`The directory of ${argument} must be a relative path inside the repository.`);
  }
  return directory;
}

function parseTarget(argument: string): Target {
  const colon = argument.indexOf(":");
  const location = colon === -1 ? argument : argument.slice(0, colon);
  const directory = colon === -1 ? "." : parseDirectory(argument.slice(colon + 1), argument);
  if (location.startsWith("/") || location.startsWith(".")) {
    return { kind: "path", path: resolve(location), directory };
  }
  if (!slugPattern.test(location)) {
    throw new Error(`${argument} is neither owner/repo nor a path to a git checkout.\n${usage}`);
  }
  return { kind: "slug", slug: location, directory };
}

function parseCommand(argv: readonly string[]): Command {
  const [action, ...rest] = argv;
  if (action !== "plan" && action !== "go") throw new Error(usage);
  const { values, positionals } = parseArgs({
    args: rest,
    options: { ref: { type: "string" }, exclude: { type: "string", multiple: true } },
    allowPositionals: true,
    strict: true,
  });
  if (action === "go" && values.ref !== undefined) {
    throw new Error("go always releases the default branch, so it takes no --ref.");
  }
  if (positionals.length === 0) throw new Error(usage);
  return {
    action,
    ref: values.ref ?? null,
    exclude: values.exclude ?? [],
    targets: positionals.map(parseTarget),
  };
}

function checkout(target: Target, system: System): Checkout {
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

function resolveRevision(system: System, { repository, local }: Checkout, ref: string | null): Revision {
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

function readSource(system: System, from: Checkout, revision: string, directory: string): PackageSource {
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
  const log = exec(system, "git", ["-C", repository, "log", "--format=%H%x1f%s%x1f%b%x1e", range, "--", directory]);
  return { slug: from.slug, directory, manifest, stable: stable?.version ?? null, commits: parseCommits(log) };
}

function npmLatest(system: System): (name: string) => string | null {
  const cache = new Map<string, string | null>();
  return (name) => {
    if (!cache.has(name)) {
      const result = system.run("npm", ["view", name, "version"]);
      const version = result.stdout.trim();
      cache.set(name, result.status === 0 && parseVersion(version)?.prerelease === null ? version : null);
    }
    return cache.get(name) ?? null;
  };
}

function buildPlan(command: Command, system: System): { plan: Plan; branches: Map<PackageSource, string> } {
  const branches = new Map<PackageSource, string>();
  for (const target of command.targets) {
    const from = checkout(target, system);
    const revision = resolveRevision(system, from, command.ref);
    branches.set(readSource(system, from, revision.name, target.directory), revision.branch);
  }
  const names = [...branches.keys()].map((source) => source.manifest.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) throw new Error(`${duplicate} is listed twice.`);
  const unknown = command.exclude.find((name) => !names.includes(name));
  if (unknown !== undefined) throw new Error(`--exclude ${unknown} names no listed package.`);
  const ref = command.ref ?? [...new Set(branches.values())].join(", ");
  const plan = computePlan([...branches.keys()], { ref, exclude: command.exclude, latestStable: npmLatest(system) });
  return { plan, branches };
}

function parseRuns(text: string): { id: number; branch: string }[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error(`gh run list answered ${text}`);
  return value.flatMap((run: unknown) =>
    isRecord(run) && typeof run.databaseId === "number" && typeof run.headBranch === "string"
      ? [{ id: run.databaseId, branch: run.headBranch }]
      : [],
  );
}

function dispatch(system: System, entry: Extract<Entry, { status: "release" }>, branch: string): number {
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

function awaitRun(system: System, slug: string, id: number): { conclusion: string; url: string } {
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

function label(entry: Extract<Entry, { status: "release" }>): string {
  return `${entry.source.manifest.name} ${entry.to}`;
}

function go(plan: Plan, branches: ReadonlyMap<PackageSource, string>, system: System): number {
  const releases = plan.entries.filter((entry) => entry.status === "release");
  for (const [position, entry] of releases.entries()) {
    const id = dispatch(system, entry, branches.get(entry.source) ?? "");
    const { conclusion, url } = awaitRun(system, entry.source.slug, id);
    if (conclusion === "success") {
      system.out(`published ${label(entry)}  ${url}\n`);
      continue;
    }
    const published = releases.slice(0, position).map(label);
    const left = releases.slice(position).map(label);
    system.err(
      [
        `failed ${label(entry)} (${conclusion})  ${url}`,
        `Published: ${published.length === 0 ? "nothing" : published.join(", ")}.`,
        `Not published: ${left.join(", ")}.`,
        "Fix the failure, then run go again to continue.",
      ].join("\n"),
    );
    return 1;
  }
  return 0;
}

/** Runs the release train CLI and returns its exit code. */
export function main(argv: readonly string[], system: System): number {
  try {
    const command = parseCommand(argv);
    const { plan, branches } = buildPlan(command, system);
    system.out(renderPlan(plan));
    return command.action === "go" ? go(plan, branches, system) : 0;
  } catch (error) {
    system.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function nodeSystem(): System {
  const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return {
    run: (command, args, options = {}) => {
      const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", maxBuffer: 1 << 26 });
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? "",
        stderr: result.error === undefined ? (result.stderr ?? "") : result.error.message,
      };
    },
    sleep: (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(`${text}\n`),
    cacheDirectory: join(cacheRoot, "antelopejs-release-train"),
  };
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2), nodeSystem());

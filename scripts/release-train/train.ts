import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openCheckout, readSource, resolveRevision, type Target } from "./git.ts";
import { awaitRun, dispatch } from "./github.ts";
import { computePlan, parseVersion, renderPlan, type Entry, type PackageSource, type Plan } from "./plan.ts";
import type { System } from "./system.ts";

interface Command {
  action: "plan" | "go";
  ref: string | null;
  exclude: string[];
  targets: Target[];
}

const usage = [
  "Usage:",
  "  node scripts/release-train/train.ts plan [--ref <branch>] [--exclude <name>]... <package>...",
  "  node scripts/release-train/train.ts go [--exclude <name>]... <package>...",
  "A package is owner/repo or a path to a git checkout, optionally followed by :directory.",
].join("\n");
const slugPattern = /^[\w.-]+\/[\w.-]+$/;

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
    const from = openCheckout(target, system);
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

function label(entry: Extract<Entry, { status: "release" }>): string {
  return `${entry.source.manifest.name} ${entry.to}`;
}

function go(plan: Plan, branches: ReadonlyMap<PackageSource, string>, system: System): number {
  const releases = plan.entries.filter((entry) => entry.status === "release");
  for (const [position, entry] of releases.entries()) {
    let failure: string;
    try {
      const id = dispatch(system, entry, branches.get(entry.source) ?? "");
      const { conclusion, url } = awaitRun(system, entry.source.slug, id);
      if (conclusion === "success") {
        system.out(`published ${label(entry)}  ${url}\n`);
        continue;
      }
      failure = `(${conclusion})  ${url}`;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const published = releases.slice(0, position).map(label);
    const left = releases.slice(position).map(label);
    system.err(
      [
        `failed ${label(entry)} ${failure}`,
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

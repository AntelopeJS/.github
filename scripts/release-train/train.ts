import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openCheckout, readSource, resolveRevision, workspacePackages, type Checkout, type Revision, type Target } from "./git.ts";
import { awaitRegistry, commitSearch, mergedPulls, releaseRun, type RunOutcome } from "./github.ts";
import { computePlan, renderPlan, type Holder, type PackageSource, type Plan, type Run } from "./plan.ts";
import type { System } from "./system.ts";

interface Command {
  action: "plan" | "go";
  exclude: string[];
  targets: Target[];
}

const usage = [
  "Usage:",
  "  node scripts/release-train/train.ts plan [--exclude <name>]... <package>...",
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
  if (values.ref !== undefined) {
    throw new Error(`The release train reads only the default branch, so ${action} takes no --ref.`);
  }
  if (positionals.length === 0) throw new Error(usage);
  return {
    action,
    exclude: values.exclude ?? [],
    targets: positionals.map(parseTarget),
  };
}

function location(target: Target): string {
  return target.kind === "slug" ? target.slug : target.path;
}

function isInside(outer: string, inner: string): boolean {
  return inner !== outer && (outer === "." || inner.startsWith(`${outer}/`));
}

function buildPlan(command: Command, system: System): Plan {
  const sources: PackageSource[] = [];
  const places = new Map<string, { from: Checkout; revision: Revision; source: PackageSource }>();
  const checkouts = new Map<string, Checkout>();
  const checkoutOf = (target: Target): Checkout => {
    const from = checkouts.get(location(target)) ?? openCheckout(target, system);
    checkouts.set(location(target), from);
    return from;
  };
  const targets = command.targets.flatMap((target) => {
    const from = checkoutOf(target);
    const packages = workspacePackages(system, from, resolveRevision(system, from), target.directory);
    return packages === null ? [target] : packages.map((directory) => ({ ...target, directory }));
  });
  const pulls = mergedPulls(system);
  for (const target of targets) {
    const from = checkoutOf(target);
    const revision = resolveRevision(system, from);
    const nested = targets
      .filter((other) => location(other) === location(target) && isInside(target.directory, other.directory))
      .map((other) => other.directory);
    const siblings = targets
      .filter((other) => location(other) === location(target) && other.directory !== target.directory)
      .map((other) => other.directory);
    const merged = pulls(from.slug, revision.branch);
    if (merged === null) {
      throw new Error(`gh pr list --repo ${from.slug} --base ${revision.branch} failed, so the plan cannot read the commits of the cycle.`);
    }
    const source = readSource(system, from, revision, { directory: target.directory, nested, siblings, merged });
    sources.push(source);
    places.set(source.manifest.name, { from, revision, source });
  }
  const names = sources.map((source) => source.manifest.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) throw new Error(`${duplicate} is listed twice.`);
  const unknown = command.exclude.find((name) => !names.includes(name));
  if (unknown !== undefined) throw new Error(`--exclude ${unknown} names no listed package.`);
  const ref = [...new Set(sources.map((source) => source.branch))].join(", ");
  const search = commitSearch(system, pulls);
  const contains = (name: string, sha: string, holder: Holder): boolean => {
    const place = places.get(name);
    if (place === undefined) return false;
    if (holder === "head") return search(place.from, place.revision, sha);
    const { stable, tagName } = place.source;
    return stable !== null && search(place.from, { ...place.revision, name: `refs/tags/${tagName.replace("${version}", stable)}` }, sha);
  };
  return computePlan(sources, { ref, exclude: command.exclude, contains });
}

function label(entry: Run): string {
  return `${entry.source.manifest.name} ${entry.status === "release" ? entry.to : "devDependencies"}`;
}

function list(runs: readonly Run[]): string {
  return runs.length === 0 ? "nothing" : runs.map(label).join(", ");
}

function runsOf(plan: Plan): Run[] {
  return plan.entries.filter((entry) => entry.status === "release" || entry.status === "repin");
}

function sameRuns(left: readonly Run[], right: readonly Run[]): boolean {
  const keys = (entries: readonly Run[]): string =>
    entries
      .map((entry) => `${label(entry)} ${JSON.stringify(entry.ranges)} ${entry.status === "release" ? JSON.stringify(entry.siblings) : ""}`)
      .join("\n");
  return keys(left) === keys(right);
}

function published(done: readonly Run[], also: readonly Run[] = []): string {
  return `Published: ${list([...done, ...also].filter((run) => run.status === "release"))}.`;
}

function stopLines(outcome: Exclude<RunOutcome, { kind: "success" }>, entry: Run, done: readonly Run[], rest: readonly Run[]): string[] {
  if (outcome.kind === "failed") {
    return [
      `failed ${label(entry)} ${outcome.detail}`,
      published(done),
      `Not published: ${list([entry, ...rest])}.`,
      "Fix the failure, then run go again to continue.",
    ];
  }
  if (outcome.kind === "incomplete") {
    return [
      `failed ${label(entry)} after npm published it ${outcome.detail}`,
      published(done, [entry]),
      `Not published: ${list(rest)}.`,
      `Run go again: the stable run writes the release commit, tag and GitHub release of ${label(entry)} without publishing it again, then the train continues. If its tag is on the default branch already, only its GitHub release is missing.`,
    ];
  }
  return [
    `unknown ${label(entry)}, ${outcome.detail}`,
    published(done),
    `Not published: ${list(rest)}.`,
    `Unknown: ${label(entry)} (${outcome.url}).`,
    "Check that run before you run go again.",
  ];
}

function go(plan: Plan, replan: () => Plan, system: System): number {
  const done: Run[] = [];
  let pending = runsOf(plan);
  for (let entry = pending[0]; entry !== undefined; entry = pending[0]) {
    const rest = pending.slice(1);
    const outcome = releaseRun(system, entry);
    if (outcome.kind !== "success") {
      system.err(stopLines(outcome, entry, done, rest).join("\n"));
      return 1;
    }
    const { name } = entry.source.manifest;
    if (entry.status === "release" && !awaitRegistry(system, name, entry.to)) {
      system.err(
        [
          `npm does not show ${label(entry)} as ${name} latest within 10 minutes of its release.`,
          published(done, [entry]),
          `Not published: ${list(rest)}.`,
          `Run go again once npm view ${name} dist-tags.latest prints ${entry.to}.`,
        ].join("\n"),
      );
      return 1;
    }
    system.out(`${entry.status === "release" ? "published" : "repinned"} ${label(entry)}  ${outcome.url}\n`);
    done.push(entry);
    pending = rest;
    const { slug, head } = entry.source;
    if (!rest.some((other) => other.source.slug === slug)) continue;
    let next: Run[];
    try {
      next = runsOf(replan());
    } catch (error) {
      system.err(
        [
          `The plan could not be read again after the release of ${label(entry)}: ${error instanceof Error ? error.message : String(error)}`,
          published(done),
          `Not published: ${list(rest)}.`,
        ].join("\n"),
      );
      return 1;
    }
    const moved = next.filter((other) => other.source.slug === slug).every((other) => other.source.head !== head);
    if (!moved || !sameRuns(rest, next)) {
      system.err(
        [
          moved
            ? `The plan changed after the release of ${label(entry)}. Read it with plan, then run go again.`
            : `${slug} did not move after the release of ${label(entry)}. Fetch its checkout, then run go again.`,
          published(done),
          `Not published: ${list(rest)}.`,
        ].join("\n"),
      );
      return 1;
    }
    pending = next;
  }
  const refused = plan.entries.filter((entry) => entry.status === "refused").map((entry) => entry.source.manifest.name);
  const repinned = done.filter((run) => run.status === "repin");
  system.out(`${published(done)}\n`);
  if (repinned.length > 0) system.out(`Repinned, not published: ${repinned.map((run) => run.source.manifest.name).join(", ")}.\n`);
  if (refused.length > 0) system.out(`Refused, not published: ${refused.join(", ")}.\n`);
  return 0;
}

/** Runs the release train CLI and returns its exit code. */
export function main(argv: readonly string[], system: System): number {
  try {
    const command = parseCommand(argv);
    const plan = buildPlan(command, system);
    system.out(renderPlan(plan));
    return command.action === "go" ? go(plan, () => buildPlan(command, system), system) : 0;
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

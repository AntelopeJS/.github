import { bumpVersion, compareCore, isPreviewSpec, isRegistrySpec, parseVersion, requireVersion, stableRange, type Level, type Version } from "./version.ts";

/** One commit since the last stable tag, with the release level it asks for. */
export interface Commit {
  sha: string;
  subject: string;
  level: Level | null;
  /** The commits this commit's message says it reverts. */
  reverts: readonly Reverted[];
}

/** A commit a revert names: by full or abbreviated SHA, or by the number of the pull request whose squash commit it is. */
export type Reverted = { sha: string } | { pull: number };

/** Where a dependency must hold a preview's commit: at its planned head, or at its last stable tag. */
export type Holder = "head" | "stable";

/** One of the four dependency fields of a `package.json`. */
export type DependencyField =
  | "dependencies"
  | "peerDependencies"
  | "optionalDependencies"
  | "devDependencies";

/** The four `package.json` fields that hold dependency specs. */
export const dependencyFields: readonly DependencyField[] = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
];

/** The part of a `package.json` the release train reads. */
export type Manifest = { name: string; version: string } & Partial<
  Record<DependencyField, Record<string, string>>
>;

/** What the IO layer reads from one checkout at its default branch, which holds every stable tag. */
export interface PackageSource {
  slug: string;
  directory: string;
  branch: string;
  head: string;
  /** The `git.tagName` of `.release-it.json`, such as `v${version}`. */
  tagName: string;
  manifest: Manifest;
  stable: string | null;
  /** The manifest at the stable tag, which npm published, or null when there is no stable tag or the tag has no `package.json` in the directory. */
  stableManifest: Manifest | null;
  /** The version of each other listed package of the same checkout at the stable tag, by name, which `pnpm pack` wrote for a `workspace:` spec on it. */
  stableSiblings: Record<string, string>;
  /** The commits on the default branch since the stable tag. */
  commits: Commit[];
  /** The commits of the tasks this release ships, read from the heads of the pull requests merged since the stable tag. */
  notes: Commit[];
}

/** A devDependency preview pin that a release keeps, with the reason it cannot move to a stable range. */
export interface KeptPin {
  name: string;
  spec: string;
  reason: string;
}

/** A `workspace:` spec on a sibling of the same repository, with the registry range `pnpm pack` writes for it. */
export interface Sibling {
  name: string;
  spec: string;
  range: string;
}

/** The release decision for one package. */
export type Entry =
  | {
      status: "release";
      source: PackageSource;
      from: string | null;
      to: string;
      level: Level;
      reasons: string[];
      ranges: Record<string, string>;
      kept: KeptPin[];
      siblings: Sibling[];
    }
  | {
      /** Only devDependency preview pins moved to a stable range: a commit rewrites them, and nothing is published. */
      status: "repin";
      source: PackageSource;
      ranges: Record<string, string>;
    }
  | {
      status: "unchanged";
      source: PackageSource;
      /** Why the commits since the stable tag release nothing, or null when there are none. */
      reason: string | null;
    }
  | { status: "excluded"; source: PackageSource }
  | { status: "refused"; source: PackageSource; reasons: string[] };

/** The entry of a package this plan releases. */
export type Release = Extract<Entry, { status: "release" }>;

/** The entry of a package whose devDependency pins this plan rewrites without a release. */
export type Repin = Extract<Entry, { status: "repin" }>;

/** An entry the train dispatches a run of `release.yml` for. */
export type Run = Release | Repin;

/** One release plan: an entry per package, dependencies first. */
export interface Plan {
  ref: string;
  entries: Entry[];
}

/** Inputs of {@link computePlan} besides the sources. */
export interface PlanOptions {
  ref: string;
  exclude: readonly string[];
  contains: (name: string, sha: string, holder: Holder) => boolean;
}

const commitIdentifierPattern = /^g([0-9a-f]{7,40})$/;
const headerPattern = /^([a-z]+)(?:\(([^()]*)\))?(!)?: (\S.*)$/;
const breakingFooterPattern = /^BREAKING[ -]CHANGE:/m;
const revertedCommitPattern = /^This reverts commit ([0-9a-f]{7,40})\b/gm;
const revertedPullPattern = /^Reverts ([\w.-]+\/[\w.-]+)#(\d+)\s*$/gm;
const patchTypes = new Set(["feat", "fix", "perf", "refactor", "types", "revert"]);
const runtimeFields = dependencyFields.filter((field) => field !== "devDependencies");
const workspacePrefix = "workspace:";

interface Header {
  type: string;
  scope: string;
  breaking: boolean;
  description: string;
}

function parseHeader(subject: string): Header | null {
  const match = headerPattern.exec(subject);
  if (match === null) return null;
  return { type: match[1] ?? "", scope: match[2] ?? "", breaking: match[3] === "!", description: match[4] ?? "" };
}

/** The release level a commit message asks for, or null when it asks for none. */
export function commitLevel(subject: string, body: string): Level | null {
  const header = parseHeader(subject);
  if (header === null) return null;
  if (header.breaking || breakingFooterPattern.test(body)) return "minor";
  return patchTypes.has(header.type) ? "patch" : null;
}

/**
 * The commits a commit message of the repository `slug` says it reverts: each `This reverts commit <sha>` line,
 * and each `Reverts <owner>/<repo>#<n>` line that names a pull request of that repository.
 */
export function revertedCommits(body: string, slug: string): Reverted[] {
  const pulls = [...body.matchAll(revertedPullPattern)]
    .filter((match) => match[1]?.toLowerCase() === slug.toLowerCase())
    .map((match) => ({ pull: Number(match[2]) }));
  return [...[...body.matchAll(revertedCommitPattern)].map((match) => ({ sha: match[1] ?? "" })), ...pulls];
}

function names(commit: Commit, reverted: Reverted): boolean {
  return "sha" in reverted ? commit.sha.startsWith(reverted.sha) : commit.subject.endsWith(` (#${reverted.pull})`);
}

/**
 * The commits less each one that reverts others of them, and the ones it reverts. The commits run newest
 * first, as git log lists them, so a revert that a later commit reverts cancels nothing.
 */
export function withoutReverts(commits: readonly Commit[]): Commit[] {
  const cancelled = new Set<string>();
  commits.forEach((commit, index) => {
    if (cancelled.has(commit.sha)) return;
    const targets = commits
      .slice(index + 1)
      .filter((older) => !cancelled.has(older.sha) && commit.reverts.some((reverted) => names(older, reverted)));
    if (targets.length > 0) [commit, ...targets].forEach((reverting) => cancelled.add(reverting.sha));
  });
  return commits.filter((commit) => !cancelled.has(commit.sha));
}

interface Dependency {
  field: DependencyField;
  name: string;
  spec: string;
}

function dependenciesOf(manifest: Manifest): Dependency[] {
  return dependencyFields.flatMap((field) =>
    Object.entries(manifest[field] ?? {}).map(([name, spec]) => ({ field, name, spec })),
  );
}

function edgesOf(source: PackageSource, targets: ReadonlySet<string>, runtimeOnly: boolean): string[] {
  return dependenciesOf(source.manifest)
    .filter(
      ({ field, name, spec }) =>
        targets.has(name) &&
        name !== source.manifest.name &&
        (field !== "devDependencies" || (!runtimeOnly && isPreviewSpec(spec))),
    )
    .map(({ name }) => name);
}

/** Where Tarjan's walk first reached a package, and the lowest index reachable from it. */
interface Visit {
  index: number;
  low: number;
}

function components(sources: readonly PackageSource[], targets: ReadonlySet<string>, runtimeOnly: boolean): PackageSource[][] {
  const members = new Set(sources.map((source) => source.manifest.name));
  const edges = new Map(
    sources.map((source) => [
      source.manifest.name,
      edgesOf(source, targets, runtimeOnly).filter((name) => members.has(name)),
    ]),
  );
  const visited = new Map<string, Visit>();
  const stack: string[] = [];
  const result: PackageSource[][] = [];

  const visit = (name: string): Visit => {
    const node = { index: visited.size, low: visited.size };
    visited.set(name, node);
    stack.push(name);
    for (const next of edges.get(name) ?? []) {
      const seen = visited.get(next);
      if (seen === undefined) node.low = Math.min(node.low, visit(next).low);
      else if (stack.includes(next)) node.low = Math.min(node.low, seen.index);
    }
    if (node.low === node.index) {
      const members = new Set(stack.splice(stack.lastIndexOf(name)));
      result.push(sources.filter((source) => members.has(source.manifest.name)));
    }
    return node;
  };

  for (const source of sources) {
    if (!visited.has(source.manifest.name)) visit(source.manifest.name);
  }
  return result;
}

function releaseOrder(sources: readonly PackageSource[], exclude: ReadonlySet<string>): PackageSource[][] {
  const targets = new Set(sources.map((source) => source.manifest.name).filter((name) => !exclude.has(name)));
  return components(sources, targets, false).flatMap((component) =>
    component.length === 1 ? [component] : components(component, targets, true),
  );
}

/** The highest level the commits ask for, or null when none asks for one. */
export function highestLevel(commits: readonly Commit[]): Level | null {
  if (commits.some((commit) => commit.level === "minor")) return "minor";
  if (commits.some((commit) => commit.level === "patch")) return "patch";
  return null;
}

function dependencyChanges(source: PackageSource, ranges: Record<string, string>): string[] {
  const { stableManifest: stable } = source;
  if (stable === null) return [];
  return runtimeFields.flatMap((field) => {
    const before = stable[field] ?? {};
    const after = source.manifest[field] ?? {};
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((name) => !(Object.hasOwn(ranges, name) && isPreviewSpec(after[name] ?? "")) && before[name] !== after[name])
      .map((name) => {
        const [from, to] = [before[name], after[name]];
        if (from === undefined) return `adds ${field} ${name}@${to}`;
        if (to === undefined) return `removes ${field} ${name}@${from}`;
        return `moves ${field} ${name} ${from} -> ${to}`;
      });
  });
}

function series(words: readonly string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function quietReason(source: PackageSource): string | null {
  const commits = [...source.commits, ...source.notes];
  if (commits.length === 0) return null;
  const types = [...new Set(commits.map((commit) => parseHeader(commit.subject)?.type ?? "non-conventional"))].sort();
  return `only ${series(types)} commits${source.stable === null ? "" : ` since ${source.stable}`}`;
}

interface AwaitedPin {
  dependent: string;
  spec: string;
  sha: string;
}

interface Resolution {
  listed: ReadonlyMap<string, PackageSource>;
  exclude: ReadonlySet<string>;
  /** For each listed package, the runtime preview pins of other listed packages newer than its stable release. */
  awaited: ReadonlyMap<string, readonly AwaitedPin[]>;
  resolved: ReadonlyMap<string, Entry>;
  contains: (name: string, sha: string, holder: Holder) => boolean;
}

type PinOutcome = { range: string } | { reason: string };

type VersionOutcome = { version: string } | { reason: string };

type SiblingOutcome =
  | {
      range: string;
      /** The range the stable release packed for the sibling when the version the plan gives it falls outside it, else null. */
      published: string | null;
    }
  | { reason: string };

function packedRange(operator: string, version: string): string {
  return operator === "*" ? version : `${operator}${version}`;
}

function admits(operator: string, base: string, version: string): boolean {
  const parts = ({ major, minor, patch }: Version): number[] => [major, minor, patch];
  const from = parts(requireVersion(base));
  const to = parts(requireVersion(version));
  const fixed = operator === "*" ? 3 : operator === "~" ? 2 : from.findIndex((part) => part !== 0) + 1 || 3;
  return from.slice(0, fixed).every((part, index) => part === to[index]);
}

/** The version the plan gives a listed sibling: its planned release, or its stable release when it has none. */
function siblingVersion(name: string, sibling: PackageSource, context: Resolution): VersionOutcome {
  const planned = context.resolved.get(name);
  if (planned === undefined && !context.exclude.has(name)) return { reason: "which releases after it" };
  if (planned?.status === "refused") return { reason: "which is refused" };
  const version = planned?.status === "release" ? planned.to : sibling.stable;
  if (version === null) return { reason: "which has no stable release" };
  if (planned?.status !== "release" && sibling.manifest.version !== version) {
    return { reason: `whose package.json holds ${sibling.manifest.version}, not its stable ${version}` };
  }
  return { version };
}

function resolveSibling(source: PackageSource, { field, name, spec }: Dependency, context: Resolution): SiblingOutcome {
  const range = spec.slice(workspacePrefix.length);
  if (range !== "*" && range !== "^" && range !== "~") return { reason: "which is not workspace:*, workspace:^ or workspace:~" };
  const sibling = context.listed.get(name);
  if (sibling === undefined) return { reason: "which this train does not list" };
  if (sibling.slug !== source.slug) return { reason: `which this train lists from ${sibling.slug}` };
  const outcome = siblingVersion(name, sibling, context);
  if ("reason" in outcome) return outcome;
  const { version } = outcome;
  const packed = source.stableManifest?.[field]?.[name] === spec && Object.hasOwn(source.stableSiblings, name) ? source.stableSiblings[name] : undefined;
  const published = packed === undefined || admits(range, packed, version) ? null : packedRange(range, packed);
  return { range: packedRange(range, version), published };
}

function resolvePin({ name, spec }: Dependency, context: Resolution): PinOutcome {
  const version = parseVersion(spec);
  if (version === null) return { reason: "which is not an exact version" };
  const sha = commitIdentifierPattern.exec(version.prerelease?.split(".").at(-1) ?? "")?.[1];
  if (sha === undefined) return { reason: "which names no commit" };
  const dependency = context.listed.get(name);
  if (dependency === undefined) return { reason: "which this train does not list" };
  if (context.exclude.has(name)) return { reason: "which is not in this release" };
  const planned = context.resolved.get(name);
  if (planned === undefined) return { reason: "which releases after it" };
  if (planned.status === "refused") return { reason: "which is refused" };
  const target = planned.status === "release" ? planned.to : dependency.stable;
  if (target === null) return { reason: "which has no stable release" };
  const base = `${version.major}.${version.minor}.${version.patch}`;
  const older = compareCore(target, base) < 0;
  if (planned.status !== "release") {
    if (context.contains(name, sha, "stable")) return { range: stableRange(target) };
    return { reason: older ? `whose stable ${target} is older than ${base}` : `whose stable ${target} does not contain commit ${sha}` };
  }
  if (older) return { reason: `whose stable ${target} is older than ${base}` };
  if (!context.contains(name, sha, "head")) return { reason: `whose ${dependency.branch} does not contain commit ${sha}` };
  return { range: stableRange(target) };
}

/** What the dependencies of a package resolve to, and why any of them refuses its release. */
interface DependencyResolution {
  refusals: Set<string>;
  ranges: Record<string, string>;
  kept: KeptPin[];
  siblings: Sibling[];
  moves: string[];
  pins: Dependency[];
}

function resolveDependencies(source: PackageSource, context: Resolution): DependencyResolution {
  const refusals = new Set<string>();
  const ranges: Record<string, string> = {};
  const kept: KeptPin[] = [];
  const siblings: Sibling[] = [];
  const moves: string[] = [];
  const pins: Dependency[] = [];
  for (const dependency of dependenciesOf(source.manifest)) {
    const { field, name, spec } = dependency;
    if (field !== "devDependencies" && spec.startsWith(workspacePrefix)) {
      const outcome = resolveSibling(source, dependency, context);
      if ("reason" in outcome) refusals.add(`depends on ${name}@${spec}, ${outcome.reason}`);
      else {
        siblings.push({ name, spec, range: outcome.range });
        if (outcome.published !== null) moves.push(`moves ${field} ${name} ${outcome.published} -> ${outcome.range}`);
      }
      continue;
    }
    if (field !== "devDependencies" && name !== source.manifest.name && context.listed.get(name)?.slug === source.slug) {
      refusals.add(`depends on ${name}@${spec}, a sibling of its workspace it must name as workspace:^`);
      continue;
    }
    if (field !== "devDependencies" && !isRegistrySpec(spec)) {
      refusals.add(`depends on ${name}@${spec}, which is not a registry version range`);
      continue;
    }
    if (!isPreviewSpec(spec)) continue;
    const outcome = resolvePin(dependency, context);
    if ("range" in outcome) {
      ranges[name] = outcome.range;
      pins.push(dependency);
    } else if (field === "devDependencies") kept.push({ name, spec, reason: outcome.reason });
    else refusals.add(`depends on preview ${name}@${spec}, ${outcome.reason}`);
  }
  return { refusals, ranges, kept, siblings, moves, pins };
}

function resolveEntry(source: PackageSource, context: Resolution): Entry {
  const { refusals, ranges, kept, siblings, moves, pins } = resolveDependencies(source, context);
  if (refusals.size > 0) return { status: "refused", source, reasons: [...refusals] };

  const reasons: string[] = [];
  let level = highestLevel([...source.commits, ...source.notes]);
  if (level === null) {
    reasons.push(...dependencyChanges(source, ranges), ...moves);
    const name = source.manifest.name;
    const held = (context.awaited.get(name) ?? []).filter(({ sha }) => context.contains(name, sha, "head"));
    reasons.push(...new Set(held.map(({ dependent, spec }) => `${dependent} pins the preview ${spec}`)));
    if (pins.some(({ field }) => field !== "devDependencies")) reasons.push("replaces preview pins");
    if (reasons.length === 0) {
      return pins.length === 0 ? { status: "unchanged", source, reason: quietReason(source) } : { status: "repin", source, ranges };
    }
    level = "patch";
  }
  const to =
    source.stable === null
      ? source.manifest.version.replace(/-.*$/, "")
      : bumpVersion(source.stable, level);
  return { status: "release", source, from: source.stable, to, level, reasons, ranges, kept, siblings };
}

function awaitedPins(sources: readonly PackageSource[], listed: ReadonlyMap<string, PackageSource>, exclude: ReadonlySet<string>): Map<string, AwaitedPin[]> {
  const awaited = new Map<string, AwaitedPin[]>();
  for (const source of sources) {
    if (exclude.has(source.manifest.name)) continue;
    for (const { field, name, spec } of dependenciesOf(source.manifest)) {
      const dependency = listed.get(name);
      const version = parseVersion(spec);
      const sha = commitIdentifierPattern.exec(version?.prerelease?.split(".").at(-1) ?? "")?.[1];
      if (field === "devDependencies" || dependency === undefined || name === source.manifest.name || version === null || sha === undefined) continue;
      if (dependency.commits.length === 0 && dependency.notes.length === 0) continue;
      const base = `${version.major}.${version.minor}.${version.patch}`;
      if (dependency.stable !== null && compareCore(base, dependency.stable) <= 0) continue;
      awaited.set(name, [...(awaited.get(name) ?? []), { dependent: source.manifest.name, spec, sha }]);
    }
  }
  return awaited;
}

/** Computes the release plan of the sources: one entry per package, dependencies first. */
export function computePlan(sources: readonly PackageSource[], options: PlanOptions): Plan {
  const exclude = new Set(options.exclude);
  const resolved = new Map<string, Entry>();
  const listed = new Map(sources.map((source) => [source.manifest.name, source]));
  const context: Resolution = { listed, exclude, resolved, contains: options.contains, awaited: awaitedPins(sources, listed, exclude) };
  for (const component of releaseOrder(sources, exclude)) {
    const names = component.map((source) => source.manifest.name);
    for (const source of component) {
      const name = source.manifest.name;
      const entry: Entry = exclude.has(name)
        ? { status: "excluded", source }
        : component.length > 1
          ? {
              status: "refused",
              source,
              reasons: [`is in a dependency cycle between ${names.join(", ")}`],
            }
          : resolveEntry(source, context);
      resolved.set(name, entry);
    }
  }
  return { ref: options.ref, entries: [...resolved.values()] };
}

function location(source: PackageSource): string {
  const place = source.directory === "." ? source.slug : `${source.slug}:${source.directory}`;
  return `${place}@${source.head.slice(0, 7)}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function specOf(manifest: Manifest, name: string): string {
  const found = dependenciesOf(manifest).find(
    (dependency) => dependency.name === name && isPreviewSpec(dependency.spec),
  );
  return found?.spec ?? "";
}

function rangeLines(entry: Run): string[] {
  return Object.entries(entry.ranges).map(([name, range]) => `     ${name} ${specOf(entry.source.manifest, name)} -> ${range}`);
}

function renderEntry(entry: Entry, position: number): string[] {
  const { manifest } = entry.source;
  if (entry.status === "refused") {
    return [
      `${position}. ${manifest.name} refused  ${location(entry.source)}`,
      ...entry.reasons.map((reason) => `     ${reason}`),
    ];
  }
  if (entry.status === "repin") {
    return [
      `${position}. ${manifest.name} repins devDependencies, publishes nothing  ${location(entry.source)}`,
      ...rangeLines(entry),
    ];
  }
  if (entry.status !== "release") return [];
  return [
    `${position}. ${manifest.name} ${entry.from ?? "unreleased"} -> ${entry.to} (${entry.level})  ${location(entry.source)}`,
    ...entry.source.notes
      .filter((commit) => commit.level !== null)
      .map((commit) => `     ${commit.subject}`),
    ...entry.reasons.map((reason) => `     ${reason}`),
    ...rangeLines(entry),
    ...entry.siblings.map(({ name, spec, range }) => `     ${name} ${spec} -> ${range}`),
    ...entry.kept.map(({ name, spec, reason }) => `     keeps devDependency ${name}@${spec}, ${reason}`),
  ];
}

/** Renders a plan as the plain text an operator reads before saying go. */
export function renderPlan(plan: Plan): string {
  const numbered = plan.entries.filter(
    (entry) => entry.status === "release" || entry.status === "repin" || entry.status === "refused",
  );
  const count = (status: Entry["status"]): number => numbered.filter((entry) => entry.status === status).length;
  const counts = [
    count("release") > 0 ? `${count("release")} to release` : "",
    count("repin") > 0 ? `${count("repin")} to repin` : "",
    count("refused") > 0 ? `${count("refused")} refused` : "",
  ].filter(Boolean);
  const header =
    numbered.length === 0
      ? `Release plan from ${plan.ref}, nothing to release`
      : `Release plan from ${plan.ref}, ${plural(numbered.length, "package")}: ${counts.join(", ")}`;
  const names = (status: Entry["status"]): string =>
    plan.entries
      .filter((entry) => entry.status === status)
      .map((entry) => entry.source.manifest.name)
      .join(", ");
  const unchanged = plan.entries
    .filter((entry) => entry.status === "unchanged" && entry.reason === null)
    .map((entry) => entry.source.manifest.name)
    .join(", ");
  const quiet = plan.entries.flatMap((entry) =>
    entry.status === "unchanged" && entry.reason !== null ? [`Unchanged: ${entry.source.manifest.name}, ${entry.reason}`] : [],
  );
  const excluded = names("excluded");
  return [
    header,
    "",
    ...numbered.flatMap((entry, offset) => renderEntry(entry, offset + 1)),
    ...(unchanged === "" ? [] : [`Unchanged: ${unchanged}`]),
    ...quiet,
    ...(excluded === "" ? [] : [`Not now: ${excluded}`]),
    "",
  ].join("\n");
}

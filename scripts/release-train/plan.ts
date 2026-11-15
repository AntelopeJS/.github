/** Release level of a commit or a package. A breaking change ships as a minor, never as a major. */
export type Level = "minor" | "patch";

/** One commit since the last stable tag, with the release level it asks for. */
export interface Commit {
  sha: string;
  subject: string;
  level: Level | null;
}

/** The four `package.json` fields that hold dependency specs. */
export const dependencyFields = [
  "dependencies",
  "peerDependencies",
  "optionalDependencies",
  "devDependencies",
] as const;

/** One of the four dependency fields of a `package.json`. */
export type DependencyField = (typeof dependencyFields)[number];

/** The part of a `package.json` the release train reads. */
export type Manifest = { name: string; version: string } & Partial<
  Record<DependencyField, Record<string, string>>
>;

/** What the IO layer reads from one checkout at one ref. */
export interface PackageSource {
  slug: string;
  directory: string;
  manifest: Manifest;
  stable: string | null;
  commits: Commit[];
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
    }
  | { status: "unchanged"; source: PackageSource }
  | { status: "excluded"; source: PackageSource }
  | { status: "refused"; source: PackageSource; reasons: string[] };

/** One release plan: an entry per package, dependencies first. */
export interface Plan {
  ref: string;
  entries: Entry[];
}

/** Inputs of {@link computePlan} besides the sources. */
export interface PlanOptions {
  ref: string;
  exclude: readonly string[];
  latestStable: (name: string) => string | null;
}

interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const previewPattern = /\d+\.\d+\.\d+-/;
const exactPreviewPattern = /^(\d+\.\d+\.\d+)-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/;
const headerPattern = /^([a-z]+)(?:\([^()]*\))?(!)?: \S/;
const breakingFooterPattern = /^BREAKING[ -]CHANGE:/m;
const patchTypes = new Set(["feat", "fix", "perf", "refactor", "docs", "build", "types", "revert"]);

/** Parses `M.m.p` or `M.m.p-pre`, or returns null. */
export function parseVersion(text: string): Version | null {
  const match = versionPattern.exec(text);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function requireVersion(text: string): Version {
  const version = parseVersion(text);
  if (version === null) throw new Error(`not a version: ${text}`);
  return version;
}

/** Orders two versions by major, minor and patch, ignoring any prerelease. */
export function compareCore(left: string, right: string): number {
  const a = requireVersion(left);
  const b = requireVersion(right);
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/** The next version at a level: minor gives `M.(m+1).0`, patch gives `M.m.(p+1)`. */
export function bumpVersion(version: string, level: Level): string {
  const { major, minor, patch } = requireVersion(version);
  return level === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

/** The org range for a stable version: `>=M.m.p <M.(m+1).0`. */
export function stableRange(version: string): string {
  const { major, minor } = requireVersion(version);
  return `>=${version} <${major}.${minor + 1}.0`;
}

/** Whether a dependency spec names a semver prerelease. */
export function isPreviewSpec(spec: string): boolean {
  return previewPattern.test(spec);
}

/** The release level a commit message asks for, or null when it asks for none. */
export function commitLevel(subject: string, body: string): Level | null {
  const match = headerPattern.exec(subject);
  if (match === null) return null;
  if (match[2] === "!" || breakingFooterPattern.test(body)) return "minor";
  return patchTypes.has(match[1] ?? "") ? "patch" : null;
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

function edgesOf(source: PackageSource, listed: ReadonlySet<string>): string[] {
  return dependenciesOf(source.manifest)
    .filter(
      ({ field, name, spec }) =>
        listed.has(name) &&
        name !== source.manifest.name &&
        (field !== "devDependencies" || isPreviewSpec(spec)),
    )
    .map(({ name }) => name);
}

function components(sources: readonly PackageSource[]): PackageSource[][] {
  const listed = new Set(sources.map((source) => source.manifest.name));
  const edges = new Map(sources.map((source) => [source.manifest.name, edgesOf(source, listed)]));
  const visited = new Map<string, { index: number; low: number }>();
  const stack: string[] = [];
  const result: PackageSource[][] = [];

  const visit = (name: string): { index: number; low: number } => {
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

function highestLevel(commits: readonly Commit[]): Level | null {
  if (commits.some((commit) => commit.level === "minor")) return "minor";
  if (commits.some((commit) => commit.level === "patch")) return "patch";
  return null;
}

function resolveEntry(
  source: PackageSource,
  resolved: ReadonlyMap<string, Entry>,
  latestStable: (name: string) => string | null,
): Entry {
  const refusals = new Set<string>();
  const ranges: Record<string, string> = {};
  for (const { name, spec } of dependenciesOf(source.manifest)) {
    if (!isPreviewSpec(spec)) continue;
    const label = `depends on preview ${name}@${spec}`;
    const base = exactPreviewPattern.exec(spec)?.[1];
    const planned = resolved.get(name);
    if (base === undefined) {
      refusals.add(`${label}, which is not an exact version`);
    } else if (planned?.status === "excluded") {
      refusals.add(`${label}, which is not in this release`);
    } else if (planned?.status === "refused") {
      refusals.add(`${label}, which is refused`);
    } else {
      const target = planned?.status === "release" ? planned.to : latestStable(name);
      if (target === null) {
        refusals.add(`${label}, which has no stable release`);
      } else if (compareCore(target, base) < 0) {
        refusals.add(`${label}, whose stable ${target} is older than ${base}`);
      } else {
        ranges[name] = stableRange(target);
      }
    }
  }
  if (refusals.size > 0) return { status: "refused", source, reasons: [...refusals] };

  const reasons: string[] = [];
  let level = highestLevel(source.commits);
  if (level === null) {
    if (Object.keys(ranges).length === 0) return { status: "unchanged", source };
    level = "patch";
    reasons.push("replaces preview pins");
  }
  const to =
    source.stable === null
      ? source.manifest.version.replace(/-.*$/, "")
      : bumpVersion(source.stable, level);
  return { status: "release", source, from: source.stable, to, level, reasons, ranges };
}

/** Computes the release plan of the sources: one entry per package, dependencies first. */
export function computePlan(sources: readonly PackageSource[], options: PlanOptions): Plan {
  const exclude = new Set(options.exclude);
  const resolved = new Map<string, Entry>();
  for (const component of components(sources)) {
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
          : resolveEntry(source, resolved, options.latestStable);
      resolved.set(name, entry);
    }
  }
  return { ref: options.ref, entries: [...resolved.values()] };
}

function location(source: PackageSource): string {
  return source.directory === "." ? source.slug : `${source.slug}:${source.directory}`;
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

function renderEntry(entry: Entry, position: number): string[] {
  const { manifest } = entry.source;
  if (entry.status === "refused") {
    return [
      `${position}. ${manifest.name} refused  ${location(entry.source)}`,
      ...entry.reasons.map((reason) => `     ${reason}`),
    ];
  }
  if (entry.status !== "release") return [];
  return [
    `${position}. ${manifest.name} ${entry.from ?? "unreleased"} -> ${entry.to} (${entry.level})  ${location(entry.source)}`,
    ...entry.source.commits
      .filter((commit) => commit.level !== null)
      .map((commit) => `     ${commit.subject}`),
    ...entry.reasons.map((reason) => `     ${reason}`),
    ...Object.entries(entry.ranges).map(
      ([name, range]) => `     ${name} ${specOf(manifest, name)} -> ${range}`,
    ),
  ];
}

/** Renders a plan as the plain text an operator reads before saying go. */
export function renderPlan(plan: Plan): string {
  const numbered = plan.entries.filter(
    (entry) => entry.status === "release" || entry.status === "refused",
  );
  const releases = numbered.filter((entry) => entry.status === "release").length;
  const refused = numbered.length - releases;
  const counts = [
    releases > 0 ? `${releases} to release` : "",
    refused > 0 ? `${refused} refused` : "",
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
  const unchanged = names("unchanged");
  const excluded = names("excluded");
  return [
    header,
    "",
    ...numbered.flatMap((entry, offset) => renderEntry(entry, offset + 1)),
    ...(unchanged === "" ? [] : [`Unchanged: ${unchanged}`]),
    ...(excluded === "" ? [] : [`Not now: ${excluded}`]),
    "",
  ].join("\n");
}

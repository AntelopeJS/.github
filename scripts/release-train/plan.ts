/** Release level of a commit or a package. A breaking change ships as a minor, never as a major. */
export type Level = "minor" | "patch";

/** One commit since the last stable tag, with the release level it asks for. */
export interface Commit {
  sha: string;
  subject: string;
  author: string;
  level: Level | null;
}

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

/** What the IO layer reads from one checkout at one ref. */
export interface PackageSource {
  slug: string;
  directory: string;
  branch: string;
  head: string;
  /** The `git.tagName` of `.release-it.json`, such as `v${version}`. */
  tagName: string;
  manifest: Manifest;
  stable: string | null;
  /** The commits on the branch since the stable tag. */
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
    }
  | { status: "unchanged"; source: PackageSource }
  | { status: "excluded"; source: PackageSource }
  | { status: "refused"; source: PackageSource; reasons: string[] };

/** The entry of a package this plan releases. */
export type Release = Extract<Entry, { status: "release" }>;

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

interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const previewPattern = /\d+\.\d+\.\d+-/;
const commitIdentifierPattern = /^g([0-9a-f]{7,40})$/;
const headerPattern = /^([a-z]+)(?:\(([^()]*)\))?(!)?: (\S.*)$/;
const breakingFooterPattern = /^BREAKING[ -]CHANGE:/m;
const patchTypes = new Set(["feat", "fix", "perf", "refactor", "docs", "build", "types", "revert"]);
const versionPart = "(?:0|[1-9]\\d*|[xX*])";
const identifiers = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
const partial = `v?${versionPart}(?:\\.${versionPart}(?:\\.${versionPart}(?:-${identifiers})?(?:\\+${identifiers})?)?)?`;
const comparator = `(?:[<>]=?|=|~>?|\\^)?\\s*${partial}`;
const comparatorSet = `(?:${partial}\\s+-\\s+${partial}|${comparator}(?:\\s+${comparator})*)`;
const rangePattern = new RegExp(`^\\s*${comparatorSet}(?:\\s*\\|\\|\\s*${comparatorSet})*\\s*$`);
const aliasPattern = /^npm:(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@(.+)$/;

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

/**
 * Whether a dependency spec resolves from the registry: a semver range, or an `npm:` alias to one.
 * A path, `file:`, `link:`, `workspace:`, git, tarball or dist-tag spec does not.
 */
export function isRegistrySpec(spec: string): boolean {
  return rangePattern.test(aliasPattern.exec(spec)?.[1] ?? spec);
}

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

function components(sources: readonly PackageSource[], targets: ReadonlySet<string>, runtimeOnly: boolean): PackageSource[][] {
  const members = new Set(sources.map((source) => source.manifest.name));
  const edges = new Map(
    sources.map((source) => [
      source.manifest.name,
      edgesOf(source, targets, runtimeOnly).filter((name) => members.has(name)),
    ]),
  );
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

function releaseOrder(sources: readonly PackageSource[], exclude: ReadonlySet<string>): PackageSource[][] {
  const targets = new Set(sources.map((source) => source.manifest.name).filter((name) => !exclude.has(name)));
  return components(sources, targets, false).flatMap((component) =>
    component.length === 1 ? [component] : components(component, targets, true),
  );
}

function highestLevel(commits: readonly Commit[]): Level | null {
  if (commits.some((commit) => commit.level === "minor")) return "minor";
  if (commits.some((commit) => commit.level === "patch")) return "patch";
  return null;
}

interface Resolution {
  listed: ReadonlyMap<string, PackageSource>;
  exclude: ReadonlySet<string>;
  resolved: ReadonlyMap<string, Entry>;
  contains: (name: string, sha: string, holder: Holder) => boolean;
}

type PinOutcome = { range: string } | { reason: string };

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
  if (compareCore(target, base) < 0) return { reason: `whose stable ${target} is older than ${base}` };
  if (planned.status === "release" && !context.contains(name, sha, "head")) {
    return { reason: `whose ${dependency.branch} does not contain commit ${sha}` };
  }
  if (planned.status !== "release" && !context.contains(name, sha, "stable")) {
    return { reason: `whose stable ${target} does not contain commit ${sha}` };
  }
  return { range: stableRange(target) };
}

function resolveEntry(source: PackageSource, context: Resolution): Entry {
  const refusals = new Set<string>();
  const ranges: Record<string, string> = {};
  const kept: KeptPin[] = [];
  for (const dependency of dependenciesOf(source.manifest)) {
    const { field, name, spec } = dependency;
    if (field !== "devDependencies" && !isRegistrySpec(spec)) {
      refusals.add(`depends on ${name}@${spec}, which is not a registry version range`);
      continue;
    }
    if (!isPreviewSpec(spec)) continue;
    const outcome = resolvePin(dependency, context);
    if ("range" in outcome) ranges[name] = outcome.range;
    else if (field === "devDependencies") kept.push({ name, spec, reason: outcome.reason });
    else refusals.add(`depends on preview ${name}@${spec}, ${outcome.reason}`);
  }
  if (refusals.size > 0) return { status: "refused", source, reasons: [...refusals] };

  const reasons: string[] = [];
  let level = highestLevel([...source.commits, ...source.notes]);
  if (level === null) {
    if (Object.keys(ranges).length === 0) return { status: "unchanged", source };
    level = "patch";
    reasons.push("replaces preview pins");
  }
  const to =
    source.stable === null
      ? source.manifest.version.replace(/-.*$/, "")
      : bumpVersion(source.stable, level);
  return { status: "release", source, from: source.stable, to, level, reasons, ranges, kept };
}

/** Computes the release plan of the sources: one entry per package, dependencies first. */
export function computePlan(sources: readonly PackageSource[], options: PlanOptions): Plan {
  const exclude = new Set(options.exclude);
  const resolved = new Map<string, Entry>();
  const listed = new Map(sources.map((source) => [source.manifest.name, source]));
  const context: Resolution = { listed, exclude, resolved, contains: options.contains };
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
    ...entry.source.notes
      .filter((commit) => commit.level !== null)
      .map((commit) => `     ${commit.subject}`),
    ...entry.reasons.map((reason) => `     ${reason}`),
    ...Object.entries(entry.ranges).map(
      ([name, range]) => `     ${name} ${specOf(manifest, name)} -> ${range}`,
    ),
    ...entry.kept.map(({ name, spec, reason }) => `     keeps devDependency ${name}@${spec}, ${reason}`),
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

const noteSections: readonly (readonly [type: string, title: string])[] = [
  ["feat", "🚀 Enhancements"],
  ["perf", "🔥 Performance"],
  ["fix", "🩹 Fixes"],
  ["refactor", "💅 Refactors"],
  ["docs", "📖 Documentation"],
  ["build", "📦 Build"],
  ["types", "🌊 Types"],
  ["revert", "⏪ Reverts"],
  ["chore", "🏡 Chore"],
  ["examples", "🏀 Examples"],
  ["test", "✅ Tests"],
  ["style", "🎨 Styles"],
  ["ci", "🤖 CI"],
];
const trailingPullPattern = /\s*\(#(\d+)\)$/;

interface Note {
  type: string;
  breaking: boolean;
  author: string;
  line: string;
}

function noteOf(commit: Commit, slug: string): Note | null {
  const header = parseHeader(commit.subject);
  if (header === null) return null;
  let { description } = header;
  const pulls: string[] = [];
  for (let match = trailingPullPattern.exec(description); match !== null; match = trailingPullPattern.exec(description)) {
    pulls.unshift(`[#${match[1]}](https://github.com/${slug}/pull/${match[1]})`);
    description = description.slice(0, match.index);
  }
  const links = pulls.length > 0 ? pulls : [`[${commit.sha.slice(0, 7)}](https://github.com/${slug}/commit/${commit.sha})`];
  const scope = header.scope === "" ? "" : `**${header.scope}:** `;
  const line = `- ${scope}${description.charAt(0).toUpperCase()}${description.slice(1)} (${links.join(", ")})`;
  return { type: header.type, breaking: commit.level === "minor", author: commit.author, line };
}

function listNames(names: readonly string[]): string {
  return names.length === 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Renders the changelog section of a release in changelogen's format, without its `## v…` heading: the
 * compare link, one block per commit type with the oldest commit first, the breaking changes, then the
 * contributors. A subject that is not conventional is left out.
 */
export function renderReleaseNotes(entry: Release): string {
  const { slug, tagName, notes } = entry.source;
  const listed = notes
    .toReversed()
    .flatMap((commit) => noteOf(commit, slug) ?? [])
    .filter((note) => noteSections.some(([type]) => type === note.type));
  const names = Object.keys(entry.ranges);
  const deps = names.length === 0 ? [] : [`- **deps:** Depend on the stable ${listNames(names)}`];
  const block = (title: string, lines: readonly string[]): string[] =>
    lines.length === 0 ? [] : [`${title}\n\n${lines.join("\n")}`];
  const tag = (version: string): string => tagName.replace("${version}", version);
  const contributors = [...new Set(listed.map((note) => note.author))].filter((author) => !author.endsWith("[bot]"));
  return [
    ...(entry.from === null ? [] : [`[compare changes](https://github.com/${slug}/compare/${tag(entry.from)}...${tag(entry.to)})`]),
    ...noteSections.flatMap(([type, title]) =>
      block(`### ${title}`, [
        ...listed.filter((note) => note.type === type).map((note) => note.line),
        ...(type === "fix" ? deps : []),
      ]),
    ),
    ...block("#### ⚠️ Breaking Changes", listed.filter((note) => note.breaking).map((note) => note.line)),
    ...block("### ❤️ Contributors", contributors.map((author) => `- ${author}`)),
  ].join("\n\n");
}

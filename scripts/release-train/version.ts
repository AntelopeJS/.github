/** Release level of a commit or a package. A breaking change ships as a minor, never as a major. */
export type Level = "minor" | "patch";

/** A parsed `M.m.p` or `M.m.p-pre` version. */
export interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const previewPattern = /\d+\.\d+\.\d+-/;
const versionPart = "(?:0|[1-9]\\d*|[xX*])";
const identifiers = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
const partial = `v?${versionPart}(?:\\.${versionPart}(?:\\.${versionPart}(?:-${identifiers})?(?:\\+${identifiers})?)?)?`;
const partialPattern = new RegExp(`^${partial}$`);
const comparatorPattern = new RegExp(`^(?:[<>]=?|=|~>?|\\^)?${partial}$`);
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

/** Parses `M.m.p` or `M.m.p-pre`, or throws. */
export function requireVersion(text: string): Version {
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
  const range = aliasPattern.exec(spec)?.[1] ?? spec;
  return range.split("||").every((set) => {
    const words = set.trim().replace(/([<>=~^])\s+/g, "$1").split(/\s+/);
    if (words.length === 3 && words[1] === "-") return words.every((word, index) => index === 1 || partialPattern.test(word));
    return words.every((word) => comparatorPattern.test(word));
  });
}

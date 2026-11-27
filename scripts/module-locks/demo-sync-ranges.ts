import { isObject, isText, type Json, type JsonObject } from "../ci-metrics/json.ts";

/** A dependency range the demo sync raised in a manifest of template-dms-adonis itself. */
export interface MovedRange {
  file: string;
  name: string;
  from: string;
  to: string;
}

/** A manifest after the alignment, and the ranges the alignment moved in it. */
export interface AlignedManifest {
  manifest: Json;
  moved: MovedRange[];
}

/** The sections whose ranges the sync aligns; peer ranges state what a consumer may bring and stay as they are. */
const sections = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/** The `major.minor.patch` a range starts at, or `null` for a range that names no version, such as `workspace:^`. */
export function floorOf(range: string): [number, number, number] | null {
  if (/^(workspace:|npm:|file:|link:|git|https?:|\$)/.test(range)) return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function above(left: [number, number, number], right: [number, number, number]): boolean {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

/** Every range `manifest` declares in the aligned sections, by package name. */
export function rangesOf(manifest: Json): Map<string, string> {
  const ranges = new Map<string, string>();
  if (!isObject(manifest)) return ranges;
  for (const section of sections) {
    const declared = manifest[section];
    if (!isObject(declared)) continue;
    for (const [name, range] of Object.entries(declared)) {
      if (isText(range)) ranges.set(name, range);
    }
  }
  return ranges;
}

/**
 * `owned` with each range raised to the one `synced` declares for the same package, when the synced range starts
 * at a higher version, so the workspace keeps one range per package as its `dependency:one-range` check requires.
 * A range the template holds at a higher or equal version stays: the sync never lowers what Renovate raised.
 */
export function alignRanges(synced: ReadonlyMap<string, string>, owned: Json, file: string): AlignedManifest {
  if (!isObject(owned)) return { manifest: owned, moved: [] };
  const moved: MovedRange[] = [];
  const raise = (declared: JsonObject): JsonObject =>
    Object.fromEntries(Object.entries(declared).map(([name, range]) => {
      const target = synced.get(name);
      if (!isText(range) || target === undefined || target === range) return [name, range];
      const from = floorOf(range);
      const to = floorOf(target);
      if (from === null || to === null || !above(to, from)) return [name, range];
      moved.push({ file, name, from: range, to: target });
      return [name, target];
    }));
  const manifest: JsonObject = Object.fromEntries(Object.entries(owned).map(([key, value]) => {
    const section = sections.find((name) => name === key);
    return [key, section !== undefined && isObject(value) ? raise(value) : value];
  }));
  return { manifest, moved };
}

/** The moved ranges as the rows of a Markdown table, for the pull request body. */
export function formatMovedRanges(moved: readonly MovedRange[]): string {
  if (moved.length === 0) return "";
  const rows = moved.map((range) => `| \`${range.file}\` | \`${range.name}\` | \`${range.from}\` | \`${range.to}\` |`);
  return ["| Manifest | Package | From | To |", "| --- | --- | --- | --- |", ...rows, ""].join("\n");
}

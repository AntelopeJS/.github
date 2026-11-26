import type { PackageSource } from "./plan.ts";
import { compareCore, isPreviewSpec, rangeFloor, requireVersion, type Level } from "./version.ts";

/** A `package.json` field whose ranges on other `@antelopejs` packages a consumer must provide. */
export type RequirementField = "engines" | "peerDependencies";

/** The fields a {@link Requirement} comes from. */
export const requirementFields: readonly RequirementField[] = ["engines", "peerDependencies"];

/** A range a package.json of a package declares on another `@antelopejs` package, which its consumer must provide. */
export interface Requirement {
  /** The `package.json` relative to the package directory, such as `frontend-vue/package.json`. */
  file: string;
  field: RequirementField;
  name: string;
  spec: string;
}

/** A floor a release raises: the plan line that shows it, and the reason that refuses the release unless it is coordinated. */
export interface RaisedFloor {
  line: string;
  refusal: string;
}

/** A requirement whose floor is higher at the head than at the stable tag, which had none when `before` is null. */
interface Raise {
  requirement: Requirement;
  floor: string;
  before: { spec: string; floor: string } | null;
}

function requirementKey({ file, field, name }: Requirement): string {
  return JSON.stringify([file, field, name]);
}

function floorOf(spec: string): string | null {
  return isPreviewSpec(spec) ? null : rangeFloor(spec);
}

function raisedRequirements(source: PackageSource): Raise[] {
  const stable = new Map(source.stableRequirements.map((requirement) => [requirementKey(requirement), requirement.spec]));
  return source.requirements.flatMap((requirement): Raise[] => {
    const floor = floorOf(requirement.spec);
    const spec = stable.get(requirementKey(requirement));
    if (floor === null) return [];
    if (spec === undefined) return [{ requirement, floor, before: null }];
    const before = floorOf(spec);
    return before === null || compareCore(floor, before) <= 0 ? [] : [{ requirement, floor, before: { spec, floor: before } }];
  });
}

function raiseLine({ requirement: { file, field, name, spec }, floor, before }: Raise, level: Level): string {
  if (before === null) return `adds ${field === "engines" ? "an" : "a"} ${field} floor on ${name} in ${file} at ${floor} (${spec}) in a ${level}`;
  return `raises the ${field} floor on ${name} in ${file} from ${before.floor} to ${floor} (${before.spec} -> ${spec}) in a ${level}`;
}

/**
 * The floors a release at a level raises since its stable tag, when the caret range of its stable version admits
 * the bump: a patch of a 0.x version, any release from 1.0.0 on. Such a raise breaks the dependents that lock the
 * required package below the new floor.
 */
export function raisedFloors(source: PackageSource, level: Level): RaisedFloor[] {
  if (source.stable === null) return [];
  const zero = requireVersion(source.stable).major === 0;
  if (zero && level !== "patch") return [];
  const coordinate = `release those dependents with it and plan with --coordinated ${source.manifest.name}`;
  const advice = zero ? `release it as a minor, or ${coordinate}` : coordinate;
  return raisedRequirements(source).map((raise) => {
    const line = raiseLine(raise, level);
    return { line, refusal: `${line}, which breaks the dependents that lock ${raise.requirement.name}: ${advice}` };
  });
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { commitLevel, computePlan, type Commit, type Entry, type Manifest, type PackageSource, type Reverted } from "../plan.ts";

export function commit(subject: string, body = "", reverts: readonly Reverted[] = []): Commit {
  return { sha: createHash("sha1").update(subject).digest("hex"), subject, level: commitLevel(subject, body), reverts };
}

export function source(
  name: string,
  stable: string | null,
  subjects: string[],
  fields: Partial<Manifest> = {},
  stableFields: Partial<Manifest> = fields,
): PackageSource {
  const commits = subjects.map((subject) => commit(subject));
  return {
    slug: `AntelopeJS/${name}`,
    directory: ".",
    branch: "main",
    head: createHash("sha1").update(name).digest("hex"),
    tagName: "v${version}",
    manifest: { name: `@antelopejs/${name}`, version: stable ?? "0.1.0", ...fields },
    stable,
    stableManifest: stable === null ? null : { name: `@antelopejs/${name}`, version: stable, ...stableFields },
    stableSiblings: {},
    requirements: [],
    stableRequirements: [],
    commits,
    notes: commits,
  };
}

export function plan(sources: PackageSource[], exclude: string[] = [], contains = (_name: string, _sha: string) => true) {
  return computePlan(sources, { ref: "main", exclude, coordinated: [], contains });
}

export function at(name: string): string {
  return createHash("sha1").update(name).digest("hex").slice(0, 7);
}

export function entry(entries: Entry[], name: string): Entry {
  const found = entries.find((candidate) => candidate.source.manifest.name === `@antelopejs/${name}`);
  assert.ok(found, `no entry for ${name}`);
  return found;
}

export function names(entries: Entry[]): string[] {
  return entries.map((candidate) => candidate.source.manifest.name.replace("@antelopejs/", ""));
}

export const interfaceDatabase = source("interface-database", "0.4.2", ["feat(query)!: drop the legacy cursor"], {
  devDependencies: { "@antelopejs/mongodb": "~1.8.6" },
});
export const mongodb = source("mongodb", "1.8.6", ["fix(database): close the change feed"], {
  dependencies: { "@antelopejs/interface-database": "0.5.0-next.12.g3f9a2c1" },
});
export const dmsDatabase = source("dms-database", "0.5.3", ["fix(data): translate refusals"], {
  dependencies: { "@antelopejs/interface-database": ">=0.4.0 <0.5.0" },
  devDependencies: { "@antelopejs/mongodb": "1.8.7-next.40.gabc1234" },
});

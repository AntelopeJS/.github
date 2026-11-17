import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  commitLevel,
  computePlan,
  isRegistrySpec,
  renderPlan,
  revertedCommits,
  withoutReverts,
  type Commit,
  type Entry,
  type Manifest,
  type PackageSource,
  type Reverted,
} from "./plan.ts";
import { nonRegistrySpecs, registrySpecs } from "./registry-specs.ts";

function commit(subject: string, body = "", reverts: readonly Reverted[] = []): Commit {
  return { sha: createHash("sha1").update(subject).digest("hex"), subject, level: commitLevel(subject, body), reverts };
}

function source(
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
    baseManifests: stable === null ? [] : [{ name: `@antelopejs/${name}`, version: stable, ...stableFields }],
    stableSiblings: {},
    commits,
    notes: commits,
  };
}

function plan(sources: PackageSource[], exclude: string[] = [], contains = (_name: string, _sha: string) => true) {
  return computePlan(sources, { ref: "main", exclude, contains });
}

function at(name: string): string {
  return createHash("sha1").update(name).digest("hex").slice(0, 7);
}

function entry(entries: Entry[], name: string): Entry {
  const found = entries.find((candidate) => candidate.source.manifest.name === `@antelopejs/${name}`);
  assert.ok(found, `no entry for ${name}`);
  return found;
}

function names(entries: Entry[]): string[] {
  return entries.map((candidate) => candidate.source.manifest.name.replace("@antelopejs/", ""));
}

const interfaceDatabase = source("interface-database", "0.4.2", ["feat(query)!: drop the legacy cursor"], {
  devDependencies: { "@antelopejs/mongodb": "~1.8.6" },
});
const mongodb = source("mongodb", "1.8.6", ["fix(database): close the change feed"], {
  dependencies: { "@antelopejs/interface-database": "0.5.0-next.12.g3f9a2c1" },
});
const dmsDatabase = source("dms-database", "0.5.3", ["fix(data): translate refusals"], {
  dependencies: { "@antelopejs/interface-database": ">=0.4.0 <0.5.0" },
  devDependencies: { "@antelopejs/mongodb": "1.8.7-next.40.gabc1234" },
});

describe("commitLevel", () => {
  test("a breaking change is a minor, any other releasable type a patch", () => {
    assert.equal(commitLevel("feat(query)!: drop the cursor", ""), "minor");
    assert.equal(commitLevel("fix: x", "Details.\n\nBREAKING CHANGE: the cursor is gone"), "minor");
    assert.equal(commitLevel("refactor: x", "BREAKING-CHANGE: renamed"), "minor");
    for (const type of ["feat", "fix", "perf", "refactor", "types", "revert"]) {
      assert.equal(commitLevel(`${type}(scope): x`, ""), "patch", type);
    }
  });

  test("the pull request title check accepts a revert, which releases a patch", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/ci-node.yml", import.meta.url), "utf8");
    const pattern = /pattern='([^']+)'/.exec(workflow)?.[1];
    assert.ok(pattern, "ci-node.yml has a title pattern");
    assert.match("revert(builder): restore the sample rows", new RegExp(pattern));
    assert.equal(commitLevel("revert(builder): restore the sample rows", ""), "patch");
  });

  test("tooling types, unparsed subjects and merges release nothing", () => {
    for (const subject of ["build: x", "ci(release): x", "chore: x", "test: x", "docs: x", "style: x", "Update README", "Merge pull request #12 from a/b"]) {
      assert.equal(commitLevel(subject, ""), null, subject);
    }
  });
});

describe("withoutReverts", () => {
  const breaking = commit("refactor(builder)!: remove the sample rows (#1093)");
  const fix = commit("fix(builder): close the cursor (#1094)");
  const restore = commit("refactor(builder): restore the sample rows (#1098)", "", [{ sha: breaking.sha }]);
  const levelOf = (commits: Commit[]) => {
    const found = plan([{ ...source("builder", "0.5.2", []), commits: withoutReverts(commits), notes: withoutReverts(commits) }]).entries[0];
    return found?.status === "release" ? found.level : found?.status;
  };

  test("a commit and its revert in the same range count for nothing, so the level is the other commits'", () => {
    assert.deepEqual(withoutReverts([restore, fix, breaking]), [fix]);
    assert.equal(levelOf([restore, fix, breaking]), "patch");
    assert.equal(levelOf([restore, breaking]), "unchanged");
  });

  test("a revert that names two commits cancels both", () => {
    const other = commit("feat(builder)!: drop the cursor (#1095)");
    const both = commit("revert: restore the rows and the cursor (#1099)", "", [{ sha: breaking.sha }, { sha: other.sha }]);
    assert.deepEqual(withoutReverts([both, other, fix, breaking]), [fix]);
  });

  test("an abbreviated SHA names the commit it reverts", () => {
    const short = commit("revert: remove the sample rows", "", [{ sha: breaking.sha.slice(0, 9) }]);
    assert.deepEqual(withoutReverts([short, fix, breaking]), [fix]);
  });

  test("a pull request number names the squash commit whose subject ends with it", () => {
    const byPull = commit("refactor(builder): restore the sample rows (#1098)", "", [{ pull: 1093 }]);
    assert.deepEqual(withoutReverts([byPull, fix, breaking]), [fix]);
    assert.deepEqual(withoutReverts([commit("revert: x", "", [{ pull: 109 }]), breaking]).length, 2);
  });

  test("a revert of a commit older than the range counts as a change", () => {
    const older = commit("revert: drop the cursor", "", [{ sha: "0123456789abcdef0123456789abcdef01234567" }]);
    assert.deepEqual(withoutReverts([older]), [older]);
    assert.equal(levelOf([older]), "patch");
  });

  test("a revert of a revert cancels that revert and leaves the first commit", () => {
    const again = commit("refactor(builder)!: remove the sample rows again (#1100)", "", [{ sha: restore.sha }]);
    assert.deepEqual(withoutReverts([again, restore, fix, breaking]), [fix, breaking]);
    assert.equal(levelOf([again, restore, fix, breaking]), "minor");
  });

  test("reads the commits a message reverts from git's line and from a reference to a pull request of the same repository", () => {
    const body = "Restores it.\n\nThis reverts commit daa3203f4.\nReverts antelopejs/DMS#1093\nReverts AntelopeJS/other#7";
    assert.deepEqual(revertedCommits(body, "AntelopeJS/dms"), [{ sha: "daa3203f4" }, { pull: 1093 }]);
    assert.deepEqual(revertedCommits("Mentions This reverts commit daa3203f4 inline.", "AntelopeJS/dms"), []);
  });
});

describe("isRegistrySpec", () => {
  test("accepts a semver range or an npm alias to one, and nothing that resolves outside the registry", () => {
    for (const spec of registrySpecs) assert.equal(isRegistrySpec(spec), true, spec);
    for (const spec of nonRegistrySpecs) assert.equal(isRegistrySpec(spec), false, spec);
  });

  test("refuses a long run of comparators and spaces in linear time", { timeout: 2000 }, () => {
    assert.equal(isRegistrySpec(`${Array.from({ length: 40 }, () => "1").join("      ")}!`), false);
  });
});

describe("computePlan", () => {
  test("refuses a runtime dependency that does not resolve from the registry, and lets a devDependency one through", () => {
    const local = source("mongodb", "1.8.6", ["fix(database): use the local interface"], {
      dependencies: { "@antelopejs/interface-database": "file:../interface-database" },
      peerDependencies: { "@antelopejs/core": "catalog:" },
      optionalDependencies: { "@antelopejs/x": "github:AntelopeJS/x#next" },
      devDependencies: { "@antelopejs/tooling-configs": "link:../tooling-configs" },
    });
    assert.deepEqual(entry(plan([local]).entries, "mongodb"), {
      status: "refused",
      source: local,
      reasons: [
        "depends on @antelopejs/interface-database@file:../interface-database, which is not a registry version range",
        "depends on @antelopejs/core@catalog:, which is not a registry version range",
        "depends on @antelopejs/x@github:AntelopeJS/x#next, which is not a registry version range",
      ],
    });
  });

  test("lists a package after the workspace siblings it depends on, with the range pnpm packs each spec to", () => {
    const sibling = { ...source("interface-dms-saas", "0.10.0", ["feat!: rename the plans"]), slug: "AntelopeJS/dms-saas", directory: "packages/interface-dms-saas" };
    const quiet = { ...source("interface-dms-core", "0.3.1", []), slug: "AntelopeJS/dms-saas", directory: "packages/interface-dms-core" };
    const saas = {
      ...source("dms-saas", "0.12.1", ["fix: x"], {
        dependencies: { "@antelopejs/interface-dms-saas": "workspace:^", "@antelopejs/interface-dms-core": "workspace:~" },
        peerDependencies: { "@antelopejs/interface-dms-saas": "workspace:*" },
      }),
      slug: "AntelopeJS/dms-saas",
      directory: "packages/dms-saas",
    };
    const { entries } = plan([saas, sibling, quiet]);
    assert.deepEqual(names(entries), ["interface-dms-saas", "interface-dms-core", "dms-saas"]);
    assert.deepEqual(entry(entries, "dms-saas"), {
      status: "release",
      source: saas,
      from: "0.12.1",
      to: "0.12.2",
      level: "patch",
      reasons: [],
      ranges: {},
      kept: [],
      siblings: [
        { name: "@antelopejs/interface-dms-saas", spec: "workspace:^", range: "^0.11.0" },
        { name: "@antelopejs/interface-dms-core", spec: "workspace:~", range: "~0.3.1" },
        { name: "@antelopejs/interface-dms-saas", spec: "workspace:*", range: "0.11.0" },
      ],
    });
    assert.ok(
      renderPlan(plan([saas, sibling, quiet])).includes(
        [
          `2. @antelopejs/dms-saas 0.12.1 -> 0.12.2 (patch)  AntelopeJS/dms-saas:packages/dms-saas@${at("dms-saas")}`,
          "     fix: x",
          "     @antelopejs/interface-dms-saas workspace:^ -> ^0.11.0",
          "     @antelopejs/interface-dms-core workspace:~ -> ~0.3.1",
          "     @antelopejs/interface-dms-saas workspace:* -> 0.11.0",
        ].join("\n"),
      ),
    );
  });

  test("a tooling-only cycle plans a patch when a sibling's release moves the range a workspace spec packs to out of the published one", () => {
    const inRepo = (name: string, stable: string, subjects: string[], fields: Partial<Manifest> = {}) => ({
      ...source(name, stable, subjects, fields),
      slug: "AntelopeJS/dms-saas",
      directory: `packages/${name}`,
    });
    const dependent = (dependencies: Record<string, string>, packed = "0.10.0") => ({
      ...inRepo("dms-saas", "0.12.1", ["build: move to 0.8"], { dependencies, peerDependencies: dependencies }),
      stableSiblings: { "@antelopejs/interface-dms-saas": packed },
    });
    const minor = inRepo("interface-dms-saas", "0.10.0", ["feat!: rename the plans"]);
    const patch = inRepo("interface-dms-saas", "0.10.0", ["fix: x"]);
    const quiet = inRepo("interface-dms-saas", "0.10.0", ["build: move to 0.8"]);
    const reasons = (sibling: PackageSource, spec: string): string[] | string => {
      const found = entry(plan([dependent({ "@antelopejs/interface-dms-saas": spec }, sibling.stable ?? ""), sibling]).entries, "dms-saas");
      return found.status === "release" ? found.reasons : found.status;
    };
    assert.deepEqual(reasons(minor, "workspace:^"), [
      "moves dependencies @antelopejs/interface-dms-saas ^0.10.0 -> ^0.11.0",
      "moves peerDependencies @antelopejs/interface-dms-saas ^0.10.0 -> ^0.11.0",
    ]);
    assert.deepEqual(reasons(minor, "workspace:~"), [
      "moves dependencies @antelopejs/interface-dms-saas ~0.10.0 -> ~0.11.0",
      "moves peerDependencies @antelopejs/interface-dms-saas ~0.10.0 -> ~0.11.0",
    ]);
    assert.deepEqual(reasons(patch, "workspace:*"), [
      "moves dependencies @antelopejs/interface-dms-saas 0.10.0 -> 0.10.1",
      "moves peerDependencies @antelopejs/interface-dms-saas 0.10.0 -> 0.10.1",
    ]);
    assert.equal(reasons(patch, "workspace:^"), "unchanged");
    assert.equal(reasons(patch, "workspace:~"), "unchanged");
    assert.equal(reasons(quiet, "workspace:*"), "unchanged");
    assert.equal(reasons(inRepo("interface-dms-saas", "1.2.0", ["feat!: rename the plans"]), "workspace:^"), "unchanged");
    const changed = (stableDependencies: Record<string, string>): string[] | string => {
      const moved = {
        ...source("dms-saas", "0.12.1", ["build: move to 0.8"], { dependencies: { "@antelopejs/interface-dms-saas": "workspace:^" } }, { dependencies: stableDependencies }),
        slug: "AntelopeJS/dms-saas",
        directory: "packages/dms-saas",
        stableSiblings: { "@antelopejs/interface-dms-saas": "0.10.0" },
      };
      const found = entry(plan([moved, minor]).entries, "dms-saas");
      return found.status === "release" ? found.reasons : found.status;
    };
    assert.deepEqual(changed({}), ["adds dependencies @antelopejs/interface-dms-saas@workspace:^"]);
    assert.deepEqual(changed({ "@antelopejs/interface-dms-saas": "workspace:~" }), [
      "moves dependencies @antelopejs/interface-dms-saas workspace:~ -> workspace:^",
    ]);
    const inherited = { ...inRepo("prototype", "0.10.0", ["feat!: x"]), manifest: { name: "constructor", version: "0.10.0" } };
    const named = { ...inRepo("named", "0.12.1", ["build: x"], { dependencies: { constructor: "workspace:^" } }), stableSiblings: {} };
    const unread = plan([named, inherited]).entries.find((candidate) => candidate.source === named);
    assert.equal(unread?.status, "unchanged");
    const found = entry(plan([dependent({ "@antelopejs/interface-dms-saas": "workspace:^" }), minor]).entries, "dms-saas");
    assert.deepEqual(found.status === "release" && [found.to, found.level], ["0.12.2", "patch"]);
  });

  test("refuses a workspace spec on a sibling the plan cannot pack to a version npm holds", () => {
    const inRepo = (name: string, stable: string | null, subjects: string[], fields: Partial<Manifest> = {}) => ({
      ...source(name, stable, subjects, fields),
      slug: "AntelopeJS/dms-saas",
      directory: `packages/${name}`,
    });
    const unreleased = inRepo("fresh", null, []);
    const excluded = inRepo("left", "0.2.0", ["fix: y"]);
    const refused = inRepo("broken", "0.1.0", ["fix: z"], { dependencies: { "@antelopejs/a": "file:../a" } });
    const bumped = inRepo("bumped", "0.4.0", [], { version: "0.5.0" });
    const elsewhere = source("other", "1.0.0", []);
    const saas = inRepo("dms-saas", "0.12.1", ["fix: x"], {
      dependencies: {
        "@antelopejs/fresh": "workspace:^",
        "@antelopejs/left": "workspace:^",
        "@antelopejs/broken": "workspace:^",
        "@antelopejs/bumped": "workspace:^",
        "@antelopejs/other": "workspace:^",
        "@antelopejs/unlisted": "workspace:^",
        "@antelopejs/path": "workspace:../path",
        "@antelopejs/alias": "workspace:@antelopejs/other@*",
        "@antelopejs/range": "workspace:^0.10.0",
      },
    });
    const { entries } = plan([saas, unreleased, excluded, refused, bumped, elsewhere], ["@antelopejs/left"]);
    assert.deepEqual(entry(entries, "dms-saas"), {
      status: "refused",
      source: saas,
      reasons: [
        "depends on @antelopejs/fresh@workspace:^, which has no stable release",
        "depends on @antelopejs/broken@workspace:^, which is refused",
        "depends on @antelopejs/bumped@workspace:^, whose package.json holds 0.5.0, not its stable 0.4.0",
        "depends on @antelopejs/other@workspace:^, which this train lists from AntelopeJS/other",
        "depends on @antelopejs/unlisted@workspace:^, which this train does not list",
        "depends on @antelopejs/path@workspace:../path, which is not workspace:*, workspace:^ or workspace:~",
        "depends on @antelopejs/alias@workspace:@antelopejs/other@*, which is not workspace:*, workspace:^ or workspace:~",
        "depends on @antelopejs/range@workspace:^0.10.0, which is not workspace:*, workspace:^ or workspace:~",
      ],
    });
    const kept = entry(entries, "left");
    assert.equal(kept.status, "excluded");
  });

  test("refuses a runtime spec on a workspace sibling that is not workspace:, and names workspace:^", () => {
    const inRepo = (name: string, stable: string, subjects: string[], fields: Partial<Manifest> = {}) => ({
      ...source(name, stable, subjects, fields),
      slug: "AntelopeJS/dms-media",
      directory: `packages/${name}`,
    });
    const sibling = inRepo("interface-dms-media", "0.4.0", ["feat!: rename the folders"]);
    const elsewhere = source("interface-database", "0.5.0", []);
    const media = inRepo("dms-media", "0.9.0", ["fix: x"], {
      dependencies: { "@antelopejs/interface-dms-media": ">=0.4.0 <0.5.0", "@antelopejs/interface-database": ">=0.5.0 <0.6.0" },
      peerDependencies: { "@antelopejs/interface-dms-media": "0.4.1-next.2.gabc1234" },
      devDependencies: { "@antelopejs/interface-dms-media": "^0.4.0" },
    });
    const { entries } = plan([media, sibling, elsewhere]);
    assert.deepEqual(entry(entries, "dms-media"), {
      status: "refused",
      source: media,
      reasons: [
        "depends on @antelopejs/interface-dms-media@>=0.4.0 <0.5.0, a sibling of its workspace it must name as workspace:^",
        "depends on @antelopejs/interface-dms-media@0.4.1-next.2.gabc1234, a sibling of its workspace it must name as workspace:^",
      ],
    });
    assert.ok(
      renderPlan(plan([media, sibling, elsewhere])).includes(
        [
          `2. @antelopejs/dms-media refused  AntelopeJS/dms-media:packages/dms-media@${at("dms-media")}`,
          "     depends on @antelopejs/interface-dms-media@>=0.4.0 <0.5.0, a sibling of its workspace it must name as workspace:^",
        ].join("\n"),
      ),
    );
  });

  test("orders dependencies before their dependents whatever the input order", () => {
    const { entries } = plan([dmsDatabase, mongodb, interfaceDatabase]);
    assert.deepEqual(names(entries), ["interface-database", "mongodb", "dms-database"]);
  });

  test("bumps a breaking change to the next minor and anything else to the next patch", () => {
    const { entries } = plan([interfaceDatabase, mongodb, dmsDatabase]);
    assert.deepEqual(
      entries.map((candidate) =>
        candidate.status === "release" ? [candidate.from, candidate.to, candidate.level] : candidate.status,
      ),
      [
        ["0.4.2", "0.5.0", "minor"],
        ["1.8.6", "1.8.7", "patch"],
        ["0.5.3", "0.5.4", "patch"],
      ],
    );
  });

  test("never bumps the major, and a first release ships the manifest version", () => {
    const stable = source("core", "1.8.6", ["feat!: break everything"]);
    const fresh = source("fresh", null, ["feat: start"], { version: "0.2.0-next.1.gabc1234" });
    const versions = plan([stable, fresh]).entries.map((candidate) =>
      candidate.status === "release" ? [candidate.from, candidate.to] : candidate.status,
    );
    assert.deepEqual(versions, [
      ["1.8.6", "1.9.0"],
      [null, "0.2.0"],
    ]);
  });

  test("replaces a preview pin with the range of the version planned for its dependency", () => {
    const { entries } = plan([interfaceDatabase, mongodb, dmsDatabase]);
    const mongo = entry(entries, "mongodb");
    const dms = entry(entries, "dms-database");
    assert.equal(mongo.status === "release" && mongo.ranges["@antelopejs/interface-database"], ">=0.5.0 <0.6.0");
    assert.equal(dms.status === "release" && dms.ranges["@antelopejs/mongodb"], ">=1.8.7 <1.9.0");
  });

  test("a pin on an unchanged package moves to its stable release", () => {
    const x = source("x", "0.2.1", ["chore: tidy"]);
    const pinned = source("dms", "0.20.2", [], { dependencies: { "@antelopejs/x": "0.2.1-next.3.gabc1234" } });
    assert.deepEqual(entry(plan([pinned, x]).entries, "dms"), {
      status: "release",
      source: pinned,
      from: "0.20.2",
      to: "0.20.3",
      level: "patch",
      reasons: ["replaces preview pins"],
      ranges: { "@antelopejs/x": ">=0.2.1 <0.3.0" },
      kept: [],
      siblings: [],
    });
  });

  test("a devDependency pin on an unchanged package is rewritten without a release, and a runtime pin beside it still releases", () => {
    const x = source("x", "0.2.1", ["chore: tidy"]);
    const tooling = source("dms-api", "0.20.2", ["chore: tidy"], { devDependencies: { "@antelopejs/x": "0.2.1-next.3.gabc1234" } });
    const result = plan([tooling, x]);
    assert.deepEqual(entry(result.entries, "dms-api"), {
      status: "repin",
      source: tooling,
      ranges: { "@antelopejs/x": ">=0.2.1 <0.3.0" },
    });
    assert.equal(
      renderPlan(result),
      [
        "Release plan from main, 1 package: 1 to repin",
        "",
        `1. @antelopejs/dms-api repins devDependencies, publishes nothing  AntelopeJS/dms-api@${at("dms-api")}`,
        "     @antelopejs/x 0.2.1-next.3.gabc1234 -> >=0.2.1 <0.3.0",
        "Unchanged: @antelopejs/x, only chore commits since 0.2.1",
        "",
      ].join("\n"),
    );
    const runtime = source("dms", "0.20.2", [], {
      dependencies: { "@antelopejs/x": "0.2.1-next.3.gabc1234" },
      devDependencies: { "@antelopejs/y": "0.4.0-next.1.gabc1234" },
    });
    const both = entry(plan([runtime, x, source("y", "0.4.0", [])]).entries, "dms");
    assert.deepEqual(both.status === "release" && [both.to, both.reasons, both.ranges], [
      "0.20.3",
      ["replaces preview pins"],
      { "@antelopejs/x": ">=0.2.1 <0.3.0", "@antelopejs/y": ">=0.4.0 <0.5.0" },
    ]);
  });

  test("a runtime range change on the name of a devDependency pin still releases", () => {
    const core = source("core", "1.1.0", []);
    const accepting = source(
      "dms-api",
      "0.20.2",
      ["chore(deps): accept core 1.1"],
      { peerDependencies: { "@antelopejs/core": ">=1.1.0 <1.2.0" }, devDependencies: { "@antelopejs/core": "1.1.0-next.4.gabc1234" } },
      { peerDependencies: { "@antelopejs/core": ">=1.0.0 <1.1.0" } },
    );
    const found = entry(plan([accepting, core]).entries, "dms-api");
    assert.deepEqual(found.status === "release" && [found.to, found.reasons], [
      "0.20.3",
      ["moves peerDependencies @antelopejs/core >=1.0.0 <1.1.0 -> >=1.1.0 <1.2.0"],
    ]);
  });

  test("refuses a package whose preview dependency is left out, unlisted or has no stable release", () => {
    const excluded = plan([interfaceDatabase, mongodb], ["@antelopejs/interface-database"]).entries;
    assert.equal(entry(excluded, "interface-database").status, "excluded");
    assert.deepEqual(entry(excluded, "mongodb"), {
      status: "refused",
      source: mongodb,
      reasons: ["depends on preview @antelopejs/interface-database@0.5.0-next.12.g3f9a2c1, which is not in this release"],
    });

    const x = source("x", null, []);
    const pinned = source("dms", "0.20.2", ["fix: x"], {
      peerDependencies: { "@antelopejs/x": "0.2.0-next.3.gabc1234", "@antelopejs/y": "0.1.0-next.1.gabc1234" },
    });
    assert.deepEqual(entry(plan([pinned, x]).entries, "dms"), {
      status: "refused",
      source: pinned,
      reasons: [
        "depends on preview @antelopejs/x@0.2.0-next.3.gabc1234, which has no stable release",
        "depends on preview @antelopejs/y@0.1.0-next.1.gabc1234, which this train does not list",
      ],
    });
  });

  test("refuses a pin whose stable is older than the preview, that is not exact or that names no commit", () => {
    const pinned = source("dms", "0.20.2", ["fix: x"], {
      dependencies: { "@antelopejs/x": "0.3.0-next.1.gabc1234", "@antelopejs/z": "0.2.9-beta.1" },
      optionalDependencies: { "@antelopejs/y": "^0.1.0-next.2" },
    });
    const listed = [source("x", "0.2.9", []), source("y", "0.1.0", []), source("z", "0.2.9", [])];
    const refused = entry(plan([pinned, ...listed]).entries, "dms");
    assert.deepEqual(refused.status === "refused" && refused.reasons, [
      "depends on preview @antelopejs/x@0.3.0-next.1.gabc1234, whose stable 0.2.9 is older than 0.3.0",
      "depends on preview @antelopejs/z@0.2.9-beta.1, which names no commit",
      "depends on preview @antelopejs/y@^0.1.0-next.2, which is not an exact version",
    ]);
  });

  test("moves a pin only to a stable release whose branch contains the preview's commit", () => {
    const found = new Set(["@antelopejs/interface-database 3f9a2c1"]);
    const contains = (name: string, sha: string) => found.has(`${name} ${sha}`);
    const missing = source("dms-database", "0.5.3", ["fix: x"], {
      dependencies: { "@antelopejs/mongodb": "1.8.7-next.40.gabc1234" },
    });
    const { entries } = plan([interfaceDatabase, mongodb, missing], [], contains);
    const mongo = entry(entries, "mongodb");
    assert.equal(mongo.status === "release" && mongo.ranges["@antelopejs/interface-database"], ">=0.5.0 <0.6.0");
    assert.deepEqual(entry(entries, "dms-database"), {
      status: "refused",
      source: missing,
      reasons: ["depends on preview @antelopejs/mongodb@1.8.7-next.40.gabc1234, whose main does not contain commit abc1234"],
    });
  });

  test("a refusal cascades to every package pinning a preview of the refused one at runtime", () => {
    const app = source("app", "2.0.0", ["fix: x"], { peerDependencies: { "@antelopejs/mongodb": "1.8.7-next.41.gabc1234" } });
    const { entries } = plan([interfaceDatabase, mongodb, dmsDatabase, app], ["@antelopejs/interface-database"]);
    assert.deepEqual(
      entries.map((candidate) => candidate.status),
      ["excluded", "refused", "release", "refused"],
    );
    const dms = entry(entries, "dms-database");
    assert.deepEqual(dms.status === "release" && dms.kept, [
      { name: "@antelopejs/mongodb", spec: "1.8.7-next.40.gabc1234", reason: "which is refused" },
    ]);
    const refused = entry(entries, "app");
    assert.deepEqual(refused.status === "refused" && refused.reasons, [
      "depends on preview @antelopejs/mongodb@1.8.7-next.41.gabc1234, which is refused",
    ]);
  });

  test("a stable dev dependency back on a dependent is no cycle", () => {
    const { entries } = plan([interfaceDatabase, mongodb]);
    assert.deepEqual(names(entries), ["interface-database", "mongodb"]);
    assert.ok(entries.every((candidate) => candidate.status === "release"));
  });

  test("refuses every package of a cycle on runtime dependencies and names it", () => {
    const a = source("a", "0.1.0", ["fix: x"], { dependencies: { "@antelopejs/b": ">=0.1.0 <0.2.0" } });
    const b = source("b", "0.1.0", ["fix: x"], { peerDependencies: { "@antelopejs/a": ">=0.1.0 <0.2.0" } });
    const c = source("c", "0.1.0", ["fix: x"], { dependencies: { "@antelopejs/a": ">=0.1.0 <0.2.0" } });
    const { entries } = plan([c, a, b]);
    const reason = "is in a dependency cycle between @antelopejs/a, @antelopejs/b";
    assert.deepEqual(entry(entries, "a"), { status: "refused", source: a, reasons: [reason] });
    assert.deepEqual(entry(entries, "b"), { status: "refused", source: b, reasons: [reason] });
    assert.equal(entry(entries, "c").status, "release");
  });

  test("a devDependency preview on a package that releases after it is kept and blocks nothing", () => {
    const a = source("a", "0.1.0", ["fix: x"], { dependencies: { "@antelopejs/b": ">=0.1.0 <0.2.0" } });
    const b = source("b", "0.1.0", ["fix: y"], {
      devDependencies: { "@antelopejs/a": "0.1.1-next.1.gabc1234", "@antelopejs/z": "0.3.0-next.2.gabc1234" },
    });
    const result = plan([a, b]);
    assert.deepEqual(names(result.entries), ["b", "a"]);
    assert.deepEqual(entry(result.entries, "b"), {
      status: "release",
      source: b,
      from: "0.1.0",
      to: "0.1.1",
      level: "patch",
      reasons: [],
      ranges: {},
      kept: [
        { name: "@antelopejs/a", spec: "0.1.1-next.1.gabc1234", reason: "which releases after it" },
        { name: "@antelopejs/z", spec: "0.3.0-next.2.gabc1234", reason: "which this train does not list" },
      ],
      siblings: [],
    });
    assert.equal(entry(result.entries, "a").status, "release");
    assert.equal(
      renderPlan(result),
      [
        "Release plan from main, 2 packages: 2 to release",
        "",
        `1. @antelopejs/b 0.1.0 -> 0.1.1 (patch)  AntelopeJS/b@${at("b")}`,
        "     fix: y",
        "     keeps devDependency @antelopejs/a@0.1.1-next.1.gabc1234, which releases after it",
        "     keeps devDependency @antelopejs/z@0.3.0-next.2.gabc1234, which this train does not list",
        `2. @antelopejs/a 0.1.0 -> 0.1.1 (patch)  AntelopeJS/a@${at("a")}`,
        "     fix: x",
        "",
      ].join("\n"),
    );
  });

  test("an excluded package is in no cycle, and its dependents read it as not in this release", () => {
    const a = source("a", "0.1.0", ["fix: x"], { dependencies: { "@antelopejs/b": ">=0.1.0 <0.2.0" } });
    const b = source("b", "0.1.0", ["fix: x"], { dependencies: { "@antelopejs/a": "0.1.1-next.1.gabc1234" } });
    const c = source("c", "0.1.0", ["fix: x"], { dependencies: { "@antelopejs/b": ">=0.1.0 <0.2.0" } });
    const { entries } = plan([a, b, c], ["@antelopejs/a"]);
    assert.deepEqual(entry(entries, "a"), { status: "excluded", source: a });
    assert.deepEqual(entry(entries, "b"), {
      status: "refused",
      source: b,
      reasons: ["depends on preview @antelopejs/a@0.1.1-next.1.gabc1234, which is not in this release"],
    });
    assert.equal(entry(entries, "c").status, "release");
  });

  test("the level reads the cycle's commits as well as the branch's, so a promotion titled too low still releases a minor", () => {
    const promoted = {
      ...source("promoted", "0.3.1", ["fix: promote next (#16)"]),
      notes: [commit("feat(api)!: rename read to fetch (#15)"), commit("chore: tidy (#14)")],
    };
    const quiet = { ...source("quiet", "0.2.0", ["fix: promote next (#3)"]), notes: [commit("chore: tidy (#2)")] };
    const result = plan([promoted, quiet]);
    assert.deepEqual(
      result.entries.map((candidate) => (candidate.status === "release" ? [candidate.to, candidate.level] : candidate.status)),
      [
        ["0.4.0", "minor"],
        ["0.2.1", "patch"],
      ],
    );
    assert.equal(
      renderPlan(result),
      [
        "Release plan from main, 2 packages: 2 to release",
        "",
        `1. @antelopejs/promoted 0.3.1 -> 0.4.0 (minor)  AntelopeJS/promoted@${at("promoted")}`,
        "     feat(api)!: rename read to fetch (#15)",
        `2. @antelopejs/quiet 0.2.0 -> 0.2.1 (patch)  AntelopeJS/quiet@${at("quiet")}`,
        "",
      ].join("\n"),
    );
  });

  test("a package with no releasable commit and no preview pin is unchanged, with the types of its commits", () => {
    const quiet = source("quiet", "0.3.0", ["chore: tidy", "ci: cache", "test: cover"]);
    assert.deepEqual(plan([quiet]).entries, [{ status: "unchanged", source: quiet, reason: "only chore, ci and test commits since 0.3.0" }]);
    const silent = source("silent", "0.3.0", []);
    assert.deepEqual(plan([silent]).entries, [{ status: "unchanged", source: silent, reason: null }]);
  });

  test("a cycle of tooling commits only plans no release, even for a commit that moves a devDependency", () => {
    const pack = { devDependencies: { "@antelopejs/tooling-configs": "^0.8.0" } };
    const before = { devDependencies: { "@antelopejs/tooling-configs": "^0.7.0" } };
    const moved = source("interface-database", "0.4.2", ["build: move to the next model with @antelopejs/tooling-configs 0.8 (#101)"], pack, before);
    const mixed = source("dms-database", "0.5.3", ["test(e2e): run the journeys (#198)", "build: move to 0.8 (#197)", "ci: drop the nightly (#194)", "docs: x", "style: x", "chore: x"]);
    assert.deepEqual(
      plan([moved, mixed]).entries.map((found) => (found.status === "unchanged" ? found.reason : found.status)),
      ["only build commits since 0.4.2", "only build, chore, ci, docs, style and test commits since 0.5.3"],
    );
  });

  test("a tooling commit that changes a published runtime dependency field plans a patch that names the change", () => {
    const cases: [string, Partial<Manifest>, Partial<Manifest>, string][] = [
      ["moved", { dependencies: { mongodb: "^6.21.0" } }, { dependencies: { mongodb: "^7.0.0" } }, "moves dependencies mongodb ^6.21.0 -> ^7.0.0"],
      ["added", {}, { peerDependencies: { "@antelopejs/interface-core": ">=0.6.0 <0.7.0" } }, "adds peerDependencies @antelopejs/interface-core@>=0.6.0 <0.7.0"],
      ["removed", { optionalDependencies: { "@antelopejs/interface-mongodb": ">=0.0.7 <0.1.0" } }, {}, "removes optionalDependencies @antelopejs/interface-mongodb@>=0.0.7 <0.1.0"],
    ];
    for (const [name, before, after, reason] of cases) {
      const found = entry(plan([source(name, "1.8.6", ["chore(deps): update"], after, before)]).entries, name);
      assert.equal(found.status, "release", name);
      assert.deepEqual(found.status === "release" && [found.to, found.level, found.reasons], ["1.8.7", "patch", [reason]], name);
    }
  });

  test("a tooling-only dependency releases a patch when a dependent pins its newer preview at runtime, and only then", () => {
    const dependency = source("interface-database", "0.4.2", ["build: move to 0.8"]);
    const pin = { "@antelopejs/interface-database": "0.4.3-next.2.g3f9a2c1" };
    const runtime = source("mongodb", "1.8.6", ["fix: x"], { dependencies: pin, peerDependencies: pin });
    const { entries } = plan([dependency, runtime]);
    const released = entry(entries, "interface-database");
    assert.deepEqual(released.status === "release" && [released.to, released.reasons], ["0.4.3", ["@antelopejs/mongodb pins the preview 0.4.3-next.2.g3f9a2c1"]]);
    const dependent = entry(entries, "mongodb");
    assert.deepEqual(dependent.status === "release" && dependent.ranges, { "@antelopejs/interface-database": ">=0.4.3 <0.5.0" });
    assert.equal(entry(plan([dependency, runtime], [], () => false).entries, "interface-database").status, "unchanged");

    const tooling = source("dms-database", "0.5.3", ["fix: y"], { devDependencies: { "@antelopejs/interface-database": "0.4.3-next.2.g3f9a2c1" } });
    assert.equal(entry(plan([dependency, tooling]).entries, "interface-database").status, "unchanged");
    const older = source("dms-database", "0.5.3", ["fix: y"], { dependencies: { "@antelopejs/interface-database": "0.4.2-next.9.g3f9a2c1" } });
    assert.equal(entry(plan([dependency, older]).entries, "interface-database").status, "unchanged");
  });

  test("a tooling-only cycle that replaces a preview pin names the pin, not a dependency move", () => {
    const pinned = source("mongodb", "1.8.6", ["chore: pin the interface"], { dependencies: { "@antelopejs/interface-database": "0.4.2-next.1.g3f9a2c1" } }, { dependencies: { "@antelopejs/interface-database": ">=0.4.1 <0.5.0" } });
    const found = entry(plan([source("interface-database", "0.4.2", []), pinned]).entries, "mongodb");
    assert.deepEqual(found.status === "release" && found.reasons, ["replaces preview pins"]);
  });

  test("the reason of an unchanged package reads the cycle's notes, and names no version without a stable release", () => {
    const promoted = { ...source("promoted", "0.3.1", ["chore: promote next (#20)"]), notes: [commit("build: move to 0.8"), commit("test: cover")] };
    const fresh = source("fresh", null, ["build: scaffold", "docs: describe"]);
    assert.deepEqual(
      plan([promoted, fresh]).entries.map((found) => found.status === "unchanged" && found.reason),
      ["only build, chore and test commits since 0.3.1", "only build and docs commits"],
    );
  });

  test("a cycle with a feat, fix, perf or refactor commit beside tooling commits releases as before", () => {
    for (const type of ["feat", "fix", "perf", "refactor"]) {
      const found = entry(plan([source("mongodb", "1.8.6", ["build: move to 0.8", `${type}: x`])]).entries, "mongodb");
      assert.deepEqual(found.status === "release" && [found.to, found.level, found.reasons], ["1.8.7", "patch", []], type);
    }
  });
});

describe("renderPlan", () => {
  test("lists each release and refusal in order, then the unchanged and the left out", () => {
    const dms = source("dms-database", "0.5.3", ["fix: x"], {
      dependencies: { "@antelopejs/x": "0.2.0-next.3.gabc1234" },
    });
    const nested = { ...source("dms-automation", "0.11.1", ["perf: faster"]), slug: "AntelopeJS/dms", directory: "packages/automation" };
    const text = renderPlan(
      plan(
        [
          interfaceDatabase,
          { ...mongodb, notes: [commit("fix(database): close the change feed"), commit("chore: tidy")] },
          dms,
          nested,
          source("foo", "1.0.0", ["test: x"]),
          source("bar", "1.0.0", ["fix: y"]),
        ],
        ["@antelopejs/bar"],
      ),
    );
    assert.equal(
      text,
      [
        "Release plan from main, 4 packages: 3 to release, 1 refused",
        "",
        `1. @antelopejs/interface-database 0.4.2 -> 0.5.0 (minor)  AntelopeJS/interface-database@${at("interface-database")}`,
        "     feat(query)!: drop the legacy cursor",
        `2. @antelopejs/mongodb 1.8.6 -> 1.8.7 (patch)  AntelopeJS/mongodb@${at("mongodb")}`,
        "     fix(database): close the change feed",
        "     @antelopejs/interface-database 0.5.0-next.12.g3f9a2c1 -> >=0.5.0 <0.6.0",
        `3. @antelopejs/dms-database refused  AntelopeJS/dms-database@${at("dms-database")}`,
        "     depends on preview @antelopejs/x@0.2.0-next.3.gabc1234, which this train does not list",
        `4. @antelopejs/dms-automation 0.11.1 -> 0.11.2 (patch)  AntelopeJS/dms:packages/automation@${at("dms-automation")}`,
        "     perf: faster",
        "Unchanged: @antelopejs/foo, only test commits since 1.0.0",
        "Not now: @antelopejs/bar",
        "",
      ].join("\n"),
    );
  });

  test("says so when nothing is to release", () => {
    assert.equal(
      renderPlan(plan([source("foo", "1.0.0", [])])),
      "Release plan from main, nothing to release\n\nUnchanged: @antelopejs/foo\n",
    );
  });
});

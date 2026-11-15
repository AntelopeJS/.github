import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import {
  commitLevel,
  computePlan,
  isRegistrySpec,
  renderPlan,
  type Commit,
  type Entry,
  type Manifest,
  type PackageSource,
} from "./plan.ts";
import { nonRegistrySpecs, registrySpecs } from "./registry-specs.ts";

function commit(subject: string, body = "", author = "Antony Rizzitelli"): Commit {
  return { sha: subject.length.toString(16).padStart(40, "0"), subject, author, level: commitLevel(subject, body) };
}

function source(
  name: string,
  stable: string | null,
  subjects: string[],
  fields: Partial<Manifest> = {},
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
    for (const type of ["feat", "fix", "perf", "refactor", "docs", "build", "types", "revert"]) {
      assert.equal(commitLevel(`${type}(scope): x`, ""), "patch", type);
    }
  });

  test("chores, unparsed subjects and merges release nothing", () => {
    for (const subject of ["chore: x", "ci(release): x", "test: x", "style: x", "Update README", "Merge pull request #12 from a/b"]) {
      assert.equal(commitLevel(subject, ""), null, subject);
    }
  });
});

describe("isRegistrySpec", () => {
  test("accepts a semver range or an npm alias to one, and nothing that resolves outside the registry", () => {
    for (const spec of registrySpecs) assert.equal(isRegistrySpec(spec), true, spec);
    for (const spec of nonRegistrySpecs) assert.equal(isRegistrySpec(spec), false, spec);
  });
});

describe("computePlan", () => {
  test("refuses a runtime dependency that does not resolve from the registry, and lets a devDependency one through", () => {
    const local = source("mongodb", "1.8.6", ["fix(database): use the local interface"], {
      dependencies: { "@antelopejs/interface-database": "file:../interface-database" },
      peerDependencies: { "@antelopejs/core": "workspace:*" },
      optionalDependencies: { "@antelopejs/x": "github:AntelopeJS/x#next" },
      devDependencies: { "@antelopejs/tooling-configs": "link:../tooling-configs" },
    });
    assert.deepEqual(entry(plan([local]).entries, "mongodb"), {
      status: "refused",
      source: local,
      reasons: [
        "depends on @antelopejs/interface-database@file:../interface-database, which is not a registry version range",
        "depends on @antelopejs/core@workspace:*, which is not a registry version range",
        "depends on @antelopejs/x@github:AntelopeJS/x#next, which is not a registry version range",
      ],
    });
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
    });
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

  test("a package with no releasable commit and no preview pin is unchanged", () => {
    const quiet = source("quiet", "0.3.0", ["chore: tidy", "ci: cache", "test: cover"]);
    assert.deepEqual(plan([quiet]).entries, [{ status: "unchanged", source: quiet }]);
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
        "Unchanged: @antelopejs/foo",
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

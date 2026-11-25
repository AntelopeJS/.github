import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderPlan } from "./plan.ts";
import { at, dmsDatabase, entry, interfaceDatabase, mongodb, names, plan, source } from "./helpers/plan-sources.ts";

function registerPinTests(): void {
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

  test("refuses a pin whose base is above its dependency's stable or planned release, that is not exact or whose last part names no commit", () => {
    const pinned = source("dms", "0.20.2", ["fix: x"], {
      dependencies: {
        "@antelopejs/x": "0.3.0-next.1.gabc1234",
        "@antelopejs/z": "0.2.9-beta.1",
        "@antelopejs/w": "0.3.0-next.4.gabc1234",
        "@antelopejs/v": "0.2.10-next.g3f9a2c1.4",
      },
      optionalDependencies: { "@antelopejs/y": "^0.1.0-next.2" },
    });
    const listed = [source("x", "0.2.9", []), source("y", "0.1.0", []), source("z", "0.2.9", []), source("w", "0.2.9", ["fix: w"]), source("v", "0.2.9", ["fix: v"])];
    const refused = entry(plan([pinned, ...listed], [], (name) => name !== "@antelopejs/x").entries, "dms");
    assert.deepEqual(refused.status === "refused" && refused.reasons, [
      "depends on preview @antelopejs/x@0.3.0-next.1.gabc1234, whose stable 0.2.9 is older than 0.3.0",
      "depends on preview @antelopejs/z@0.2.9-beta.1, which names no commit",
      "depends on preview @antelopejs/w@0.3.0-next.4.gabc1234, whose stable 0.2.10 is older than 0.3.0",
      "depends on preview @antelopejs/v@0.2.10-next.g3f9a2c1.4, which names no commit",
      "depends on preview @antelopejs/y@^0.1.0-next.2, which is not an exact version",
    ]);
  });
}

function registerPinReleaseTests(): void {
  test("moves a pin of the preview cut from a release commit to that stable release, whose tag holds the commit", () => {
    const dependent = source("e", "0.1.0", ["fix: e"], { dependencies: { "@antelopejs/p": "1.2.5-next.40.g20d3668" } });
    const released = source("p", "1.2.4", []);
    const holds = (holder: string) => (name: string, sha: string, where?: string) => name === "@antelopejs/p" && sha === "20d3668" && where === holder;
    const moved = entry(plan([dependent, released], [], holds("stable")).entries, "e");
    assert.equal(moved.status === "release" && moved.ranges["@antelopejs/p"], ">=1.2.4 <1.3.0");
    const refused = entry(plan([dependent, released], [], holds("head")).entries, "e");
    assert.deepEqual(refused.status === "refused" && refused.reasons, ["depends on preview @antelopejs/p@1.2.5-next.40.g20d3668, whose stable 1.2.4 is older than 1.2.5"]);
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
}

describe("computePlan", () => {
  registerPinTests();
  registerPinReleaseTests();
});

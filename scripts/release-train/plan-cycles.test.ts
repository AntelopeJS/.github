import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { renderPlan, type Manifest } from "./plan.ts";
import { at, commit, entry, plan, source } from "./helpers/plan-sources.ts";

function registerToolingCycleTests(): void {
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

  test("the level reads the cycle's commits as well as the branch's, so a squash commit titled too low still releases a minor", () => {
    const promoted = {
      ...source("promoted", "0.3.1", ["fix: tidy the api (#16)"]),
      notes: [commit("feat(api)!: rename read to fetch (#15)"), commit("chore: tidy (#14)")],
    };
    const quiet = { ...source("quiet", "0.2.0", ["fix: tidy the scripts (#3)"]), notes: [commit("chore: tidy (#2)")] };
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
    const promoted = { ...source("promoted", "0.3.1", ["chore: tidy the build (#20)"]), notes: [commit("build: move to 0.8"), commit("test: cover")] };
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
}

describe("computePlan", () => {
  registerToolingCycleTests();
});

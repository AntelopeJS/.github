import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { commit, fakeSystem, git, manifest, repository, short, tip } from "./fixtures.ts";
import { main } from "./train.ts";
import { entry, plan, source } from "./helpers/plan-sources.ts";
import type { Requirement } from "./floors.ts";
import type { PackageSource } from "./plan.ts";

const frontend = (engines: string) => ({
  name: "@antelopejs/dms-frontend-vue",
  version: "0.24.1",
  private: true,
  engines: { node: ">=24", "@antelopejs/dms": "*", "@antelopejs/dms-frontend": engines },
});

const subject = "fix(deps): require dms-frontend 0.11.11, which builds the bundles one after another (#1271)";

const dms = repository("dms-floors", (path) => {
  commit(path, "feat: first", {
    "package.json": { name: "dms-floors", private: true },
    "packages/dms/package.json": manifest("dms", "0.24.1"),
    "packages/dms/.release-it.json": {},
    "packages/dms/frontend-vue/package.json": frontend(">=0.11.8 <0.12.0"),
  });
  git(path, "tag", "v0.24.1");
  commit(path, subject, {
    "packages/dms/frontend-vue/package.json": frontend(">=0.11.11 <0.12.0"),
  });
});

const raise =
  "raises the engines floor on @antelopejs/dms-frontend in frontend-vue/package.json from 0.11.8 to 0.11.11 (>=0.11.8 <0.12.0 -> >=0.11.11 <0.12.0) in a patch";

describe("plan", () => {
  test("refuses a patch that raises the floor a nested package.json declares on another @antelopejs package", () => {
    const { system, output, errors } = fakeSystem();
    assert.equal(main(["plan", `${dms}:packages/dms`], system), 0, errors());
    assert.equal(
      output(),
      [
        "Release plan from main, 1 package: 1 refused",
        "",
        `1. @antelopejs/dms refused  AntelopeJS/dms-floors:packages/dms@${short(tip(dms))}`,
        `     ${raise}, which breaks the dependents that lock @antelopejs/dms-frontend: release it as a minor, or release those dependents with it and plan with --coordinated @antelopejs/dms`,
        "",
      ].join("\n"),
    );
  });

  test("releases the patch that raises a floor when the plan coordinates it, and shows the raise", () => {
    const { system, output, errors } = fakeSystem();
    assert.equal(main(["plan", "--coordinated", "@antelopejs/dms", `${dms}:packages/dms`], system), 0, errors());
    assert.equal(
      output(),
      [
        "Release plan from main, 1 package: 1 to release",
        "",
        `1. @antelopejs/dms 0.24.1 -> 0.24.2 (patch)  AntelopeJS/dms-floors:packages/dms@${short(tip(dms))}`,
        `     ${subject}`,
        `     ${raise}`,
        "",
      ].join("\n"),
    );
  });

  test("refuses a --coordinated name that names no listed package", () => {
    const { system, errors } = fakeSystem();
    assert.equal(main(["plan", "--coordinated", "@antelopejs/nope", `${dms}:packages/dms`], system), 1);
    assert.equal(errors(), "--coordinated @antelopejs/nope names no listed package.\n");
  });
});

function peer(spec: string, name = "@antelopejs/interface-core"): Requirement {
  return { file: "package.json", field: "peerDependencies", name, spec };
}

function raising(stable: string, subject: string, before: Requirement[], after: Requirement[]): PackageSource {
  return { ...source("api", stable, [subject]), requirements: after, stableRequirements: before };
}

describe("computePlan", () => {
  test("releases a 0.x minor that raises a floor with no line about it", () => {
    const api = raising("0.4.2", "feat!: drop the v1 routes", [peer("^0.3.0")], [peer("^0.3.4")]);
    const planned = entry(plan([api]).entries, "api");
    assert.equal(planned.status, "release");
    assert.deepEqual(planned.status === "release" ? [planned.to, planned.reasons] : [], ["0.5.0", []]);
  });

  test("refuses a 1.x minor that raises a peerDependencies floor, which only a coordinated release ships", () => {
    const api = raising("1.4.2", "feat!: drop the v1 routes", [peer("^1.2.0")], [peer("^1.3.0")]);
    assert.deepEqual(entry(plan([api]).entries, "api"), {
      status: "refused",
      source: api,
      reasons: [
        "raises the peerDependencies floor on @antelopejs/interface-core in package.json from 1.2.0 to 1.3.0 (^1.2.0 -> ^1.3.0) in a minor, which breaks the dependents that lock @antelopejs/interface-core: release those dependents with it and plan with --coordinated @antelopejs/api",
      ],
    });
  });

  test("refuses a patch that adds a floor", () => {
    const api = raising("0.4.2", "fix: read the core", [], [peer(">=0.11.11 <0.12.0")]);
    const planned = entry(plan([api]).entries, "api");
    assert.deepEqual(planned.status === "refused" ? planned.reasons : [], [
      "adds a peerDependencies floor on @antelopejs/interface-core in package.json at 0.11.11 (>=0.11.11 <0.12.0) in a patch, which breaks the dependents that lock @antelopejs/interface-core: release it as a minor, or release those dependents with it and plan with --coordinated @antelopejs/api",
    ]);
  });

  test("releases a patch whose floors stay or go down as it would with none", () => {
    const preview = "@antelopejs/interface-next";
    const kept = raising(
      "0.4.2",
      "fix: read the core",
      [peer("^0.3.4"), peer("0.5.0-next.1.gabc1234", preview)],
      [peer(">=0.3.4 <0.4.0"), peer("0.5.0-next.9.gdef5678", preview)],
    );
    const lowered = { ...raising("0.4.2", "fix: read the core", [peer("^0.3.4")], [peer("^0.3.0")]), manifest: { name: "@antelopejs/lowered", version: "0.4.2" } };
    const entries = plan([kept, lowered]).entries;
    assert.deepEqual(
      entries.map((planned) => (planned.status === "release" ? [planned.to, planned.reasons] : planned.status)),
      [["0.4.3", []], ["0.4.3", []]],
    );
  });
});

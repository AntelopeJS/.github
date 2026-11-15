import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { commit, commits, dispatches, dms, dmsDatabase, expectedPlan, fakeSystem, git, interfaceDatabase, manifest, mongodb, repository, short } from "./fixtures.ts";
import { main } from "./train.ts";

describe("plan", () => {
  test("reads each checkout at its default branch and prints the plan", () => {
    const { system, calls, output } = fakeSystem();
    const status = main(["plan", dmsDatabase, mongodb, interfaceDatabase, `${dms}:packages/automation`], system);
    assert.equal(status, 0);
    assert.equal(output(), expectedPlan());
    assert.deepEqual(dispatches(calls), []);
  });

  test("an excluded package refuses the packages that pin its preview", () => {
    const { system, output } = fakeSystem();
    const status = main(["plan", "--exclude", "@antelopejs/mongodb", interfaceDatabase, mongodb, dmsDatabase], system);
    assert.equal(status, 0);
    assert.equal(
      output(),
      [
        "Release plan from main, 2 packages: 1 to release, 1 refused",
        "",
        "1. @antelopejs/interface-database 0.4.2 -> 0.5.0 (minor)  AntelopeJS/interface-database",
        "     feat(query)!: drop the legacy cursor",
        "2. @antelopejs/dms-database refused  AntelopeJS/dms-database",
        `     depends on preview @antelopejs/mongodb@1.8.7-next.40.g${short(commits.feed)}, which is not in this release`,
        "Not now: @antelopejs/mongodb",
        "",
      ].join("\n"),
    );
  });

  test("a package's commits leave out the listed packages nested in its directory", () => {
    const workspace = repository("workspace", (path) => {
      commit(path, "feat: first", {
        "package.json": manifest("workspace", "1.0.0"),
        "packages/inner/package.json": manifest("inner", "0.2.0"),
        "packages/inner/.release-it.json": { git: { tagName: "inner-v${version}" } },
      });
      git(path, "tag", "v1.0.0");
      git(path, "tag", "inner-v0.2.0");
      commit(path, "fix(inner): trim the input", { "packages/inner/index.ts": "export {};\n" });
    });
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", workspace, `${workspace}:packages/inner`], system), 0);
    assert.equal(
      output(),
      [
        "Release plan from main, 1 package: 1 to release",
        "",
        "1. @antelopejs/inner 0.2.0 -> 0.2.1 (patch)  AntelopeJS/workspace:packages/inner",
        "     fix(inner): trim the input",
        "Unchanged: @antelopejs/workspace",
        "",
      ].join("\n"),
    );
  });

  test("reads another branch with --ref", () => {
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", "--ref", "next", mongodb], system), 0);
    assert.equal(
      output(),
      [
        "Release plan from next, 1 package: 1 to release",
        "",
        "1. @antelopejs/mongodb 1.8.6 -> 1.8.7 (patch)  AntelopeJS/mongodb",
        "     fix(database): retry the change feed",
        "     fix(database): close the change feed",
        "",
      ].join("\n"),
    );
  });

  test("moves a pin only when the branch of its dependency holds the preview's commit", () => {
    const pinning = repository("pinning", (path) => {
      commit(path, "feat: first", { "package.json": manifest("pinning", "0.1.0") });
      git(path, "tag", "v0.1.0");
      commit(path, "chore: pin the mongodb previews", {
        "package.json": manifest("pinning", "0.1.0", {
          dependencies: { "@antelopejs/mongodb": `1.8.7-next.41.g${short(commits.later)}` },
          peerDependencies: { "@antelopejs/mongodb": "1.8.7-next.9.gabc1234" },
        }),
      });
      git(path, "branch", "next");
    });
    const reasons = (ref: string[]): string[] => {
      const { system, output } = fakeSystem();
      main(["plan", ...ref, interfaceDatabase, mongodb, pinning], system);
      return output().split("\n").filter((line) => line.startsWith("     depends on"));
    };
    const unknown = "     depends on preview @antelopejs/mongodb@1.8.7-next.9.gabc1234, whose main does not contain commit abc1234";
    assert.deepEqual(reasons([]), [
      `     depends on preview @antelopejs/mongodb@1.8.7-next.41.g${short(commits.later)}, whose main does not contain commit ${short(commits.later)}`,
      unknown,
    ]);
    assert.deepEqual(reasons(["--ref", "next"]), [unknown.replace("main", "next")]);
  });

  test("a gh failure counts as a branch that does not hold the commit", () => {
    const { system, output } = fakeSystem({}, { down: true });
    assert.equal(main(["plan", interfaceDatabase, mongodb, dmsDatabase], system), 0);
    assert.match(
      output(),
      new RegExp(`\n     depends on preview @antelopejs/mongodb@1\\.8\\.7-next\\.40\\.g${short(commits.feed)}, whose main does not contain commit ${short(commits.feed)}\n`),
    );
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { commit, dispatches, dms, dmsDatabase, expectedPlan, fakeSystem, git, interfaceDatabase, manifest, mongodb, repository, tip } from "./fixtures.ts";
import { main } from "./train.ts";

describe("go", () => {
  test("dispatches each release in dependency order and waits for each run", () => {
    const { system, output, calls } = fakeSystem();
    const status = main(["go", dmsDatabase, mongodb, interfaceDatabase, `${dms}:packages/automation`], system);
    assert.equal(status, 0);
    assert.deepEqual(dispatches(calls), [
      ["AntelopeJS/interface-database", "release-version=0.5.0", `release-commit=${tip(interfaceDatabase)}`, "dependency-ranges={}"],
      ["AntelopeJS/mongodb", "release-version=1.8.7", `release-commit=${tip(mongodb)}`, 'dependency-ranges={"@antelopejs/interface-database":">=0.5.0 <0.6.0"}'],
      ["AntelopeJS/dms-database", "release-version=0.5.4", `release-commit=${tip(dmsDatabase)}`, 'dependency-ranges={"@antelopejs/mongodb":">=1.8.7 <1.9.0"}'],
      ["AntelopeJS/dms", "release-version=0.11.2", `release-commit=${tip(dms)}`, "dependency-ranges={}", "package-directory=packages/automation"],
    ]);
    assert.ok(calls.filter((args) => args[0] === "workflow").every((args) => args[6] === "main"));
    assert.equal(
      output(),
      `${expectedPlan()}published @antelopejs/interface-database 0.5.0  https://github.com/AntelopeJS/interface-database/actions/runs/100\n` +
        "published @antelopejs/mongodb 1.8.7  https://github.com/AntelopeJS/mongodb/actions/runs/101\n" +
        "published @antelopejs/dms-database 0.5.4  https://github.com/AntelopeJS/dms-database/actions/runs/102\n" +
        "published @antelopejs/dms-automation 0.11.2  https://github.com/AntelopeJS/dms/actions/runs/103\n",
    );
  });

  test("stops at the first run that does not succeed and names what is left", () => {
    const { system, calls, errors } = fakeSystem({ "AntelopeJS/mongodb": "failure" });
    const status = main(["go", interfaceDatabase, mongodb, dmsDatabase], system);
    assert.equal(status, 1);
    assert.deepEqual(
      dispatches(calls).map(([repo]) => repo),
      ["AntelopeJS/interface-database", "AntelopeJS/mongodb"],
    );
    assert.equal(
      errors(),
      [
        "failed @antelopejs/mongodb 1.8.7 (failure)  https://github.com/AntelopeJS/mongodb/actions/runs/101",
        "Published: @antelopejs/interface-database 0.5.0.",
        "Not published: @antelopejs/mongodb 1.8.7, @antelopejs/dms-database 0.5.4.",
        "Fix the failure, then run go again to continue.",
        "",
      ].join("\n"),
    );
  });

  test("a dispatch that fails stops the train the same way", () => {
    const { system, calls, errors } = fakeSystem({ "AntelopeJS/interface-database": "rejected" });
    assert.equal(main(["go", interfaceDatabase, mongodb], system), 1);
    assert.deepEqual(
      calls.filter((args) => args[0] === "workflow").map((args) => args[4]),
      ["AntelopeJS/interface-database"],
    );
    assert.match(errors(), /^failed @antelopejs\/interface-database 0\.5\.0 gh workflow run release\.yml .* failed\nfailed\nPublished: nothing\.\nNot published: @antelopejs\/interface-database 0\.5\.0, @antelopejs\/mongodb 1\.8\.7\.\n/);
  });

  test("stops before a second package of a repository that an earlier release of the run changed", () => {
    const workspace = repository("go-workspace", (path) => {
      commit(path, "feat: first", {
        "package.json": manifest("go-root", "1.0.0", { dependencies: { "@antelopejs/go-inner": ">=0.2.0 <0.3.0" } }),
        "packages/inner/package.json": manifest("go-inner", "0.2.0"),
        "packages/inner/.release-it.json": { git: { tagName: "inner-v${version}" } },
      });
      git(path, "tag", "v1.0.0");
      git(path, "tag", "inner-v0.2.0");
      commit(path, "fix(inner): trim the input", { "packages/inner/index.ts": "export {};\n" });
      commit(path, "fix: log the start", { "index.ts": "export {};\n" });
    });
    const { system, calls, errors } = fakeSystem();
    assert.equal(main(["go", workspace, `${workspace}:packages/inner`], system), 1);
    assert.deepEqual(dispatches(calls).map((args) => args.at(-1)), ["package-directory=packages/inner"]);
    assert.equal(
      errors(),
      [
        "failed @antelopejs/go-root 1.0.1 AntelopeJS/go-workspace moved with the release of @antelopejs/go-inner 0.2.1, so its plan is stale.",
        "Published: @antelopejs/go-inner 0.2.1.",
        "Not published: @antelopejs/go-root 1.0.1.",
        "Fix the failure, then run go again to continue.",
        "",
      ].join("\n"),
    );
  });

  test("refuses --ref and dispatches nothing", () => {
    const { system, calls, errors } = fakeSystem();
    assert.equal(main(["go", "--ref", "next", mongodb], system), 1);
    assert.equal(errors(), "go always releases the default branch, so it takes no --ref.\n");
    assert.deepEqual(calls, []);
  });
});

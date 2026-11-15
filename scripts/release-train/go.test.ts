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
        "published @antelopejs/dms-automation 0.11.2  https://github.com/AntelopeJS/dms/actions/runs/103\n" +
        "Published: @antelopejs/interface-database 0.5.0, @antelopejs/mongodb 1.8.7, @antelopejs/dms-database 0.5.4, @antelopejs/dms-automation 0.11.2.\n",
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

  test("ends with what it published and what the plan refused", () => {
    const { system, output } = fakeSystem();
    assert.equal(main(["go", "--exclude", "@antelopejs/interface-database", interfaceDatabase, mongodb, `${dms}:packages/automation`], system), 0);
    assert.match(
      output(),
      /\npublished @antelopejs\/dms-automation 0\.11\.2  \S+\nPublished: @antelopejs\/dms-automation 0\.11\.2\.\nRefused, not published: @antelopejs\/mongodb\.\n$/,
    );
  });

  test("retries a run gh cannot read up to 8 times in a row", () => {
    const fails = (count: number): "fail"[] => Array.from({ length: count }, () => "fail" as const);
    const { system, output } = fakeSystem({}, { views: { "AntelopeJS/interface-database": [...fails(8), "running", ...fails(8)] } });
    assert.equal(main(["go", interfaceDatabase], system), 0);
    assert.match(output(), /\npublished @antelopejs\/interface-database 0\.5\.0  https:\/\/github\.com\/AntelopeJS\/interface-database\/actions\/runs\/100\n/);
  });

  test("a run gh cannot read 9 times in a row is unknown, and so is a dispatch with no run", () => {
    const fails = Array.from({ length: 9 }, () => "fail" as const);
    const unread = fakeSystem({}, { views: { "AntelopeJS/interface-database": fails } });
    assert.equal(main(["go", interfaceDatabase, mongodb], unread.system), 1);
    assert.equal(unread.sleeps.filter((milliseconds) => milliseconds === 15_000).length, 8);
    assert.deepEqual(dispatches(unread.calls).map(([repo]) => repo), ["AntelopeJS/interface-database"]);
    assert.equal(
      unread.errors(),
      [
        "unknown @antelopejs/interface-database 0.5.0, gh run view failed 9 times in a row",
        "Published: nothing.",
        "Not published: @antelopejs/mongodb 1.8.7.",
        "Unknown: @antelopejs/interface-database 0.5.0 (https://github.com/AntelopeJS/interface-database/actions/runs/100).",
        "Check that run before you run go again.",
        "",
      ].join("\n"),
    );

    const lost = fakeSystem({ "AntelopeJS/mongodb": "lost" });
    assert.equal(main(["go", interfaceDatabase, mongodb], lost.system), 1);
    assert.equal(
      lost.errors(),
      [
        "unknown @antelopejs/mongodb 1.8.7, no release.yml run appeared after the dispatch",
        "Published: @antelopejs/interface-database 0.5.0.",
        "Not published: nothing.",
        "Unknown: @antelopejs/mongodb 1.8.7 (https://github.com/AntelopeJS/mongodb/actions).",
        "Check that run before you run go again.",
        "",
      ].join("\n"),
    );
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

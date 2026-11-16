import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { commit, commits, dispatches, dms, dmsDatabase, expectedPlan, fakeSystem, git, interfaceDatabase, manifest, mongodb, repository, short, tip } from "./fixtures.ts";
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

  test("a failed run whose version npm holds is reported as published, and the train stops", () => {
    const { system, errors } = fakeSystem({ "AntelopeJS/mongodb": "failure" }, { npm: { "@antelopejs/mongodb@1.8.7": "1.8.7" } });
    assert.equal(main(["go", interfaceDatabase, mongodb, dmsDatabase], system), 1);
    assert.equal(
      errors(),
      [
        "failed @antelopejs/mongodb 1.8.7 after npm published it (failure)  https://github.com/AntelopeJS/mongodb/actions/runs/101",
        "Published: @antelopejs/interface-database 0.5.0, @antelopejs/mongodb 1.8.7.",
        "Not published: @antelopejs/dms-database 0.5.4.",
        "Run go again: the stable run writes the release commit, tag and GitHub release of @antelopejs/mongodb 1.8.7 without publishing it again, then the train continues. If its tag is on the default branch already, only its GitHub release is missing.",
        "",
      ].join("\n"),
    );
  });

  test("a failed run is unknown when npm cannot say whether it holds the version", () => {
    const { system, errors } = fakeSystem({ "AntelopeJS/interface-database": "failure" }, { npm: { "@antelopejs/interface-database@0.5.0": "error" } });
    assert.equal(main(["go", interfaceDatabase], system), 1);
    assert.equal(
      errors(),
      [
        "unknown @antelopejs/interface-database 0.5.0, (failure)  https://github.com/AntelopeJS/interface-database/actions/runs/100, and npm view @antelopejs/interface-database@0.5.0 failed",
        "Published: nothing.",
        "Not published: nothing.",
        "Unknown: @antelopejs/interface-database 0.5.0 (https://github.com/AntelopeJS/interface-database/actions/runs/100).",
        "Check that run before you run go again.",
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

  test("waits until npm serves a release before it dispatches the release that depends on it", () => {
    const { system, calls } = fakeSystem({}, { lag: { "@antelopejs/interface-database@0.5.0": 3 } });
    assert.equal(main(["go", interfaceDatabase, mongodb], system), 0);
    const steps = calls
      .filter((args) => args[0] === "view" || args[0] === "workflow")
      .map((args) => (args[0] === "view" ? `view ${args[1]}` : `dispatch ${args[4]}`));
    assert.deepEqual(steps, [
      "dispatch AntelopeJS/interface-database",
      ...Array.from({ length: 4 }, () => "view @antelopejs/interface-database@0.5.0"),
      "dispatch AntelopeJS/mongodb",
    ]);
  });

  test("stops when npm does not serve a release within 20 minutes, before the release that depends on it", () => {
    const { system, calls, errors } = fakeSystem({}, { lag: { "@antelopejs/interface-database@0.5.0": 80 } });
    assert.equal(main(["go", interfaceDatabase, mongodb], system), 1);
    assert.equal(calls.filter((args) => args[0] === "view").length, 80);
    assert.deepEqual(dispatches(calls).map(([repo]) => repo), ["AntelopeJS/interface-database"]);
    assert.equal(
      errors(),
      [
        "npm did not serve @antelopejs/interface-database 0.5.0 within 20 minutes of its release, so @antelopejs/mongodb 1.8.7, which depends on it, was not dispatched.",
        "Published: @antelopejs/interface-database 0.5.0.",
        "Not published: @antelopejs/mongodb 1.8.7.",
        "Run go again once npm view @antelopejs/interface-database@0.5.0 version prints 0.5.0.",
        "",
      ].join("\n"),
    );
  });

  test("releases every listed package of a repository, each from the head the release before it left", () => {
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
    const stale = fakeSystem();
    assert.equal(main(["go", workspace, `${workspace}:packages/inner`], stale.system), 1);
    assert.deepEqual(dispatches(stale.calls).map((args) => args.at(-1)), ["package-directory=packages/inner"]);
    assert.equal(
      stale.errors(),
      [
        "AntelopeJS/go-workspace did not move after the release of @antelopejs/go-inner 0.2.1. Fetch its checkout, then run go again.",
        "Published: @antelopejs/go-inner 0.2.1.",
        "Not published: @antelopejs/go-root 1.0.1.",
        "",
      ].join("\n"),
    );

    const released = fakeSystem({}, {
      dispatched: (_repo, fields) => {
        const directory = fields["package-directory"] ?? ".";
        const prefix = directory === "." ? "" : `${directory}/`;
        commit(workspace, "fix(deps): depend on the stable @antelopejs/x", { "pnpm-lock.yaml": `${fields["release-version"]}\n` });
        const bumped = { ...JSON.parse(readFileSync(join(workspace, `${prefix}package.json`), "utf8")), version: fields["release-version"] };
        commit(workspace, `chore(release): v${fields["release-version"]}`, { [`${prefix}CHANGELOG.md`]: `${fields["release-version"]}\n`, [`${prefix}package.json`]: bumped });
        git(workspace, "tag", `${directory === "." ? "v" : "inner-v"}${fields["release-version"]}`);
        git(workspace, "update-ref", "refs/remotes/origin/main", "HEAD");
      },
    });
    const before = tip(workspace);
    assert.equal(main(["go", workspace, `${workspace}:packages/inner`], released.system), 0, released.errors());
    assert.deepEqual(dispatches(released.calls), [
      ["AntelopeJS/go-workspace", "release-version=0.2.1", `release-commit=${before}`, "dependency-ranges={}", "package-directory=packages/inner"],
      ["AntelopeJS/go-workspace", "release-version=1.0.1", `release-commit=${git(workspace, "rev-parse", "inner-v0.2.1")}`, "dependency-ranges={}"],
    ]);
    assert.match(released.output(), /\nPublished: @antelopejs\/go-inner 0\.2\.1, @antelopejs\/go-root 1\.0\.1\.\n$/);
  });

  test("stops when the version a workspace sibling packs to moved since the plan", () => {
    const workspace = repository("go-siblings", (path) => {
      commit(path, "feat: first", {
        "package.json": { name: "go-siblings", private: true },
        "packages/a/package.json": manifest("go-a", "1.0.0"),
        "packages/a/.release-it.json": { git: { tagName: "a-v${version}" } },
        "packages/c/package.json": manifest("go-c", "1.0.0"),
        "packages/c/.release-it.json": { git: { tagName: "c-v${version}" } },
        "packages/b/package.json": manifest("go-b", "1.0.0", { dependencies: { "@antelopejs/go-a": "workspace:^", "@antelopejs/go-c": "workspace:^" } }),
        "packages/b/.release-it.json": { git: { tagName: "b-v${version}" } },
      });
      for (const name of ["a", "b", "c"]) git(path, "tag", `${name}-v1.0.0`);
      commit(path, "fix(c): trim the input", { "packages/c/index.ts": "export {};\n" });
      commit(path, "fix(b): log the start", { "packages/b/index.ts": "export {};\n" });
    });
    const { system, errors } = fakeSystem({}, {
      dispatched: () => {
        commit(workspace, "chore(release): c v1.0.1", { "packages/c/package.json": manifest("go-c", "1.0.1") });
        git(workspace, "tag", "c-v1.0.1");
        commit(workspace, "chore(release): a v1.1.0", { "packages/a/package.json": manifest("go-a", "1.1.0") });
        git(workspace, "tag", "a-v1.1.0");
        git(workspace, "update-ref", "refs/remotes/origin/main", "HEAD");
      },
    });
    assert.equal(main(["go", workspace], system), 1);
    assert.equal(
      errors(),
      [
        "The plan changed after the release of @antelopejs/go-c 1.0.1. Read it with plan, then run go again.",
        "Published: @antelopejs/go-c 1.0.1.",
        "Not published: @antelopejs/go-b 1.0.1.",
        "",
      ].join("\n"),
    );
  });

  test("releases a tooling-only dependent after the sibling whose release moved its workspace range out of the published one", () => {
    const workspace = repository("go-moves", (path) => {
      commit(path, "feat: first", {
        "package.json": { name: "go-moves", private: true },
        "packages/a/package.json": manifest("moves-a", "0.10.0"),
        "packages/a/.release-it.json": { git: { tagName: "a-v${version}" } },
        "packages/b/package.json": manifest("moves-b", "0.12.1", { dependencies: { "@antelopejs/moves-a": "workspace:^" } }),
        "packages/b/.release-it.json": { git: { tagName: "b-v${version}" } },
      });
      git(path, "tag", "a-v0.10.0");
      git(path, "tag", "b-v0.12.1");
      commit(path, "feat(a)!: rename the plans", { "packages/a/index.ts": "export {};\n" });
      commit(path, "build(b): move to 0.8", { "packages/b/tsconfig.json": "{}\n" });
    });
    const { system, calls, errors, output } = fakeSystem({}, {
      dispatched: (_repo, fields) => {
        const directory = fields["package-directory"] ?? "";
        const name = directory === "packages/a" ? "a" : "b";
        const file = `${directory}/package.json`;
        const bumped = { ...JSON.parse(readFileSync(join(workspace, file), "utf8")), version: fields["release-version"] };
        commit(workspace, `chore(release): ${name} v${fields["release-version"]}`, { [file]: bumped });
        git(workspace, "tag", `${name}-v${fields["release-version"]}`);
        git(workspace, "update-ref", "refs/remotes/origin/main", "HEAD");
      },
    });
    assert.equal(main(["go", workspace], system), 0, errors());
    assert.deepEqual(
      dispatches(calls).map((fields) => fields.filter((field) => field.startsWith("release-version=") || field.startsWith("package-directory="))),
      [
        ["release-version=0.11.0", "package-directory=packages/a"],
        ["release-version=0.12.2", "package-directory=packages/b"],
      ],
    );
    assert.ok(output().includes("     moves dependencies @antelopejs/moves-a ^0.10.0 -> ^0.11.0\n"), output());
    assert.ok(output().endsWith("Published: @antelopejs/moves-a 0.11.0, @antelopejs/moves-b 0.12.2.\n"), output());
  });

  test("refuses --ref and dispatches nothing", () => {
    const { system, calls, errors } = fakeSystem();
    assert.equal(main(["go", "--ref", "next", mongodb], system), 1);
    assert.equal(errors(), "go always releases the default branch, so it takes no --ref.\n");
    assert.deepEqual(calls, []);
  });

  test("a re-plan that fails still says what was published and what was not", () => {
    const workspace = repository("go-replan", (path) => {
      commit(path, "feat: first", {
        "package.json": manifest("replan-root", "1.0.0", { dependencies: { "@antelopejs/replan-inner": ">=0.2.0 <0.3.0" } }),
        "packages/inner/package.json": manifest("replan-inner", "0.2.0"),
        "packages/inner/.release-it.json": { git: { tagName: "inner-v${version}" } },
      });
      git(path, "tag", "v1.0.0");
      git(path, "tag", "inner-v0.2.0");
      commit(path, "fix(inner): trim the input", { "packages/inner/index.ts": "export {};\n" });
      commit(path, "fix: log the start", { "index.ts": "export {};\n" });
    });
    const fakes: { pullsDown?: boolean; dispatched?: () => void } = {
      dispatched: () => {
        commit(workspace, "chore(release): v0.2.1", { "packages/inner/CHANGELOG.md": "x\n" });
        git(workspace, "tag", "inner-v0.2.1");
        git(workspace, "update-ref", "refs/remotes/origin/main", "HEAD");
        fakes.pullsDown = true;
      },
    };
    const { system, errors } = fakeSystem({}, fakes);
    assert.equal(main(["go", workspace, `${workspace}:packages/inner`], system), 1);
    assert.equal(
      errors(),
      [
        "The plan could not be read again after the release of @antelopejs/replan-inner 0.2.1: gh pr list --repo AntelopeJS/go-replan --base main failed, so the plan cannot read the commits of the cycle.",
        "Published: @antelopejs/replan-inner 0.2.1.",
        "Not published: @antelopejs/replan-root 1.0.1.",
        "",
      ].join("\n"),
    );
  });
});

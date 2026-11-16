import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { commit, commits, dispatches, dms, dmsDatabase, expectedPlan, fakeSystem, git, interfaceDatabase, manifest, mongodb, pulls, repository, short, tip } from "./fixtures.ts";
import { readSource, resolveRevision } from "./git.ts";
import { main } from "./train.ts";

describe("plan", () => {
  test("reads each checkout at its default branch and prints the plan", () => {
    const { system, calls, output } = fakeSystem();
    const status = main(["plan", dmsDatabase, mongodb, interfaceDatabase, `${dms}:packages/automation`], system);
    assert.equal(status, 0);
    assert.equal(output(), expectedPlan());
    assert.deepEqual(dispatches(calls), []);
  });

  test("a tooling-only cycle plans a patch only when it changes a runtime dependency of the published package.json", () => {
    const tooling = (name: string, dependencies: Record<string, string>) =>
      repository(name, (path) => {
        commit(path, "feat: first", { "package.json": manifest(name, "0.4.2", { dependencies: { mongodb: "^6.21.0" }, devDependencies: { "@antelopejs/tooling-configs": "^0.7.0" } }) });
        git(path, "tag", "v0.4.2");
        commit(path, "build: move to @antelopejs/tooling-configs 0.8", {
          "package.json": manifest(name, "0.4.2", { dependencies, devDependencies: { "@antelopejs/tooling-configs": "^0.8.0" } }),
        });
      });
    const kept = tooling("tooling-kept", { mongodb: "^6.21.0" });
    const moved = tooling("tooling-moved", { mongodb: "^7.0.0" });
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", kept, moved], system), 0);
    assert.equal(
      output(),
      [
        "Release plan from main, 1 package: 1 to release",
        "",
        `1. @antelopejs/tooling-moved 0.4.2 -> 0.4.3 (patch)  AntelopeJS/tooling-moved@${short(tip(moved))}`,
        "     moves dependencies mongodb ^6.21.0 -> ^7.0.0",
        "Unchanged: @antelopejs/tooling-kept, only build commits since 0.4.2",
        "",
      ].join("\n"),
    );
  });

  test("reads a workspace root that is no package through each released package under it, in dependency order", () => {
    const workspace = repository("workspace-root", (path) => {
      commit(path, "feat: first", {
        "package.json": { name: "workspace-root", private: true },
        "packages/interface-x/package.json": manifest("interface-x", "0.10.0"),
        "packages/interface-x/.release-it.json": { git: { tagName: "interface-v${version}" } },
        "packages/x/package.json": manifest("x", "0.12.1", { dependencies: { "@antelopejs/interface-x": "workspace:^" } }),
        "packages/x/.release-it.json": {},
        "packages/x/frontend-vue/package.json": { name: "frontend", private: true },
        "packages/é/package.json": manifest("accent", "0.1.0"),
        "packages/é/.release-it.json": { git: { tagName: "accent-v${version}" } },
      });
      git(path, "tag", "interface-v0.10.0");
      git(path, "tag", "v0.12.1");
      git(path, "tag", "accent-v0.1.0");
      commit(path, "fix(x): close the feed", { "packages/x/index.ts": "export {};\n" });
      git(path, "checkout", "--quiet", "-b", "next");
      commit(path, "feat(interface)!: rename the plans", { "packages/interface-x/index.ts": "export {};\n" });
      git(path, "checkout", "--quiet", "main");
    });
    git(workspace, "update-ref", "refs/remotes/origin/next", "next");
    const at = (branch: string): string => short(tip(workspace, branch));
    const onMain = fakeSystem();
    assert.equal(main(["plan", workspace], onMain.system), 0, onMain.errors());
    assert.equal(
      onMain.output(),
      [
        "Release plan from main, 1 package: 1 to release",
        "",
        `1. @antelopejs/x 0.12.1 -> 0.12.2 (patch)  AntelopeJS/workspace-root:packages/x@${at("main")}`,
        "     fix(x): close the feed",
        "     @antelopejs/interface-x workspace:^ -> ^0.10.0",
        "Unchanged: @antelopejs/interface-x, @antelopejs/accent",
        "",
      ].join("\n"),
    );
    const next = fakeSystem();
    assert.equal(main(["plan", "--ref", "next", workspace], next.system), 0, next.errors());
    assert.equal(
      next.output(),
      [
        "Release plan from next, 2 packages: 2 to release",
        "",
        `1. @antelopejs/interface-x 0.10.0 -> 0.11.0 (minor)  AntelopeJS/workspace-root:packages/interface-x@${at("next")}`,
        "     feat(interface)!: rename the plans",
        `2. @antelopejs/x 0.12.1 -> 0.12.2 (patch)  AntelopeJS/workspace-root:packages/x@${at("next")}`,
        "     fix(x): close the feed",
        "     @antelopejs/interface-x workspace:^ -> ^0.11.0",
        "Unchanged: @antelopejs/accent",
        "",
      ].join("\n"),
    );
    const bare = repository("workspace-empty", (path) => {
      commit(path, "feat: first", { "package.json": { name: "workspace-empty", private: true } });
    });
    const stopped = fakeSystem();
    assert.equal(main(["plan", bare], stopped.system), 1);
    assert.equal(stopped.errors(), "AntelopeJS/workspace-empty:package.json has no name or version.\n");
  });

  test("a tag above the version of package.json on the default branch is never the stable release", () => {
    const accidental = repository("accidental-major", (path) => {
      commit(path, "feat: first", { "package.json": manifest("accidental-major", "1.24.0") });
      git(path, "tag", "v2.0.1");
      commit(path, "chore(release): v1.24.1", { "package.json": manifest("accidental-major", "1.24.1") });
      git(path, "tag", "v1.24.1");
      commit(path, "fix: close the socket (#512)", { "src/socket.ts": "export {};\n" });
    });
    const planned = fakeSystem();
    assert.equal(main(["plan", accidental], planned.system), 0, planned.errors());
    assert.equal(
      planned.output(),
      [
        "Release plan from main, 1 package: 1 to release",
        "",
        `1. @antelopejs/accidental-major 1.24.1 -> 1.24.2 (patch)  AntelopeJS/accidental-major@${short(tip(accidental))}`,
        "     fix: close the socket (#512)",
        "",
      ].join("\n"),
    );

    const untagged = repository("accidental-only", (path) => {
      commit(path, "feat: first", { "package.json": manifest("accidental-only", "1.24.1") });
      git(path, "tag", "v2.0.0");
      git(path, "tag", "v2.0.1");
      commit(path, "fix: close the socket (#512)", { "src/socket.ts": "export {};\n" });
    });
    const stopped = fakeSystem();
    assert.equal(main(["plan", untagged], stopped.system), 1);
    assert.equal(
      stopped.errors(),
      "@antelopejs/accidental-only has no release tag at or below 1.24.1, the version of its package.json on the default branch, only the higher tags v2.0.0, v2.0.1. Tag the release that version names, then plan again.\n",
    );
  });

  test("an excluded package refuses the packages that pin its preview at runtime", () => {
    const { system, output } = fakeSystem();
    const status = main(["plan", "--exclude", "@antelopejs/interface-database", interfaceDatabase, mongodb, dmsDatabase], system);
    assert.equal(status, 0);
    assert.equal(
      output(),
      [
        "Release plan from main, 1 package: 1 refused",
        "",
        `1. @antelopejs/mongodb refused  AntelopeJS/mongodb@${short(tip(mongodb))}`,
        `     depends on preview @antelopejs/interface-database@0.4.3-next.12.g${short(commits.cursor)}, which is not in this release`,
        "Unchanged: @antelopejs/dms-database, only chore commits since 0.5.3",
        "Not now: @antelopejs/interface-database",
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
        `1. @antelopejs/inner 0.2.0 -> 0.2.1 (patch)  AntelopeJS/workspace:packages/inner@${short(tip(workspace))}`,
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
        `1. @antelopejs/mongodb 1.8.6 -> 1.8.7 (patch)  AntelopeJS/mongodb@${short(tip(mongodb, "next"))}`,
        "     fix(database): retry the change feed",
        "     fix(database): close the change feed",
        "",
      ].join("\n"),
    );
  });

  test("lists the tasks of the cycle from the heads of the pull requests merged since the stable tag", () => {
    const promoted = repository("promoted", (path) => {
      commit(path, "feat: first", { "package.json": manifest("promoted", "0.3.0") });
      git(path, "tag", "v0.3.0");
      git(path, "checkout", "--quiet", "-b", "next");
      const earlier = commit(path, "feat(query): hand over rows in batches (#11)", { "src/batch.ts": "export {};\n" }, "Alice");
      git(path, "checkout", "--quiet", "main");
      const earlierSquash = commit(path, "feat(query): hand over rows in batches (#12)", { "src/batch.ts": "export {};\n" });
      commit(path, "chore(release): v0.3.1", { "package.json": manifest("promoted", "0.3.1") }, "github-actions[bot]");
      git(path, "tag", "v0.3.1");
      git(path, "checkout", "--quiet", "next");
      git(path, "merge", "--quiet", "--no-ff", "-m", "Merge main into next", "main");
      commit(path, "fix(cursor): close the cursor on error (#13)", { "src/cursor.ts": "export {};\n" }, "Bob");
      commit(path, "chore: tidy the scripts (#14)", { "src/scripts.ts": "export {};\n" }, "Bob");
      const head = commit(path, "feat(api)!: rename read to fetch (#15)", { "src/api.ts": "export {};\n" }, "Alice");
      git(path, "checkout", "--quiet", "main");
      git(path, "merge", "--quiet", "--squash", "next");
      const squash = commit(path, "fix: promote next (#16)", {});
      const hotfix = commit(path, "fix(io): retry the reads (#17)", { "src/io.ts": "export {};\n" }, "Carol");
      pulls["AntelopeJS/promoted"] = [
        { number: 12, mergeCommit: { oid: earlierSquash }, headRefOid: earlier },
        { number: 16, mergeCommit: { oid: squash }, headRefOid: head },
        { number: 17, mergeCommit: { oid: hotfix }, headRefOid: "f".repeat(40) },
      ];
    });
    const planned = fakeSystem();
    assert.equal(main(["plan", promoted], planned.system), 0);
    assert.equal(
      planned.output(),
      [
        "Release plan from main, 1 package: 1 to release",
        "",
        `1. @antelopejs/promoted 0.3.1 -> 0.4.0 (minor)  AntelopeJS/promoted@${short(tip(promoted))}`,
        "     fix(io): retry the reads (#17)",
        "     feat(api)!: rename read to fetch (#15)",
        "     fix(cursor): close the cursor on error (#13)",
        "",
      ].join("\n"),
    );
    const offline = fakeSystem({}, { down: true });
    assert.equal(main(["plan", promoted], offline.system), 1);
    assert.equal(offline.errors(), "gh pr list --repo AntelopeJS/promoted --base main failed, so the plan cannot read the commits of the cycle.\n");
  });

  test("--ref next leaves out the tasks the stable release shipped, whether or not next merged main back", () => {
    const released = (name: string, synced: boolean) =>
      repository(name, (path) => {
        commit(path, "feat: first", { "package.json": manifest(name, "1.0.0") });
        git(path, "tag", "v1.0.0");
        git(path, "checkout", "--quiet", "-b", "next");
        const task = commit(path, "feat: add the cursor (#2)", { "src/cursor.ts": "export {};\n" });
        git(path, "checkout", "--quiet", "main");
        git(path, "merge", "--quiet", "--squash", "next");
        const squash = commit(path, "feat: add the cursor (#3)", {});
        commit(path, "chore(release): v1.0.1", { "package.json": manifest(name, "1.0.1"), "CHANGELOG.md": "## v1.0.1\n" });
        git(path, "tag", "v1.0.1");
        git(path, "checkout", "--quiet", "next");
        if (synced) git(path, "merge", "--quiet", "--no-ff", "-m", "chore: merge main into next", "main");
        commit(path, "ci: cache the store (#4)", { "ci.txt": "x\n" });
        git(path, "checkout", "--quiet", "main");
        pulls[`AntelopeJS/${name}`] = [{ number: 3, mergeCommit: { oid: squash }, headRefOid: task }];
      });
    for (const [name, synced] of [["next-unsynced", false], ["next-synced", true]] as const) {
      const { system, output } = fakeSystem();
      assert.equal(main(["plan", "--ref", "next", released(name, synced)], system), 0);
      assert.equal(output(), `Release plan from next, nothing to release\n\nUnchanged: @antelopejs/${name}, only ci commits since 1.0.1\n`, name);
    }
  });

  test("--ref next reads a dependency move a hotfix released on main as main's, not as next's", () => {
    const hotfixed = repository("next-hotfixed", (path) => {
      commit(path, "feat: first", { "package.json": manifest("next-hotfixed", "1.0.0", { dependencies: { foo: "^1.0.0" } }) });
      git(path, "tag", "v1.0.0");
      git(path, "branch", "next");
      commit(path, "fix(deps): move to foo 1.0.1 (#3)", { "package.json": manifest("next-hotfixed", "1.0.0", { dependencies: { foo: "^1.0.1" } }) });
      commit(path, "chore(release): v1.0.1", { "package.json": manifest("next-hotfixed", "1.0.1", { dependencies: { foo: "^1.0.1" } }) });
      git(path, "tag", "v1.0.1");
      git(path, "checkout", "--quiet", "next");
      commit(path, "ci: cache the store (#4)", { "ci.txt": "x\n" });
      git(path, "checkout", "--quiet", "main");
    });
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", "--ref", "next", hotfixed], system), 0);
    assert.equal(output(), "Release plan from next, nothing to release\n\nUnchanged: @antelopejs/next-hotfixed, only ci commits since 1.0.1\n");
  });

  test("--ref next lists only the commits main lacks, whether the Next sync merged main from before or after the promotion", () => {
    const synced = (name: string, late: boolean) =>
      repository(name, (path) => {
        commit(path, "feat: first", { "package.json": manifest(name, "1.0.0", { dependencies: { foo: "^1.0.0" } }) });
        git(path, "tag", "v1.0.0");
        git(path, "checkout", "--quiet", "-b", "next");
        const task = commit(path, "feat: read with foo 2 (#2)", { "package.json": manifest(name, "1.0.0", { dependencies: { foo: "^2.0.0" } }) });
        git(path, "checkout", "--quiet", "main");
        commit(path, "fix: close the feed (#5)", { "src/feed.ts": "export {};\n" });
        const before = tip(path);
        git(path, "merge", "--quiet", "--squash", "next");
        const squash = commit(path, "feat: read with foo 2 (#3)", {});
        commit(path, "chore(release): v1.1.0", { "package.json": manifest(name, "1.1.0", { dependencies: { foo: "^2.0.0" } }) });
        git(path, "tag", "v1.1.0");
        const hotfix = commit(path, "fix(deps): move to foo 2.0.1 (#7)", { "package.json": manifest(name, "1.1.0", { dependencies: { foo: "^2.0.1" } }) });
        commit(path, "chore(release): v1.1.1", { "package.json": manifest(name, "1.1.1", { dependencies: { foo: "^2.0.1" } }) });
        git(path, "tag", "v1.1.1");
        git(path, "checkout", "--quiet", "next");
        for (const ref of late ? [before] : ["v1.1.0", "main"]) git(path, "merge", "--quiet", "--no-ff", "-m", "chore: merge main into next", ref);
        commit(path, "ci: cache the store (#6)", { "ci.txt": "x\n" });
        git(path, "checkout", "--quiet", "main");
        pulls[`AntelopeJS/${name}`] = [
          { number: 7, mergeCommit: { oid: hotfix }, headRefOid: hotfix },
          { number: 3, mergeCommit: { oid: squash }, headRefOid: task },
        ];
      });
    for (const [name, late] of [["next-synced-after", false], ["next-synced-before", true]] as const) {
      const path = synced(name, late);
      git(path, "update-ref", "refs/remotes/origin/next", "next");
      const { system, output } = fakeSystem();
      assert.equal(main(["plan", "--ref", "next", path], system), 0);
      assert.equal(output(), `Release plan from next, nothing to release\n\nUnchanged: @antelopejs/${name}, only ci commits since 1.1.1\n`, name);
    }
  });

  test("a pull request merged into main with a merge commit releases at the level of the merge commit's title", () => {
    const name = "main-merged";
    const path = repository(name, (path) => {
      commit(path, "feat: first", { "package.json": manifest(name, "1.0.0"), "a.txt": "a\n", "b.txt": "b\n" });
      git(path, "tag", "v1.0.0");
      git(path, "checkout", "--quiet", "-b", "topic");
      const head = commit(path, "wip", { "a.txt": "a2\n" });
      git(path, "checkout", "--quiet", "main");
      commit(path, "ci: touch b", { "b.txt": "b2\n" });
      git(path, "merge", "--quiet", "--no-ff", "-m", "fix: close the feed (#4)", "topic");
      pulls[`AntelopeJS/${name}`] = [{ number: 4, mergeCommit: { oid: tip(path) }, headRefOid: head }];
    });
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", path], system), 0);
    assert.match(output(), /^1\. @antelopejs\/main-merged 1\.0\.0 -> 1\.0\.1 \(patch\) /m);
  });

  test("--ref next reads a dependency move main made before the promotion as main's when the Next sync merged it late", () => {
    const name = "next-synced-move";
    const path = repository(name, (path) => {
      commit(path, "feat: first", { "package.json": manifest(name, "1.0.0", { dependencies: { foo: "^1.0.0" } }) });
      git(path, "tag", "v1.0.0");
      git(path, "checkout", "--quiet", "-b", "next");
      const task = commit(path, "feat: add the cursor (#2)", { "src/cursor.ts": "export {};\n" });
      git(path, "checkout", "--quiet", "main");
      const moved = commit(path, "fix(deps): move to foo 1.5 (#5)", { "package.json": manifest(name, "1.0.0", { dependencies: { foo: "^1.5.0" } }) });
      git(path, "merge", "--quiet", "--squash", "next");
      const squash = commit(path, "feat: add the cursor (#3)", {});
      commit(path, "chore(release): v1.1.0", { "package.json": manifest(name, "1.1.0", { dependencies: { foo: "^1.5.0" } }) });
      git(path, "tag", "v1.1.0");
      const hotfix = commit(path, "fix(deps): move to foo 1.6 (#7)", { "package.json": manifest(name, "1.1.0", { dependencies: { foo: "^1.6.0" } }) });
      commit(path, "chore(release): v1.1.1", { "package.json": manifest(name, "1.1.1", { dependencies: { foo: "^1.6.0" } }) });
      git(path, "tag", "v1.1.1");
      git(path, "checkout", "--quiet", "next");
      git(path, "merge", "--quiet", "--no-ff", "-m", "chore: merge main into next", moved);
      commit(path, "ci: cache the store (#6)", { "ci.txt": "x\n" });
      git(path, "checkout", "--quiet", "main");
      pulls[`AntelopeJS/${name}`] = [
        { number: 7, mergeCommit: { oid: hotfix }, headRefOid: hotfix },
        { number: 5, mergeCommit: { oid: moved }, headRefOid: moved },
        { number: 3, mergeCommit: { oid: squash }, headRefOid: task },
      ];
    });
    git(path, "update-ref", "refs/remotes/origin/next", "next");
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", "--ref", "next", path], system), 0);
    assert.equal(output(), `Release plan from next, nothing to release\n\nUnchanged: @antelopejs/${name}, only ci commits since 1.1.1\n`);
  });

  test("--ref next reads a dependency move the stable release shipped through a promotion as shipped", () => {
    const promoted = repository("next-moved", (path) => {
      commit(path, "feat: first", { "package.json": manifest("next-moved", "1.0.0", { dependencies: { foo: "^1.0.0" } }) });
      git(path, "tag", "v1.0.0");
      git(path, "checkout", "--quiet", "-b", "next");
      commit(path, "chore(deps): move to foo 2 (#2)", { "package.json": manifest("next-moved", "1.0.0", { dependencies: { foo: "^2.0.0" } }) });
      const task = commit(path, "fix: read with foo 2 (#2)", { "src/foo.ts": "export {};\n" });
      git(path, "checkout", "--quiet", "main");
      git(path, "merge", "--quiet", "--squash", "next");
      const squash = commit(path, "fix: read with foo 2 (#3)", {});
      commit(path, "chore(release): v1.0.1", { "package.json": manifest("next-moved", "1.0.1", { dependencies: { foo: "^2.0.0" } }) });
      git(path, "tag", "v1.0.1");
      git(path, "checkout", "--quiet", "next");
      commit(path, "ci: cache the store (#4)", { "ci.txt": "x\n" });
      git(path, "checkout", "--quiet", "main");
      pulls["AntelopeJS/next-moved"] = [{ number: 3, mergeCommit: { oid: squash }, headRefOid: task }];
    });
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", "--ref", "next", promoted], system), 0);
    assert.equal(output(), "Release plan from next, nothing to release\n\nUnchanged: @antelopejs/next-moved, only ci commits since 1.0.1\n");
  });

  test("--ref next reads a dependency move a promotion shipped as shipped after a released hotfix moved it again", () => {
    const rehotfixed = repository("next-rehotfixed", (path) => {
      commit(path, "feat: first", { "package.json": manifest("next-rehotfixed", "1.0.0", { dependencies: { foo: "^1.0.0" } }) });
      git(path, "tag", "v1.0.0");
      git(path, "checkout", "--quiet", "-b", "next");
      commit(path, "chore(deps): move to foo 2 (#2)", { "package.json": manifest("next-rehotfixed", "1.0.0", { dependencies: { foo: "^2.0.0" } }) });
      const task = commit(path, "fix: read with foo 2 (#2)", { "src/foo.ts": "export {};\n" });
      git(path, "checkout", "--quiet", "main");
      git(path, "merge", "--quiet", "--squash", "next");
      const squash = commit(path, "fix: read with foo 2 (#3)", {});
      commit(path, "chore(release): v1.0.1", { "package.json": manifest("next-rehotfixed", "1.0.1", { dependencies: { foo: "^2.0.0" } }) });
      git(path, "tag", "v1.0.1");
      commit(path, "fix(deps): move to foo 2.0.1 (#5)", { "package.json": manifest("next-rehotfixed", "1.0.1", { dependencies: { foo: "^2.0.1" } }) });
      commit(path, "chore(release): v1.0.2", { "package.json": manifest("next-rehotfixed", "1.0.2", { dependencies: { foo: "^2.0.1" } }) });
      git(path, "tag", "v1.0.2");
      git(path, "checkout", "--quiet", "next");
      commit(path, "ci: cache the store (#4)", { "ci.txt": "x\n" });
      git(path, "checkout", "--quiet", "main");
      pulls["AntelopeJS/next-rehotfixed"] = [{ number: 3, mergeCommit: { oid: squash }, headRefOid: task }];
    });
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", "--ref", "next", rehotfixed], system), 0);
    assert.equal(output(), "Release plan from next, nothing to release\n\nUnchanged: @antelopejs/next-rehotfixed, only ci commits since 1.0.2\n");
  });

  test("--ref next reads a move back to a spec an older promotion shipped as a change", () => {
    const reverted = repository("next-reverted", (path) => {
      commit(path, "feat: first", { "package.json": manifest("next-reverted", "1.0.0", { dependencies: { foo: "^0.9.0" } }) });
      git(path, "tag", "v1.0.0");
      git(path, "checkout", "--quiet", "-b", "next");
      const promote = (spec: string, version: string, number: number): unknown => {
        git(path, "checkout", "--quiet", "next");
        commit(path, `chore(deps): move to foo ${spec} (#${number})`, { "package.json": manifest("next-reverted", "1.0.0", { dependencies: { foo: spec } }) });
        const task = commit(path, `fix: read with foo ${spec} (#${number})`, { [`src/${number}.ts`]: "export {};\n" });
        git(path, "checkout", "--quiet", "main");
        git(path, "merge", "--quiet", "--squash", "-X", "theirs", "next");
        const squash = commit(path, `fix: read with foo ${spec} (#${number + 1})`, {});
        commit(path, `chore(release): v${version}`, { "package.json": manifest("next-reverted", version, { dependencies: { foo: spec } }) });
        git(path, "tag", `v${version}`);
        return { number: number + 1, mergeCommit: { oid: squash }, headRefOid: task };
      };
      const first = promote("^1.0.0", "1.0.1", 2);
      const second = promote("^2.0.0", "1.0.2", 4);
      git(path, "checkout", "--quiet", "next");
      commit(path, "chore(deps): go back to foo 1 (#6)", { "package.json": manifest("next-reverted", "1.0.0", { dependencies: { foo: "^1.0.0" } }) });
      git(path, "checkout", "--quiet", "main");
      pulls["AntelopeJS/next-reverted"] = [second, first];
    });
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", "--ref", "next", reverted], system), 0);
    assert.equal(
      output(),
      [
        "Release plan from next, 1 package: 1 to release",
        "",
        `1. @antelopejs/next-reverted 1.0.2 -> 1.0.3 (patch)  AntelopeJS/next-reverted@${short(tip(reverted, "next"))}`,
        "     moves dependencies foo ^2.0.0 -> ^1.0.0",
        "",
      ].join("\n"),
    );
  });

  test("--ref next replaces a pin whose range only the fork base held, which no stable tag published", () => {
    const ids = { task: "" };
    const dependency = repository("next-fork-dependency", (path) => {
      commit(path, "feat: first", { "package.json": manifest("next-fork-dependency", "1.0.0") });
      git(path, "tag", "v1.0.0");
      ids.task = commit(path, "feat: add the cursor", { "src/cursor.ts": "export {};\n" });
      commit(path, "chore(release): v1.0.1", { "package.json": manifest("next-fork-dependency", "1.0.1") });
      git(path, "tag", "v1.0.1");
    });
    const dependent = repository("next-fork-pinning", (path) => {
      commit(path, "feat: first", { "package.json": manifest("next-fork-pinning", "2.0.0", { dependencies: { "@antelopejs/next-fork-dependency": "^0.9.0" } }) });
      git(path, "tag", "v2.0.0");
      commit(path, "build(deps): move to the dependency 1.0", { "package.json": manifest("next-fork-pinning", "2.0.0", { dependencies: { "@antelopejs/next-fork-dependency": ">=1.0.1 <1.1.0" } }) });
      git(path, "branch", "next");
      commit(path, "fix(deps): go back to the dependency 0.9", { "package.json": manifest("next-fork-pinning", "2.0.0", { dependencies: { "@antelopejs/next-fork-dependency": "^0.9.0" } }) });
      commit(path, "chore(release): v2.0.1", { "package.json": manifest("next-fork-pinning", "2.0.1", { dependencies: { "@antelopejs/next-fork-dependency": "^0.9.0" } }) });
      git(path, "tag", "v2.0.1");
      git(path, "checkout", "--quiet", "next");
      commit(path, "build(deps): pin the dependency preview", {
        "package.json": manifest("next-fork-pinning", "2.0.0", { dependencies: { "@antelopejs/next-fork-dependency": `1.0.1-next.3.g${short(ids.task)}` } }),
      });
      git(path, "checkout", "--quiet", "main");
    });
    git(dependency, "branch", "next");
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", "--ref", "next", dependency, dependent], system), 0);
    assert.ok(
      output().includes(
        [
          `1. @antelopejs/next-fork-pinning 2.0.1 -> 2.0.2 (patch)  AntelopeJS/next-fork-pinning@${short(tip(dependent, "next"))}`,
          "     replaces preview pins",
          `     @antelopejs/next-fork-dependency 1.0.1-next.3.g${short(ids.task)} -> >=1.0.1 <1.1.0`,
        ].join("\n"),
      ),
      output(),
    );
  });

  test("--ref next reads a pin the stable run already rewrote into its range as shipped", () => {
    const ids = { task: "" };
    const dependency = repository("next-pinned-dependency", (path) => {
      commit(path, "feat: first", { "package.json": manifest("next-pinned-dependency", "1.0.0") });
      git(path, "tag", "v1.0.0");
      git(path, "checkout", "--quiet", "-b", "next");
      ids.task = commit(path, "feat: add the cursor (#2)", { "src/cursor.ts": "export {};\n" });
      git(path, "checkout", "--quiet", "main");
      git(path, "merge", "--quiet", "--squash", "next");
      const squash = commit(path, "feat: add the cursor (#3)", {});
      commit(path, "chore(release): v1.0.1", { "package.json": manifest("next-pinned-dependency", "1.0.1") });
      git(path, "tag", "v1.0.1");
      git(path, "checkout", "--quiet", "main");
      pulls["AntelopeJS/next-pinned-dependency"] = [{ number: 3, mergeCommit: { oid: squash }, headRefOid: ids.task }];
    });
    const dependent = repository("next-pin-rewritten", (path) => {
      commit(path, "feat: first", { "package.json": manifest("next-pin-rewritten", "2.0.0") });
      git(path, "tag", "v2.0.0");
      git(path, "checkout", "--quiet", "-b", "next");
      const pin = { "@antelopejs/next-pinned-dependency": `1.0.1-next.3.g${short(ids.task)}` };
      const task = commit(path, "fix: read with the cursor (#5)", { "package.json": manifest("next-pin-rewritten", "2.0.0", { dependencies: pin }) });
      git(path, "checkout", "--quiet", "main");
      git(path, "merge", "--quiet", "--squash", "next");
      const squash = commit(path, "fix: read with the cursor (#6)", {});
      commit(path, "chore(release): v2.0.1", {
        "package.json": manifest("next-pin-rewritten", "2.0.1", { dependencies: { "@antelopejs/next-pinned-dependency": ">=1.0.1 <1.1.0" } }),
      });
      git(path, "tag", "v2.0.1");
      git(path, "checkout", "--quiet", "next");
      commit(path, "ci: cache the store (#7)", { "ci.txt": "x\n" });
      git(path, "checkout", "--quiet", "main");
      pulls["AntelopeJS/next-pin-rewritten"] = [{ number: 6, mergeCommit: { oid: squash }, headRefOid: task }];
    });
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", "--ref", "next", dependency, dependent], system), 0);
    assert.equal(
      output(),
      [
        "Release plan from next, nothing to release",
        "",
        "Unchanged: @antelopejs/next-pinned-dependency",
        "Unchanged: @antelopejs/next-pin-rewritten, only ci commits since 2.0.1",
        "",
      ].join("\n"),
    );
    git(dependency, "checkout", "--quiet", "next");
    commit(dependency, "feat: add the batch (#8)", { "src/batch.ts": "export {};\n" });
    git(dependency, "checkout", "--quiet", "main");
    const moved = fakeSystem();
    assert.equal(main(["plan", "--ref", "next", dependency, dependent], moved.system), 0);
    assert.ok(
      moved.output().includes(
        [
          `2. @antelopejs/next-pin-rewritten 2.0.1 -> 2.0.2 (patch)  AntelopeJS/next-pin-rewritten@${short(tip(dependent, "next"))}`,
          "     replaces preview pins",
          `     @antelopejs/next-pinned-dependency 1.0.1-next.3.g${short(ids.task)} -> >=1.0.2 <1.1.0`,
        ].join("\n"),
      ),
      moved.output(),
    );
  });

  test("--ref next reads a move back to the spec next forked with, after a promotion moved it, as a change", () => {
    const reverted = repository("next-forked-back", (path) => {
      commit(path, "feat: first", { "package.json": manifest("next-forked-back", "1.0.0", { dependencies: { foo: "^0.9.0" } }) });
      git(path, "tag", "v1.0.0");
      git(path, "checkout", "--quiet", "-b", "next");
      commit(path, "chore(deps): move to foo 1 (#2)", { "package.json": manifest("next-forked-back", "1.0.0", { dependencies: { foo: "^1.0.0" } }) });
      const task = commit(path, "fix: read with foo 1 (#2)", { "src/foo.ts": "export {};\n" });
      git(path, "checkout", "--quiet", "main");
      git(path, "merge", "--quiet", "--squash", "next");
      const squash = commit(path, "fix: read with foo 1 (#3)", {});
      commit(path, "chore(release): v1.0.1", { "package.json": manifest("next-forked-back", "1.0.1", { dependencies: { foo: "^1.0.0" } }) });
      git(path, "tag", "v1.0.1");
      git(path, "checkout", "--quiet", "next");
      commit(path, "chore(deps): go back to foo 0.9 (#4)", { "package.json": manifest("next-forked-back", "1.0.0", { dependencies: { foo: "^0.9.0" } }) });
      git(path, "checkout", "--quiet", "main");
      pulls["AntelopeJS/next-forked-back"] = [{ number: 3, mergeCommit: { oid: squash }, headRefOid: task }];
    });
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", "--ref", "next", reverted], system), 0);
    assert.equal(
      output(),
      [
        "Release plan from next, 1 package: 1 to release",
        "",
        `1. @antelopejs/next-forked-back 1.0.1 -> 1.0.2 (patch)  AntelopeJS/next-forked-back@${short(tip(reverted, "next"))}`,
        "     moves dependencies foo ^1.0.0 -> ^0.9.0",
        "",
      ].join("\n"),
    );
  });

  test("--ref next reads a move back to the last promotion's spec, after the Next sync brought a later hotfix, as a change", () => {
    const synced = repository("next-partly-synced", (path) => {
      commit(path, "feat: first", { "package.json": manifest("next-partly-synced", "1.0.0", { dependencies: { foo: "^0.9.0" } }) });
      git(path, "tag", "v1.0.0");
      git(path, "checkout", "--quiet", "-b", "next");
      const task = commit(path, "chore(deps): move to foo 1 (#2)", { "package.json": manifest("next-partly-synced", "1.0.0", { dependencies: { foo: "^1.0.0" } }) });
      git(path, "checkout", "--quiet", "main");
      git(path, "merge", "--quiet", "--squash", "next");
      const squash = commit(path, "chore(deps): move to foo 1 (#3)", {});
      git(path, "checkout", "--quiet", "next");
      git(path, "merge", "--quiet", "--no-ff", "-m", "chore: merge main into next", "main");
      git(path, "checkout", "--quiet", "main");
      commit(path, "chore(deps): move to foo 1.1 (#4)", { "package.json": manifest("next-partly-synced", "1.0.0", { dependencies: { foo: "^1.1.0" } }) });
      git(path, "checkout", "--quiet", "next");
      git(path, "merge", "--quiet", "--no-ff", "-m", "chore: merge main into next", "main");
      commit(path, "chore(deps): go back to foo 1.0 (#5)", { "package.json": manifest("next-partly-synced", "1.0.0", { dependencies: { foo: "^1.0.0" } }) });
      git(path, "checkout", "--quiet", "main");
      commit(path, "chore(release): v1.0.1", { "package.json": manifest("next-partly-synced", "1.0.1", { dependencies: { foo: "^1.1.0" } }) });
      git(path, "tag", "v1.0.1");
      pulls["AntelopeJS/next-partly-synced"] = [{ number: 3, mergeCommit: { oid: squash }, headRefOid: task }];
    });
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", "--ref", "next", synced], system), 0);
    assert.ok(
      output().includes(`1. @antelopejs/next-partly-synced 1.0.1 -> 1.0.2 (patch)  AntelopeJS/next-partly-synced@${short(tip(synced, "next"))}\n     moves dependencies foo ^1.1.0 -> ^1.0.0\n`),
      output(),
    );
  });

  test("a sibling whose package.json at the stable tag is no JSON or holds no semver version blocks no plan", () => {
    for (const [name, broken] of [["unparsed", "{ not json\n"], ["unversioned", manifest("unversioned-sibling", "0.10")]] as const) {
      const workspace = repository(`workspace-${name}-sibling`, (path) => {
        commit(path, "feat: first", {
          "package.json": { name: `workspace-${name}-sibling`, private: true },
          "packages/a/package.json": broken,
          "packages/a/.release-it.json": { git: { tagName: "a-v${version}" } },
          "packages/b/package.json": manifest(`${name}-dependent`, "0.12.1", { dependencies: { [`@antelopejs/${name}-sibling`]: "workspace:^" } }),
          "packages/b/.release-it.json": { git: { tagName: "b-v${version}" } },
        });
        git(path, "tag", "b-v0.12.1");
        commit(path, "fix(a): repair the manifest", { "packages/a/package.json": manifest(`${name}-sibling`, "0.10.0") });
        git(path, "tag", "a-v0.10.0");
        commit(path, "fix(b): patch", { "packages/b/index.ts": "export {};\n" });
      });
      const { system, output, errors } = fakeSystem();
      assert.equal(main(["plan", workspace], system), 0, errors());
      assert.ok(output().includes(`1. @antelopejs/${name}-dependent 0.12.1 -> 0.12.2 (patch)`), output());
    }
  });

  test("a sibling whose package.json at the stable tag names no version blocks no plan", () => {
    const workspace = repository("workspace-unversioned", (path) => {
      commit(path, "feat: first", {
        "package.json": { name: "workspace-unversioned", private: true },
        "packages/a/package.json": { name: "@antelopejs/unversioned-a", private: true },
        "packages/a/.release-it.json": { git: { tagName: "a-v${version}" } },
        "packages/b/package.json": manifest("unversioned-b", "0.12.1"),
        "packages/b/.release-it.json": { git: { tagName: "b-v${version}" } },
      });
      git(path, "tag", "b-v0.12.1");
      commit(path, "feat(a): first release", { "packages/a/package.json": manifest("unversioned-a", "0.1.0") });
      git(path, "tag", "a-v0.1.0");
      commit(path, "fix(b): patch", { "packages/b/index.ts": "export {};\n" });
    });
    const { system, output, errors } = fakeSystem();
    assert.equal(main(["plan", workspace], system), 0, errors());
    assert.equal(
      output(),
      [
        "Release plan from main, 1 package: 1 to release",
        "",
        `1. @antelopejs/unversioned-b 0.12.1 -> 0.12.2 (patch)  AntelopeJS/workspace-unversioned:packages/b@${short(tip(workspace))}`,
        "     fix(b): patch",
        "Unchanged: @antelopejs/unversioned-a",
        "",
      ].join("\n"),
    );
  });

  test("--ref next counts neither a squashed pull request nor the one that reverts it, in the level or the notes", () => {
    type Stack = "none" | "fix-on-removal" | "removal-on-fix" | "removal-on-grown-fix";
    const cycle = (name: string, reverts: (squash: string) => string, listed: boolean, stack: Stack) =>
      repository(name, (path) => {
        commit(path, "feat: first", { "package.json": manifest(name, "0.5.2"), "src/rows.ts": "export const rows = 1;\n" });
        git(path, "tag", "v0.5.2");
        git(path, "checkout", "--quiet", "-b", "next");
        const task = (branch: string, base: string | null, subject: string, files: Record<string, string>): string => {
          git(path, "checkout", "--quiet", ...(base === null ? [branch] : ["-b", branch, base]));
          return commit(path, subject, files);
        };
        const squash = (branch: string, title: string): string => {
          git(path, "checkout", "--quiet", "next");
          git(path, "merge", "--quiet", "--squash", branch);
          return commit(path, title, {});
        };
        const removalTask = (base: string) => task("remove", base, "refactor(builder)!: remove the sample rows", { "src/rows.ts": "export {};\n" });
        const fixTask = (base: string | null) => task("fix", base, "fix(builder): close the cursor", { "src/cursor.ts": "export {};\n" });
        const squashRemoval = () => squash("remove", "refactor(builder)!: remove the sample rows (#1093)");
        const squashFix = () => squash("fix", "fix(builder): close the cursor (#1094)");
        const { removal, fix } = {
          none: () => {
            const removal = { head: removalTask("next"), squash: squashRemoval() };
            return { removal, fix: { head: fixTask("next"), squash: squashFix() } };
          },
          "fix-on-removal": () => {
            const removal = { head: removalTask("next"), squash: squashRemoval() };
            return { removal, fix: { head: fixTask("remove"), squash: squashFix() } };
          },
          "removal-on-fix": () => {
            const fix = { head: fixTask("next"), squash: squashFix() };
            return { fix, removal: { head: removalTask("fix"), squash: squashRemoval() } };
          },
          "removal-on-grown-fix": () => {
            task("fix", "next", "feat(builder): add paging", { "src/paging.ts": "export {};\n" });
            const head = removalTask("fix");
            const fix = { head: fixTask(null), squash: squashFix() };
            return { fix, removal: { head, squash: squashRemoval() } };
          },
        }[stack]();
        const restore = {
          head: task("restore", "next", `revert: remove the sample rows (#1093)\n\nThis reverts commit ${removal.squash.slice(0, 9)}.`, { "src/rows.ts": "export const rows = 1;\n" }),
          squash: squash("restore", `refactor(builder): restore the sample rows (#1098)\n\nPuts it back.\n\n${reverts(removal.squash)}`),
        };
        git(path, "checkout", "--quiet", "main");
        const merged = [removal, fix, restore].map(({ head, squash }, index) => ({ number: [1093, 1094, 1098][index], mergeCommit: { oid: squash }, headRefOid: head }));
        pulls[`AntelopeJS/${name}`] = listed ? merged : [];
      });
    const both = (name: string) => (squash: string) => `This reverts commit ${squash}.\nReverts AntelopeJS/${name}#1093`;
    const runs: [string, (squash: string) => string, boolean, string[], Stack][] = [
      ["revert-both", both("revert-both"), true, ["fix(builder): close the cursor"], "none"],
      ["revert-pull", () => "Reverts AntelopeJS/revert-pull#1093", false, ["fix(builder): close the cursor (#1094)"], "none"],
      ["revert-stacked", both("revert-stacked"), true, ["fix(builder): close the cursor"], "fix-on-removal"],
      ["revert-under", both("revert-under"), true, ["fix(builder): close the cursor"], "removal-on-fix"],
      ["revert-grown", both("revert-grown"), true, ["fix(builder): close the cursor", "feat(builder): add paging"], "removal-on-grown-fix"],
    ];
    for (const [name, reverts, listed, notes, stack] of runs) {
      const reverted = cycle(name, reverts, listed, stack);
      const { system, output } = fakeSystem();
      assert.equal(main(["plan", "--ref", "next", reverted], system), 0);
      assert.equal(
        output(),
        [
          "Release plan from next, 1 package: 1 to release",
          "",
          `1. @antelopejs/${name} 0.5.2 -> 0.5.3 (patch)  AntelopeJS/${name}@${short(tip(reverted, "next"))}`,
          ...notes.map((note) => `     ${note}`),
          "",
        ].join("\n"),
        name,
      );
    }
  });

  test("a promotion titled with the ! of a reverted commit releases at the level of the commits left, on main and on next", () => {
    const promoted = (name: string, extra: string | null) =>
      repository(name, (path) => {
        commit(path, "feat: first", { "package.json": manifest(name, "0.5.1"), "src/rows.ts": "export const rows = 1;\n" });
        git(path, "tag", "v0.5.1");
        git(path, "checkout", "--quiet", "-b", "next");
        commit(path, "fix(builder): close the cursor (#1094)", { "src/cursor.ts": "export {};\n" });
        const removal = commit(path, "refactor(builder)!: remove the sample rows (#1093)", { "src/rows.ts": "export {};\n" });
        commit(path, `refactor(builder): restore the sample rows (#1098)\n\nThis reverts commit ${removal}.\nReverts AntelopeJS/${name}#1093`, { "src/rows.ts": "export const rows = 1;\n" });
        if (extra !== null) commit(path, extra, { "src/api.ts": "export {};\n" });
        const head = git(path, "rev-parse", "HEAD");
        git(path, "checkout", "--quiet", "main");
        commit(path, "fix(io): retry the reads (#1100)", { "src/io.ts": "export {};\n" });
        git(path, "merge", "--quiet", "--squash", "next");
        const squash = commit(path, `feat!: promote next to main (#1114)\n\n- fix(builder): close the cursor (#1094)\n- refactor(builder)!: remove the sample rows (#1093)\n- refactor(builder): restore the sample rows (#1098)`, {});
        pulls[`AntelopeJS/${name}`] = [{ number: 1114, mergeCommit: { oid: squash }, headRefOid: head, headRefName: "next" }];
      });
    const level = (repo: string, args: string[]): string => {
      const { system, output } = fakeSystem();
      assert.equal(main(["plan", ...args, repo], system), 0);
      return /\((minor|patch)\)/.exec(output())?.[1] ?? output();
    };
    const synced = (repo: string): string => {
      git(repo, "checkout", "--quiet", "next");
      git(repo, "merge", "--quiet", "--no-ff", "-m", "Merge main into next", "main");
      git(repo, "checkout", "--quiet", "main");
      return repo;
    };
    const reverted = promoted("promoted-reverted", null);
    assert.deepEqual([level(reverted, []), level(reverted, ["--ref", "next"]), level(synced(reverted), ["--ref", "next"])], ["patch", "patch", "patch"]);
    const breaking = promoted("promoted-breaking", "feat(api)!: rename read to fetch (#1101)");
    assert.deepEqual([level(breaking, []), level(breaking, ["--ref", "next"]), level(synced(breaking), ["--ref", "next"])], ["minor", "minor", "minor"]);
  });

  test("a task pull request branched after a reverted pair keeps the level of its title", () => {
    const titled = repository("titled-after-revert", (path) => {
      commit(path, "feat: first", { "package.json": manifest("titled-after-revert", "0.5.1") });
      git(path, "tag", "v0.5.1");
      const removal = commit(path, "refactor!: remove the rows (#1)", { "src/rows.ts": "export {};\n" });
      commit(path, `revert: restore the rows (#2)\n\nThis reverts commit ${removal}.`, { "src/rows.ts": "export const rows = 1;\n" });
      git(path, "checkout", "--quiet", "-b", "task");
      const head = commit(path, "wip", { "src/api.ts": "export {};\n" });
      git(path, "checkout", "--quiet", "main");
      git(path, "merge", "--quiet", "--squash", "task");
      const squash = commit(path, "feat(api)!: rename read to fetch (#3)", {});
      pulls["AntelopeJS/titled-after-revert"] = [{ number: 3, mergeCommit: { oid: squash }, headRefOid: head }];
    });
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", titled], system), 0);
    assert.match(output(), /0\.5\.1 -> 0\.6\.0 \(minor\)/);
  });

  test("a task pull request keeps its title's level over a reverted pair of a lower level in its own or a stacked branch", () => {
    const titled = (name: string, stacked: boolean) =>
      repository(name, (path) => {
        commit(path, "feat: first", { "package.json": manifest(name, "0.5.1") });
        git(path, "tag", "v0.5.1");
        git(path, "checkout", "--quiet", "-b", "a");
        const tried = commit(path, "fix: try", { "src/a.ts": "export const a = 1;\n" });
        commit(path, `revert: drop the try\n\nThis reverts commit ${tried}.`, { "src/a.ts": "export {};\n" });
        const a = commit(path, "fix: real", { "src/real.ts": "export {};\n" });
        if (stacked) {
          git(path, "checkout", "--quiet", "main");
          git(path, "merge", "--quiet", "--squash", "a");
          const squashA = commit(path, "fix: a (#1)", {});
          git(path, "checkout", "--quiet", "-b", "b", a);
          const b = commit(path, "wip", { "src/api.ts": "export {};\n" });
          git(path, "checkout", "--quiet", "main");
          git(path, "merge", "--quiet", "--squash", "b");
          const squashB = commit(path, "feat(api)!: rename read to fetch (#2)", {});
          pulls[`AntelopeJS/${name}`] = [{ number: 2, mergeCommit: { oid: squashB }, headRefOid: b }, { number: 1, mergeCommit: { oid: squashA }, headRefOid: a }];
        } else {
          const head = commit(path, "wip", { "src/api.ts": "export {};\n" });
          git(path, "checkout", "--quiet", "main");
          git(path, "merge", "--quiet", "--squash", "a");
          const squash = commit(path, "feat(api)!: rename read to fetch (#3)", {});
          pulls[`AntelopeJS/${name}`] = [{ number: 3, mergeCommit: { oid: squash }, headRefOid: head }];
        }
      });
    for (const [name, stacked] of [["titled-own-pair", false], ["titled-stacked-pair", true]] as const) {
      const { system, output } = fakeSystem();
      assert.equal(main(["plan", titled(name, stacked)], system), 0);
      assert.match(output(), /0\.5\.1 -> 0\.6\.0 \(minor\)/, name);
    }
  });

  test("--ref next moves a pin to the stable release that shipped the pinned commit through a promotion", () => {
    const ids = { task: "" };
    const dependency = repository("next-shipped", (path) => {
      commit(path, "feat: first", { "package.json": manifest("next-shipped", "1.0.0") });
      git(path, "tag", "v1.0.0");
      git(path, "checkout", "--quiet", "-b", "next");
      ids.task = commit(path, "feat: add the cursor (#2)", { "src/cursor.ts": "export {};\n" });
      git(path, "checkout", "--quiet", "main");
      git(path, "merge", "--quiet", "--squash", "next");
      const squash = commit(path, "feat: add the cursor (#3)", {});
      commit(path, "chore(release): v1.0.1", { "package.json": manifest("next-shipped", "1.0.1") });
      git(path, "tag", "v1.0.1");
      git(path, "checkout", "--quiet", "next");
      commit(path, "ci: cache the store (#4)", { "ci.txt": "x\n" });
      git(path, "checkout", "--quiet", "main");
      pulls["AntelopeJS/next-shipped"] = [{ number: 3, mergeCommit: { oid: squash }, headRefOid: ids.task }];
    });
    const dependent = repository("next-pinning", (path) => {
      commit(path, "feat: first", { "package.json": manifest("next-pinning", "2.0.0") });
      git(path, "tag", "v2.0.0");
      git(path, "checkout", "--quiet", "-b", "next");
      commit(path, "fix: read with the cursor (#5)", { "package.json": manifest("next-pinning", "2.0.0", { dependencies: { "@antelopejs/next-shipped": `1.0.1-next.3.g${short(ids.task)}` } }) });
      git(path, "checkout", "--quiet", "main");
    });
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", "--ref", "next", dependency, dependent], system), 0);
    assert.equal(
      output(),
      [
        "Release plan from next, 1 package: 1 to release",
        "",
        `1. @antelopejs/next-pinning 2.0.0 -> 2.0.1 (patch)  AntelopeJS/next-pinning@${short(tip(dependent, "next"))}`,
        "     fix: read with the cursor (#5)",
        `     @antelopejs/next-shipped 1.0.1-next.3.g${short(ids.task)} -> >=1.0.1 <1.1.0`,
        "Unchanged: @antelopejs/next-shipped, only ci commits since 1.0.1",
        "",
      ].join("\n"),
    );
  });

  test("a blob:none clone keeps the squash commit of a pull request whose head it lacks, and fetches nothing", () => {
    const ids = { squash: "", head: "" };
    const remote = repository("partial-remote", (path) => {
      git(path, "config", "uploadpack.allowFilter", "true");
      git(path, "config", "uploadpack.allowAnySHA1InWant", "true");
      commit(path, "feat: first", { "package.json": manifest("partial", "0.1.0") });
      git(path, "tag", "v0.1.0");
      git(path, "checkout", "--quiet", "-b", "task");
      ids.head = commit(path, "fix(io): wip", { "src/io.ts": "export {};\n" });
      git(path, "update-ref", "refs/pull/7/head", ids.head);
      git(path, "checkout", "--quiet", "main");
      git(path, "branch", "--quiet", "-D", "task");
      ids.squash = commit(path, "fix(io): retry the reads (#7)", { "src/io.ts": "export {};\n" });
    });
    const clone = join(dirname(remote), "partial-clone");
    git(dirname(remote), "clone", "--quiet", "--filter=blob:none", `file://${remote}`, clone);
    const { system } = fakeSystem();
    const from = { repository: clone, slug: "AntelopeJS/partial", local: true };
    const merged = [{ number: 7, mergeCommit: ids.squash, head: ids.head, branch: "" }];
    const revision = resolveRevision(system, from, null);
    const source = readSource(system, from, revision, { directory: ".", nested: [], siblings: [], merged, releases: revision.name });
    assert.deepEqual(source.notes.map((note) => note.subject), ["fix(io): retry the reads (#7)"]);
    assert.notEqual(spawnSync("git", ["-C", clone, "--no-lazy-fetch", "cat-file", "-e", `${ids.head}^{commit}`]).status, 0);
  });

  test("moves a pin only when the branch of its dependency holds the preview's commit", () => {
    const pinning = repository("pinning", (path) => {
      commit(path, "feat: first", { "package.json": manifest("pinning", "0.1.0") });
      git(path, "tag", "v0.1.0");
      commit(path, "chore: pin the mongodb previews", {
        "package.json": manifest("pinning", "0.1.0", {
          dependencies: { "@antelopejs/mongodb": `1.8.7-next.41.g${short(commits.later)}` },
          peerDependencies: { "@antelopejs/mongodb": "1.8.7-next.9.gabc1234" },
          optionalDependencies: { "@antelopejs/mongodb": `1.8.7-next.40.g${short(commits.feed)}` },
        }),
      });
      git(path, "branch", "next");
    });
    const reasons = (ref: string[], gh: { down?: boolean } = {}): string[] => {
      const { system, output } = fakeSystem({}, gh);
      main(["plan", ...ref, interfaceDatabase, mongodb, pinning], system);
      return output().split("\n").filter((line) => line.startsWith("     depends on"));
    };
    const later = `     depends on preview @antelopejs/mongodb@1.8.7-next.41.g${short(commits.later)}, whose main does not contain commit ${short(commits.later)}`;
    const unknown = "     depends on preview @antelopejs/mongodb@1.8.7-next.9.gabc1234, whose main does not contain commit abc1234";
    assert.deepEqual(reasons([]), [later, unknown]);
    assert.deepEqual(reasons(["--ref", "next"]), [unknown.replace("main", "next")]);
    const down = fakeSystem({}, { down: true });
    assert.equal(main(["plan", interfaceDatabase, mongodb, pinning], down.system), 1);
    assert.match(down.errors(), /^gh pr list --repo AntelopeJS\/interface-database --base main failed/);
  });
  test("a promotion releases at the level of the commits it brought, whatever its title", () => {
    const promoted = (name: string, title: string) =>
      repository(name, (path) => {
        commit(path, "feat: first", { "package.json": manifest(name, "0.4.2") });
        git(path, "tag", "v0.4.2");
        git(path, "checkout", "--quiet", "-b", "next");
        commit(path, "feat(query)!: rename ReadCursor.next to ReadCursor.read", { "src/cursor.ts": "export {};\n" });
        const head = commit(path, "fix(query): batch reads", { "src/batch.ts": "export {};\n" });
        git(path, "checkout", "--quiet", "main");
        git(path, "merge", "--quiet", "--squash", "next");
        git(path, "commit", "--quiet", "-m", title, "-m", "Batch reads and cursor fixes for the next cycle.");
        pulls[`AntelopeJS/${name}`] = [{ number: 122, mergeCommit: { oid: git(path, "rev-parse", "HEAD") }, headRefOid: head }];
      });
    const plan = (path: string): string => {
      const { system, output } = fakeSystem();
      assert.equal(main(["plan", path], system), 0);
      return output().split("\n").slice(2, 6).join("\n");
    };
    const titled = promoted("promotion-titled", "feat(query): batch reads and cursor fixes (#122)");
    assert.equal(
      plan(titled),
      [
        `1. @antelopejs/promotion-titled 0.4.2 -> 0.5.0 (minor)  AntelopeJS/promotion-titled@${short(tip(titled))}`,
        "     fix(query): batch reads",
        "     feat(query)!: rename ReadCursor.next to ReadCursor.read",
        "",
      ].join("\n"),
    );
    const untitled = promoted("promotion-untitled", "Promote next to main (#122)");
    assert.match(plan(untitled), /^1\. @antelopejs\/promotion-untitled 0\.4\.2 -> 0\.5\.0 \(minor\) /);

    const firstHead = tip(untitled, "next");
    commit(untitled, "chore(release): v0.5.0", { "package.json": manifest("promotion-untitled", "0.5.0") });
    git(untitled, "tag", "v0.5.0");
    git(untitled, "checkout", "--quiet", "next");
    git(untitled, "merge", "--quiet", "--no-ff", "--no-edit", "main");
    const secondHead = commit(untitled, "fix(query): close the cursor", { "src/close.ts": "export {};\n" });
    git(untitled, "checkout", "--quiet", "main");
    git(untitled, "merge", "--quiet", "--squash", "next");
    git(untitled, "commit", "--quiet", "-m", "Promote next to main (#130)");
    git(untitled, "update-ref", "refs/remotes/origin/main", "HEAD");
    pulls["AntelopeJS/promotion-untitled"] = [
      { number: 130, mergeCommit: { oid: tip(untitled) }, headRefOid: secondHead },
      { number: 122, mergeCommit: { oid: git(untitled, "rev-parse", "v0.5.0^") }, headRefOid: firstHead },
    ];
    assert.equal(
      plan(untitled),
      [
        `1. @antelopejs/promotion-untitled 0.5.0 -> 0.5.1 (patch)  AntelopeJS/promotion-untitled@${short(tip(untitled))}`,
        "     fix(query): close the cursor",
        "",
      ].join("\n"),
    );
  });

  test("a pin moves to an unchanged dependency's stable only when that stable tag holds the preview's commit", () => {
    let cursor = "";
    const dependency = repository("hotfixed", (path) => {
      commit(path, "feat: first", { "package.json": manifest("hotfixed", "0.4.1") });
      git(path, "tag", "v0.4.1");
      git(path, "checkout", "--quiet", "-b", "next");
      cursor = commit(path, "chore(cursor): add the cursor", { "src/cursor.ts": "export {};\n" });
      git(path, "checkout", "--quiet", "main");
      commit(path, "fix: hotfix", { "src/hotfix.ts": "export {};\n" });
      commit(path, "chore(release): v0.4.2", { "package.json": manifest("hotfixed", "0.4.2") });
      git(path, "tag", "v0.4.2");
      git(path, "merge", "--quiet", "--squash", "next");
      git(path, "commit", "--quiet", "-m", "chore: promote next (#9)");
      pulls["AntelopeJS/hotfixed"] = [{ number: 9, mergeCommit: { oid: git(path, "rev-parse", "HEAD") }, headRefOid: cursor }];
    });
    const dependent = repository("pins-hotfixed", (path) => {
      commit(path, "feat: first", { "package.json": manifest("pins-hotfixed", "1.8.6", { dependencies: { "@antelopejs/hotfixed": `0.4.2-next.2.g${short(cursor)}` } }) });
      git(path, "tag", "v1.8.6");
      commit(path, "fix: x", { "x.ts": "export {};\n" });
    });
    const plan = (): string => {
      const { system, output } = fakeSystem();
      assert.equal(main(["plan", dependency, dependent], system), 0);
      return output();
    };
    assert.match(plan(), new RegExp(`\n     depends on preview @antelopejs/hotfixed@0\\.4\\.2-next\\.2\\.g${short(cursor)}, whose stable 0\\.4\\.2 does not contain commit ${short(cursor)}\n`));
    commit(dependency, "chore(release): v0.4.3", { "package.json": manifest("hotfixed", "0.4.3") });
    git(dependency, "tag", "v0.4.3");
    git(dependency, "update-ref", "refs/remotes/origin/main", "HEAD");
    assert.match(plan(), new RegExp(`\n     @antelopejs/hotfixed 0\\.4\\.2-next\\.2\\.g${short(cursor)} -> >=0\\.4\\.3 <0\\.5\\.0\n`));
  });

  test("the release commits of a nested package give the root package no release", () => {
    const workspace = repository("nested-release", (path) => {
      commit(path, "feat: first", {
        "package.json": manifest("nested-root", "0.20.2"),
        "packages/automation/package.json": manifest("nested-automation", "0.11.1", { dependencies: { "@antelopejs/x": "0.2.0-next.1.gabc1234" } }),
        "packages/automation/.release-it.json": { git: { tagName: "automation-v${version}" } },
      });
      git(path, "tag", "v0.20.2");
      git(path, "tag", "automation-v0.11.1");
      commit(path, "fix(deps): depend on the stable @antelopejs/x", {
        "packages/automation/package.json": manifest("nested-automation", "0.11.1", { dependencies: { "@antelopejs/x": ">=0.2.0 <0.3.0" } }),
        "pnpm-lock.yaml": "x\n",
      });
      commit(path, "chore(release): v0.11.2", { "packages/automation/package.json": manifest("nested-automation", "0.11.2"), "packages/automation/CHANGELOG.md": "x\n" });
      git(path, "tag", "automation-v0.11.2");
    });
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", workspace, `${workspace}:packages/automation`], system), 0);
    assert.equal(output(), "Release plan from main, nothing to release\n\nUnchanged: @antelopejs/nested-root, @antelopejs/nested-automation\n");
  });

  test("a local checkout whose origin/next lacks the promotion's head stops the plan instead of reading the title alone", () => {
    const ids = { squash: "", head: "" };
    const remote = repository("stale", (path) => {
      commit(path, "feat: first", { "package.json": manifest("stale", "0.4.2") });
      git(path, "tag", "v0.4.2");
      git(path, "branch", "next");
    });
    const clone = join(dirname(remote), "stale-clone");
    git(dirname(remote), "clone", "--quiet", `file://${remote}`, clone);
    git(clone, "remote", "set-url", "origin", "https://github.com/AntelopeJS/stale.git");
    git(remote, "checkout", "--quiet", "next");
    ids.head = commit(remote, "feat(query)!: rename ReadCursor.next to ReadCursor.read", { "src/cursor.ts": "export {};\n" });
    git(remote, "checkout", "--quiet", "main");
    git(remote, "merge", "--quiet", "--squash", "next");
    git(remote, "commit", "--quiet", "-m", "feat(query): batch reads and cursor fixes (#122)");
    ids.squash = tip(remote);
    git(clone, "fetch", "--quiet", `file://${remote}`, "main:refs/remotes/origin/main");
    pulls["AntelopeJS/stale"] = [{ number: 122, mergeCommit: { oid: ids.squash }, headRefOid: ids.head, headRefName: "main" }];
    const elsewhere = fakeSystem();
    assert.equal(main(["plan", clone], elsewhere.system), 0, "a fork's or a reused branch's head that GitHub's branch does not hold keeps the squash commit");
    assert.match(elsewhere.output(), /0\.4\.2 -> 0\.4\.3 \(patch\)/);
    pulls["AntelopeJS/stale"] = [{ number: 122, mergeCommit: { oid: ids.squash }, headRefOid: ids.head, headRefName: "next" }];
    const unreachable = fakeSystem({}, { compareDown: true });
    assert.equal(main(["plan", clone], unreachable.system), 1);
    assert.match(unreachable.errors(), new RegExp(`^gh api repos/AntelopeJS/stale/compare/${ids.head}\\.\\.\\.next failed, so the plan cannot tell whether next holds commit ${short(ids.head)}\\n`));
    const { system, errors } = fakeSystem();
    assert.equal(main(["plan", clone], system), 1);
    assert.equal(
      errors(),
      `${clone} lacks commit ${short(ids.head)}, the head of pull request #122 from next, so its origin/next is stale. Run git fetch origin there, then plan again.\n`,
    );
    git(clone, "fetch", "--quiet", `file://${remote}`, "next:refs/remotes/origin/next");
    const fetched = fakeSystem();
    assert.equal(main(["plan", clone], fetched.system), 0);
    assert.match(fetched.output(), /0\.4\.2 -> 0\.5\.0 \(minor\)/);
  });
});

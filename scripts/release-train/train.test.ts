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
    const source = readSource(system, from, revision, { directory: ".", nested: [], merged, releases: revision.name });
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

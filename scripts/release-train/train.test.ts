import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { commit, commits, dispatches, dms, dmsDatabase, expectedPlan, fakeSystem, git, interfaceDatabase, manifest, mongodb, pulls, repository, short, tip } from "./fixtures.ts";
import { main } from "./train.ts";

describe("plan", () => {
  test("reads each checkout at its default branch and prints the plan", () => {
    const { system, calls, output } = fakeSystem();
    const status = main(["plan", dmsDatabase, mongodb, interfaceDatabase, `${dms}:packages/automation`], system);
    assert.equal(status, 0);
    assert.equal(output(), expectedPlan());
    assert.deepEqual(dispatches(calls), []);
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
        "Unchanged: @antelopejs/dms-database",
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
    assert.equal(main(["plan", promoted], offline.system), 0);
    assert.match(offline.output(), /\(patch\)  \S+\n {5}fix\(io\): retry the reads \(#17\)\n {5}fix: promote next \(#16\)\n$/);
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
    const squashed = `     depends on preview @antelopejs/mongodb@1.8.7-next.40.g${short(commits.feed)}, whose main does not contain commit ${short(commits.feed)}`;
    assert.deepEqual(reasons([]), [later, unknown]);
    assert.deepEqual(reasons(["--ref", "next"]), [unknown.replace("main", "next")]);
    assert.deepEqual(reasons([], { down: true }), [later, unknown, squashed]);
  });
});

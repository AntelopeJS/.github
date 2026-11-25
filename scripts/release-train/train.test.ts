import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { commit, commits, dispatches, dms, dmsDatabase, expectedPlan, fakeSystem, git, interfaceDatabase, manifest, mongodb, pulls, repository, short, tip } from "./fixtures.ts";
import { main } from "./train.ts";

function registerCheckoutPlanTests(): void {
  test("reads each checkout at its default branch and prints the plan", () => {
    const { system, calls, output } = fakeSystem();
    const status = main(["plan", dmsDatabase, mongodb, interfaceDatabase, `${dms}:packages/automation`], system);
    assert.equal(status, 0);
    assert.equal(output(), expectedPlan());
    assert.deepEqual(dispatches(calls), []);
  });

  test("plans each main since its last stable tag, the dependency first, and moves a pin of a preview built on the dependency's main to its stable range", () => {
    const ids = { preview: "", count: "" };
    const dependency = repository("trunk-interface", (path) => {
      commit(path, "feat: first", { "package.json": manifest("trunk-interface", "0.4.1") });
      commit(path, "fix(query): trim the rows", { "src/rows.ts": "export {};\n" });
      commit(path, "chore(release): v0.4.2", { "package.json": manifest("trunk-interface", "0.4.2") });
      git(path, "tag", "v0.4.2");
      ids.preview = commit(path, "fix(query): close the cursor (#21)", { "src/cursor.ts": "export {};\n" });
      ids.count = git(path, "rev-list", "--count", ids.preview);
      commit(path, "ci: cache the store (#22)", { "ci.txt": "x\n" });
    });
    const pin = `0.4.3-next.${ids.count}.g${short(ids.preview)}`;
    const dependent = repository("trunk-dependent", (path) => {
      commit(path, "feat: first", { "package.json": manifest("trunk-dependent", "1.2.0", { dependencies: { "@antelopejs/trunk-interface": ">=0.4.2 <0.5.0" } }) });
      git(path, "tag", "v1.2.0");
      commit(path, "fix(api): read with the cursor (#8)", {
        "package.json": manifest("trunk-dependent", "1.2.0", { dependencies: { "@antelopejs/trunk-interface": pin } }),
      });
    });
    const { system, output, errors } = fakeSystem();
    assert.equal(main(["plan", dependent, dependency], system), 0, errors());
    assert.equal(
      output(),
      [
        "Release plan from main, 2 packages: 2 to release",
        "",
        `1. @antelopejs/trunk-interface 0.4.2 -> 0.4.3 (patch)  AntelopeJS/trunk-interface@${short(tip(dependency))}`,
        "     fix(query): close the cursor (#21)",
        `2. @antelopejs/trunk-dependent 1.2.0 -> 1.2.1 (patch)  AntelopeJS/trunk-dependent@${short(tip(dependent))}`,
        "     fix(api): read with the cursor (#8)",
        `     @antelopejs/trunk-interface ${pin} -> >=0.4.3 <0.5.0`,
        "",
      ].join("\n"),
    );
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
}

function registerStableTagTests(): void {
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
      commit(path, "feat(interface)!: rename the plans", { "packages/interface-x/index.ts": "export {};\n" });
    });
    const planned = fakeSystem();
    assert.equal(main(["plan", workspace], planned.system), 0, planned.errors());
    assert.equal(
      planned.output(),
      [
        "Release plan from main, 2 packages: 2 to release",
        "",
        `1. @antelopejs/interface-x 0.10.0 -> 0.11.0 (minor)  AntelopeJS/workspace-root:packages/interface-x@${short(tip(workspace))}`,
        "     feat(interface)!: rename the plans",
        `2. @antelopejs/x 0.12.1 -> 0.12.2 (patch)  AntelopeJS/workspace-root:packages/x@${short(tip(workspace))}`,
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
}

function registerCycleTaskTests(): void {
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

  test("plan and go refuse --ref, read nothing and dispatch nothing", () => {
    for (const action of ["plan", "go"]) {
      const { system, calls, output, errors } = fakeSystem();
      assert.equal(main([action, "--ref", "next", mongodb], system), 1, action);
      assert.equal(errors(), `The release train reads only the default branch, so ${action} takes no --ref.\n`, action);
      assert.equal(output(), "", action);
      assert.deepEqual(calls, [], action);
    }
  });

  test("lists the tasks of the cycle from the heads of the pull requests merged since the stable tag", () => {
    const promoted = repository("promoted", (path) => {
      commit(path, "feat: first", { "package.json": manifest("promoted", "0.3.0") });
      git(path, "tag", "v0.3.0");
      git(path, "checkout", "--quiet", "-b", "query");
      const earlier = commit(path, "feat(query): hand over rows in batches (#11)", { "src/batch.ts": "export {};\n" }, "Alice");
      git(path, "checkout", "--quiet", "main");
      const earlierSquash = commit(path, "feat(query): hand over rows in batches (#12)", { "src/batch.ts": "export {};\n" });
      commit(path, "chore(release): v0.3.1", { "package.json": manifest("promoted", "0.3.1") }, "github-actions[bot]");
      git(path, "tag", "v0.3.1");
      git(path, "checkout", "--quiet", "query");
      git(path, "merge", "--quiet", "--no-ff", "-m", "Merge main into query", "main");
      commit(path, "fix(cursor): close the cursor on error (#13)", { "src/cursor.ts": "export {};\n" }, "Bob");
      commit(path, "chore: tidy the scripts (#14)", { "src/scripts.ts": "export {};\n" }, "Bob");
      const head = commit(path, "feat(api)!: rename read to fetch (#15)", { "src/api.ts": "export {};\n" }, "Alice");
      git(path, "checkout", "--quiet", "main");
      git(path, "merge", "--quiet", "--squash", "query");
      const squash = commit(path, "fix: tidy the query api (#16)", {});
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
}

function registerSiblingManifestTests(): void {
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
}

describe("plan", () => {
  registerCheckoutPlanTests();
  registerStableTagTests();
  registerCycleTaskTests();
  registerSiblingManifestTests();
});

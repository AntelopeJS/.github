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

  test("counts neither a squashed pull request nor the one that reverts it, in the level or the notes", () => {
    type Stack = "none" | "fix-on-removal" | "removal-on-fix" | "removal-on-grown-fix";
    const cycle = (name: string, reverts: (squash: string) => string, listed: boolean, stack: Stack) =>
      repository(name, (path) => {
        commit(path, "feat: first", { "package.json": manifest(name, "0.5.2"), "src/rows.ts": "export const rows = 1;\n" });
        git(path, "tag", "v0.5.2");
        const task = (branch: string, base: string | null, subject: string, files: Record<string, string>): string => {
          git(path, "checkout", "--quiet", ...(base === null ? [branch] : ["-b", branch, base]));
          return commit(path, subject, files);
        };
        const squash = (branch: string, title: string): string => {
          git(path, "checkout", "--quiet", "main");
          git(path, "merge", "--quiet", "--squash", branch);
          return commit(path, title, {});
        };
        const removalTask = (base: string) => task("remove", base, "refactor(builder)!: remove the sample rows", { "src/rows.ts": "export {};\n" });
        const fixTask = (base: string | null) => task("fix", base, "fix(builder): close the cursor", { "src/cursor.ts": "export {};\n" });
        const squashRemoval = () => squash("remove", "refactor(builder)!: remove the sample rows (#1093)");
        const squashFix = () => squash("fix", "fix(builder): close the cursor (#1094)");
        const { removal, fix } = {
          none: () => {
            const removal = { head: removalTask("main"), squash: squashRemoval() };
            return { removal, fix: { head: fixTask("main"), squash: squashFix() } };
          },
          "fix-on-removal": () => {
            const removal = { head: removalTask("main"), squash: squashRemoval() };
            return { removal, fix: { head: fixTask("remove"), squash: squashFix() } };
          },
          "removal-on-fix": () => {
            const fix = { head: fixTask("main"), squash: squashFix() };
            return { fix, removal: { head: removalTask("fix"), squash: squashRemoval() } };
          },
          "removal-on-grown-fix": () => {
            task("fix", "main", "feat(builder): add paging", { "src/paging.ts": "export {};\n" });
            const head = removalTask("fix");
            const fix = { head: fixTask(null), squash: squashFix() };
            return { fix, removal: { head, squash: squashRemoval() } };
          },
        }[stack]();
        const restore = {
          head: task("restore", "main", `revert: remove the sample rows (#1093)\n\nThis reverts commit ${removal.squash.slice(0, 9)}.`, { "src/rows.ts": "export const rows = 1;\n" }),
          squash: squash("restore", `refactor(builder): restore the sample rows (#1098)\n\nPuts it back.\n\n${reverts(removal.squash)}`),
        };
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
      assert.equal(main(["plan", reverted], system), 0);
      assert.equal(
        output(),
        [
          "Release plan from main, 1 package: 1 to release",
          "",
          `1. @antelopejs/${name} 0.5.2 -> 0.5.3 (patch)  AntelopeJS/${name}@${short(tip(reverted))}`,
          ...notes.map((note) => `     ${note}`),
          "",
        ].join("\n"),
        name,
      );
    }
  });

  test("a squash commit titled with the ! of a reverted commit of its branch releases at the level of the commits left", () => {
    const squashed = (name: string, extra: string | null) =>
      repository(name, (path) => {
        commit(path, "feat: first", { "package.json": manifest(name, "0.5.1"), "src/rows.ts": "export const rows = 1;\n" });
        git(path, "tag", "v0.5.1");
        git(path, "checkout", "--quiet", "-b", "builder");
        commit(path, "fix(builder): close the cursor (#1094)", { "src/cursor.ts": "export {};\n" });
        const removal = commit(path, "refactor(builder)!: remove the sample rows (#1093)", { "src/rows.ts": "export {};\n" });
        commit(path, `refactor(builder): restore the sample rows (#1098)\n\nThis reverts commit ${removal}.\nReverts AntelopeJS/${name}#1093`, { "src/rows.ts": "export const rows = 1;\n" });
        if (extra !== null) commit(path, extra, { "src/api.ts": "export {};\n" });
        const head = git(path, "rev-parse", "HEAD");
        git(path, "checkout", "--quiet", "main");
        commit(path, "fix(io): retry the reads (#1100)", { "src/io.ts": "export {};\n" });
        git(path, "merge", "--quiet", "--squash", "builder");
        const squash = commit(path, `feat!: rework the builder (#1114)\n\n- fix(builder): close the cursor (#1094)\n- refactor(builder)!: remove the sample rows (#1093)\n- refactor(builder): restore the sample rows (#1098)`, {});
        pulls[`AntelopeJS/${name}`] = [{ number: 1114, mergeCommit: { oid: squash }, headRefOid: head, headRefName: "builder" }];
      });
    const level = (repo: string): string => {
      const { system, output } = fakeSystem();
      assert.equal(main(["plan", repo], system), 0);
      return /\((minor|patch)\)/.exec(output())?.[1] ?? output();
    };
    assert.equal(level(squashed("squashed-reverted", null)), "patch");
    assert.equal(level(squashed("squashed-breaking", "feat(api)!: rename read to fetch (#1101)")), "minor");
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
    const from = { repository: clone, slug: "AntelopeJS/partial" };
    const merged = [{ number: 7, mergeCommit: ids.squash, head: ids.head, branch: "" }];
    const source = readSource(system, from, resolveRevision(system, from), { directory: ".", nested: [], siblings: [], merged });
    assert.deepEqual(source.notes.map((note) => note.subject), ["fix(io): retry the reads (#7)"]);
    assert.notEqual(spawnSync("git", ["-C", clone, "--no-lazy-fetch", "cat-file", "-e", `${ids.head}^{commit}`]).status, 0);
  });

  test("moves a pin only when the main of its dependency holds the preview's commit, itself or through a merged pull request's head", () => {
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
    });
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", interfaceDatabase, mongodb, pinning], system), 0);
    assert.deepEqual(
      output().split("\n").filter((line) => line.startsWith("     depends on")),
      [
        `     depends on preview @antelopejs/mongodb@1.8.7-next.41.g${short(commits.later)}, whose main does not contain commit ${short(commits.later)}`,
        "     depends on preview @antelopejs/mongodb@1.8.7-next.9.gabc1234, whose main does not contain commit abc1234",
      ],
    );
    const down = fakeSystem({}, { down: true });
    assert.equal(main(["plan", interfaceDatabase, mongodb, pinning], down.system), 1);
    assert.match(down.errors(), /^gh pr list --repo AntelopeJS\/interface-database --base main failed/);
  });
  test("a squash commit releases at the level of the commits its pull request brought, whatever its title", () => {
    const squashed = (name: string, title: string) =>
      repository(name, (path) => {
        commit(path, "feat: first", { "package.json": manifest(name, "0.4.2") });
        git(path, "tag", "v0.4.2");
        git(path, "checkout", "--quiet", "-b", "query");
        commit(path, "feat(query)!: rename ReadCursor.next to ReadCursor.read", { "src/cursor.ts": "export {};\n" });
        const head = commit(path, "fix(query): batch reads", { "src/batch.ts": "export {};\n" });
        git(path, "checkout", "--quiet", "main");
        git(path, "merge", "--quiet", "--squash", "query");
        git(path, "commit", "--quiet", "-m", title, "-m", "Batch reads and cursor fixes.");
        pulls[`AntelopeJS/${name}`] = [{ number: 122, mergeCommit: { oid: git(path, "rev-parse", "HEAD") }, headRefOid: head }];
      });
    const plan = (path: string): string => {
      const { system, output } = fakeSystem();
      assert.equal(main(["plan", path], system), 0);
      return output().split("\n").slice(2, 6).join("\n");
    };
    const titled = squashed("squash-titled", "feat(query): batch reads and cursor fixes (#122)");
    assert.equal(
      plan(titled),
      [
        `1. @antelopejs/squash-titled 0.4.2 -> 0.5.0 (minor)  AntelopeJS/squash-titled@${short(tip(titled))}`,
        "     fix(query): batch reads",
        "     feat(query)!: rename ReadCursor.next to ReadCursor.read",
        "",
      ].join("\n"),
    );
    const untitled = squashed("squash-untitled", "Batch reads (#122)");
    assert.match(plan(untitled), /^1\. @antelopejs\/squash-untitled 0\.4\.2 -> 0\.5\.0 \(minor\) /);

    const firstHead = git(untitled, "rev-parse", "query");
    commit(untitled, "chore(release): v0.5.0", { "package.json": manifest("squash-untitled", "0.5.0") });
    git(untitled, "tag", "v0.5.0");
    git(untitled, "checkout", "--quiet", "query");
    git(untitled, "merge", "--quiet", "--no-ff", "--no-edit", "main");
    const secondHead = commit(untitled, "fix(query): close the cursor", { "src/close.ts": "export {};\n" });
    git(untitled, "checkout", "--quiet", "main");
    git(untitled, "merge", "--quiet", "--squash", "query");
    git(untitled, "commit", "--quiet", "-m", "Close the cursor (#130)");
    git(untitled, "update-ref", "refs/remotes/origin/main", "HEAD");
    pulls["AntelopeJS/squash-untitled"] = [
      { number: 130, mergeCommit: { oid: tip(untitled) }, headRefOid: secondHead },
      { number: 122, mergeCommit: { oid: git(untitled, "rev-parse", "v0.5.0^") }, headRefOid: firstHead },
    ];
    assert.equal(
      plan(untitled),
      [
        `1. @antelopejs/squash-untitled 0.5.0 -> 0.5.1 (patch)  AntelopeJS/squash-untitled@${short(tip(untitled))}`,
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
      git(path, "checkout", "--quiet", "-b", "cursor");
      cursor = commit(path, "chore(cursor): add the cursor", { "src/cursor.ts": "export {};\n" });
      git(path, "checkout", "--quiet", "main");
      commit(path, "fix: hotfix", { "src/hotfix.ts": "export {};\n" });
      commit(path, "chore(release): v0.4.2", { "package.json": manifest("hotfixed", "0.4.2") });
      git(path, "tag", "v0.4.2");
      git(path, "merge", "--quiet", "--squash", "cursor");
      git(path, "commit", "--quiet", "-m", "chore(cursor): add the cursor (#9)");
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

  test("a local checkout whose origin/<branch> lacks the head of a merged pull request stops the plan instead of reading the title alone", () => {
    const ids = { squash: "", head: "" };
    const remote = repository("stale", (path) => {
      commit(path, "feat: first", { "package.json": manifest("stale", "0.4.2") });
      git(path, "tag", "v0.4.2");
      git(path, "branch", "query");
    });
    const clone = join(dirname(remote), "stale-clone");
    git(dirname(remote), "clone", "--quiet", `file://${remote}`, clone);
    git(clone, "remote", "set-url", "origin", "https://github.com/AntelopeJS/stale.git");
    git(remote, "checkout", "--quiet", "query");
    ids.head = commit(remote, "feat(query)!: rename ReadCursor.next to ReadCursor.read", { "src/cursor.ts": "export {};\n" });
    git(remote, "checkout", "--quiet", "main");
    git(remote, "merge", "--quiet", "--squash", "query");
    git(remote, "commit", "--quiet", "-m", "feat(query): batch reads and cursor fixes (#122)");
    ids.squash = tip(remote);
    git(clone, "fetch", "--quiet", `file://${remote}`, "main:refs/remotes/origin/main");
    pulls["AntelopeJS/stale"] = [{ number: 122, mergeCommit: { oid: ids.squash }, headRefOid: ids.head, headRefName: "main" }];
    const elsewhere = fakeSystem();
    assert.equal(main(["plan", clone], elsewhere.system), 0, "a fork's or a reused branch's head that GitHub's branch does not hold keeps the squash commit");
    assert.match(elsewhere.output(), /0\.4\.2 -> 0\.4\.3 \(patch\)/);
    pulls["AntelopeJS/stale"] = [{ number: 122, mergeCommit: { oid: ids.squash }, headRefOid: ids.head, headRefName: "query" }];
    const unreachable = fakeSystem({}, { compareDown: true });
    assert.equal(main(["plan", clone], unreachable.system), 1);
    assert.match(unreachable.errors(), new RegExp(`^gh api repos/AntelopeJS/stale/compare/${ids.head}\\.\\.\\.query failed, so the plan cannot tell whether query holds commit ${short(ids.head)}\\n`));
    const { system, errors } = fakeSystem();
    assert.equal(main(["plan", clone], system), 1);
    assert.equal(
      errors(),
      `${clone} lacks commit ${short(ids.head)}, the head of pull request #122 from query, so its origin/query is stale. Run git fetch origin there, then plan again.\n`,
    );
    git(clone, "fetch", "--quiet", `file://${remote}`, "query:refs/remotes/origin/query");
    const fetched = fakeSystem();
    assert.equal(main(["plan", clone], fetched.system), 0);
    assert.match(fetched.output(), /0\.4\.2 -> 0\.5\.0 \(minor\)/);
  });
});

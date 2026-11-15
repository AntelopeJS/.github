import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { RunResult, System } from "./system.ts";
import { main } from "./train.ts";

const root = mkdtempSync(join(tmpdir(), "release-train-"));
const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

function git(repository: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", repository, ...identity, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function commit(repository: string, message: string, files: Record<string, unknown>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repository, file)), { recursive: true });
    writeFileSync(join(repository, file), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "--allow-empty", "-m", message);
}

function repository(name: string, build: (path: string) => void): string {
  const path = join(root, name);
  mkdirSync(path);
  git(path, "init", "--quiet", "--initial-branch=main");
  git(path, "remote", "add", "origin", `https://github.com/AntelopeJS/${name}.git`);
  build(path);
  git(path, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return path;
}

function manifest(name: string, version: string, fields: Record<string, Record<string, string>> = {}) {
  return { name: `@antelopejs/${name}`, version, ...fields };
}

let interfaceDatabase = "";
let mongodb = "";
let dmsDatabase = "";
let dms = "";

before(() => {
  interfaceDatabase = repository("interface-database", (path) => {
    commit(path, "feat: first", { "package.json": manifest("interface-database", "0.4.2", { devDependencies: { "@antelopejs/mongodb": "~1.8.6" } }) });
    git(path, "tag", "v0.4.2");
    commit(path, "feat(query)!: drop the legacy cursor", { "src/index.ts": "export {};\n" });
    commit(path, "ci: cache the store", { "ci.txt": "x\n" });
  });
  mongodb = repository("mongodb", (path) => {
    commit(path, "feat: first", { "package.json": manifest("mongodb", "1.8.5") });
    commit(path, "chore(release): v1.8.6", { "package.json": manifest("mongodb", "1.8.6") });
    git(path, "tag", "v1.8.6");
    commit(path, "fix(database): close the change feed", {
      "package.json": manifest("mongodb", "1.8.6", { dependencies: { "@antelopejs/interface-database": "0.4.3-next.12.g3f9a2c1" } }),
    });
    commit(path, "release: v1.8.7-next.0", { "notes.txt": "x\n" });
  });
  dmsDatabase = repository("dms-database", (path) => {
    commit(path, "feat: first", { "package.json": manifest("dms-database", "0.5.3"), ".release-it.json": { git: { tagName: "release-${version}" } } });
    git(path, "tag", "release-0.5.3");
    git(path, "tag", "v9.9.9");
    commit(path, "chore: pin the mongodb preview", {
      "package.json": manifest("dms-database", "0.5.3", { devDependencies: { "@antelopejs/mongodb": "1.8.7-next.40.gabc1234" } }),
    });
  });
  dms = repository("dms", (path) => {
    commit(path, "feat: first", { "package.json": manifest("dms-root", "1.0.0"), "packages/automation/package.json": manifest("dms-automation", "0.11.1") });
    git(path, "tag", "v0.11.1");
    commit(path, "feat: root only", { "root.txt": "x\n" });
    commit(path, "perf(automation): faster", { "packages/automation/index.ts": "export {};\n" });
  });
});

after(() => rmSync(root, { recursive: true, force: true }));

interface Run {
  id: number;
  repo: string;
  branch: string;
  views: number;
}

function fakeSystem(conclusions: Record<string, string> = {}) {
  const calls: string[][] = [];
  const runs: Run[] = [];
  let out = "";
  let err = "";
  const answer = (stdout: string, status = 0): RunResult => ({ status, stdout, stderr: status === 0 ? "" : "failed" });
  const flag = (args: readonly string[], name: string): string => args[args.indexOf(name) + 1] ?? "";
  const system: System = {
    run: (command, args) => {
      if (command === "git") {
        const result = spawnSync("git", args, { encoding: "utf8" });
        return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      }
      if (command === "npm") return answer("", 1);
      calls.push([...args]);
      const repo = flag(args, "--repo");
      if (args[0] === "workflow") {
        if (conclusions[repo] === "rejected") return answer("", 1);
        runs.push({ id: 100 + runs.length, repo, branch: flag(args, "--ref"), views: 0 });
        return answer("");
      }
      if (args[0] === "run" && args[1] === "list") {
        const listed = runs.filter((run) => run.repo === repo).map((run) => ({ databaseId: run.id, headBranch: run.branch }));
        return answer(JSON.stringify(listed));
      }
      const run = runs.find((candidate) => String(candidate.id) === args[2]);
      assert.ok(run, `no run ${args[2]}`);
      run.views += 1;
      const status = run.views < 2 ? "in_progress" : "completed";
      const conclusion = status === "completed" ? (conclusions[repo] ?? "success") : "";
      return answer(JSON.stringify({ status, conclusion, url: `https://github.com/${repo}/actions/runs/${run.id}` }));
    },
    sleep: () => {},
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += `${text}\n`;
    },
    cacheDirectory: join(root, "cache"),
  };
  return { system, calls, output: () => out, errors: () => err };
}

function dispatches(calls: string[][]): string[][] {
  return calls
    .filter((args) => args[0] === "workflow")
    .map((args) => [args[4] ?? "", ...args.filter((_, index) => args[index - 1] === "-f")]);
}

const expectedPlan = [
  "Release plan from main, 4 packages: 4 to release",
  "",
  "1. @antelopejs/interface-database 0.4.2 -> 0.5.0 (minor)  AntelopeJS/interface-database",
  "     feat(query)!: drop the legacy cursor",
  "2. @antelopejs/mongodb 1.8.6 -> 1.8.7 (patch)  AntelopeJS/mongodb",
  "     fix(database): close the change feed",
  "     @antelopejs/interface-database 0.4.3-next.12.g3f9a2c1 -> >=0.5.0 <0.6.0",
  "3. @antelopejs/dms-database 0.5.3 -> 0.5.4 (patch)  AntelopeJS/dms-database",
  "     replaces preview pins",
  "     @antelopejs/mongodb 1.8.7-next.40.gabc1234 -> >=1.8.7 <1.9.0",
  "4. @antelopejs/dms-automation 0.11.1 -> 0.11.2 (patch)  AntelopeJS/dms:packages/automation",
  "     perf(automation): faster",
  "",
].join("\n");

describe("plan", () => {
  test("reads each checkout at its default branch and prints the plan", () => {
    const { system, calls, output } = fakeSystem();
    const status = main(["plan", dmsDatabase, mongodb, interfaceDatabase, `${dms}:packages/automation`], system);
    assert.equal(status, 0);
    assert.equal(output(), expectedPlan);
    assert.deepEqual(calls, []);
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
        "     depends on preview @antelopejs/mongodb@1.8.7-next.40.gabc1234, which is not in this release",
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
    git(mongodb, "branch", "next", "refs/tags/v1.8.6");
    const { system, output } = fakeSystem();
    assert.equal(main(["plan", "--ref", "next", mongodb], system), 0);
    assert.equal(output(), "Release plan from next, nothing to release\n\nUnchanged: @antelopejs/mongodb\n");
  });
});

describe("go", () => {
  test("dispatches each release in dependency order and waits for each run", () => {
    const { system, output, calls } = fakeSystem();
    const status = main(["go", dmsDatabase, mongodb, interfaceDatabase, `${dms}:packages/automation`], system);
    assert.equal(status, 0);
    assert.deepEqual(dispatches(calls), [
      ["AntelopeJS/interface-database", "release-version=0.5.0", "dependency-ranges={}"],
      ["AntelopeJS/mongodb", "release-version=1.8.7", 'dependency-ranges={"@antelopejs/interface-database":">=0.5.0 <0.6.0"}'],
      ["AntelopeJS/dms-database", "release-version=0.5.4", 'dependency-ranges={"@antelopejs/mongodb":">=1.8.7 <1.9.0"}'],
      ["AntelopeJS/dms", "release-version=0.11.2", "dependency-ranges={}", "package-directory=packages/automation"],
    ]);
    assert.ok(calls.filter((args) => args[0] === "workflow").every((args) => args[6] === "main"));
    assert.equal(
      output(),
      `${expectedPlan}published @antelopejs/interface-database 0.5.0  https://github.com/AntelopeJS/interface-database/actions/runs/100\n` +
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

  test("refuses --ref and dispatches nothing", () => {
    const { system, calls, errors } = fakeSystem();
    assert.equal(main(["go", "--ref", "next", mongodb], system), 1);
    assert.equal(errors(), "go always releases the default branch, so it takes no --ref.\n");
    assert.deepEqual(calls, []);
  });
});

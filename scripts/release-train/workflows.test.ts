import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { JsonObject } from "./json.ts";
import { readText } from "./helpers/read.ts";
import { nonRegistrySpecs, registrySpecs } from "./registry-specs.ts";
import { checkout, commitFiles, firstCommit, git, head, hermeticGit, packageDirectory, repository, root, runStep, text } from "./workflows-helpers.ts";

/** The inputs of the Resolve release mode step that a case can change. */
interface ModeInputs {
  version: string;
  commit: string;
  pullRequest: string;
  preview: string;
}

function lockfile(spec: string, version: string): string {
  return [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      '@antelopejs/interface-database':",
    `        specifier: ${spec}`,
    `        version: ${version}`,
    "",
    "packages:",
    "",
    `  '@antelopejs/interface-database@${version}':`,
    "    resolution: {integrity: sha512-x}",
    "",
  ].join("\n");
}

describe("release-npm.yml", () => {
  test("Apply dependency ranges refuses every runtime preview or non-registry spec but a workspace: one, and warns on a devDependency preview", () => {
    const pinned = packageDirectory(`release-pinned`, {
      name: "@antelopejs/x",
      dependencies: { "@antelopejs/a": "0.5.0-next.12.g3f9a2c1", "@antelopejs/b": ">=1.0.0 <1.1.0" },
      optionalDependencies: { "@antelopejs/d": "1.0.1-next.3.gabc1234" },
      devDependencies: { "@antelopejs/c": "^2.0.0-beta.1" },
    });
    const refused = runStep(text, "Apply dependency ranges", pinned);
    assert.equal(refused.status, 1);
    assert.equal(
      refused.stderr,
      "A stable release depends only on stable registry version ranges. Give each preview a stable range in dependency-ranges, and replace each other spec:\n" +
        "dependencies @antelopejs/a 0.5.0-next.12.g3f9a2c1\noptionalDependencies @antelopejs/d 1.0.1-next.3.gabc1234\n",
    );
    const unpacked = nonRegistrySpecs.filter((spec) => !spec.startsWith("workspace:"));
    const local = packageDirectory(`release-local`, {
      name: "@antelopejs/x",
      dependencies: { ...Object.fromEntries(unpacked.map((spec, index) => [`@antelopejs/d${index}`, spec])), "@antelopejs/w": "workspace:^" },
      peerDependencies: { "@antelopejs/p": "file:../p" },
      optionalDependencies: { "@antelopejs/o": "link:../o" },
      devDependencies: { "@antelopejs/dev": "file:../dev" },
    });
    const unpublishable = runStep(text, "Apply dependency ranges", local);
    assert.equal(unpublishable.status, 1);
    assert.deepEqual(unpublishable.stderr.trim().split("\n").slice(1), [
      ...unpacked.map((spec, index) => `dependencies @antelopejs/d${index} ${spec}`),
      "peerDependencies @antelopejs/p file:../p",
      "optionalDependencies @antelopejs/o link:../o",
    ]);
    const ranges = packageDirectory(`release-registry`, {
      name: "@antelopejs/x",
      dependencies: Object.fromEntries(registrySpecs.filter((spec) => !/\d-/.test(spec)).map((spec, index) => [`@antelopejs/r${index}`, spec])),
    });
    assert.equal(runStep(text, "Apply dependency ranges", ranges).status, 0);
    const dev = packageDirectory(`release-dev`, {
      name: "@antelopejs/x",
      dependencies: { "@antelopejs/b": "~1.8.6" },
      devDependencies: { "@antelopejs/c": "^2.0.0-beta.1" },
    });
    const warned = runStep(text, "Apply dependency ranges", dev);
    assert.deepEqual([warned.status, warned.stdout], [0, "::warning::This run keeps the devDependency preview @antelopejs/c ^2.0.0-beta.1.\n"]);
    const clean = packageDirectory(`release-clean`, { name: "@antelopejs/x", dependencies: { "@antelopejs/b": "~1.8.6" } });
    const passed = runStep(text, "Apply dependency ranges", clean);
    assert.deepEqual([passed.status, passed.stdout], [0, ""]);
  });

  test("Apply dependency ranges refuses a runtime spec on a released workspace sibling that is not workspace:, but not in a repin", () => {
    const manifest = (name: string, fields: JsonObject = {}) => `${JSON.stringify({ name, version: "0.1.0", ...fields })}\n`;
    const own = {
      dependencies: { "@antelopejs/interface-x": ">=0.7.0 <0.8.0", "@antelopejs/interface-y": "workspace:^", "@antelopejs/fixture": "^1.0.0", "@antelopejs/b": "~1.8.6" },
      peerDependencies: { "@antelopejs/interface-y": "^0.4.0" },
      optionalDependencies: { "@antelopejs/interface-x": "0.7.1-next.1.gabc1234" },
      devDependencies: { "@antelopejs/interface-y": "^0.4.0", "@antelopejs/c": "0.2.0-next.1.gabc1234" },
    };
    const { directory } = repository("release-literal-siblings", {
      "package.json": JSON.stringify({ name: "workspace", private: true }),
      "packages/interface-x/package.json": manifest("@antelopejs/interface-x"),
      "packages/interface-x/.release-it.json": "{}\n",
      "packages/interface-y/package.json": manifest("@antelopejs/interface-y"),
      "packages/interface-y/.release-it.json": "{}\n",
      "packages/x/test/fixture/package.json": manifest("@antelopejs/fixture"),
      "packages/x/package.json": manifest("@antelopejs/x", own),
      "packages/x/.release-it.json": "{}\n",
    });
    const x = join(directory, "packages", "x");
    const refused = runStep(text, "Apply dependency ranges", x, { ...hermeticGit, MODE: "stable", DEPENDENCY_RANGES: '{"@antelopejs/interface-x":">=0.7.1 <0.8.0"}' });
    assert.deepEqual([refused.status, refused.stderr], [
      1,
      "A stable release names each workspace sibling as workspace:^, which pnpm pack turns into the range of the version it releases. Replace each literal range with workspace:^:\n" +
        "dependencies @antelopejs/interface-x >=0.7.0 <0.8.0\npeerDependencies @antelopejs/interface-y ^0.4.0\noptionalDependencies @antelopejs/interface-x 0.7.1-next.1.gabc1234\n",
    ]);
    const repinned = runStep(text, "Apply dependency ranges", x, { ...hermeticGit, MODE: "repin", DEPENDENCY_RANGES: '{"@antelopejs/c":">=0.2.0 <0.3.0"}' });
    assert.doesNotMatch(repinned.stderr, /workspace sibling/);
    git(directory, "checkout", "--quiet", "--", ".");
    commitFiles(directory, "fix(x): name the siblings as workspace:^", {
      "packages/x/package.json": manifest("@antelopejs/x", {
        ...own,
        dependencies: { ...own.dependencies, "@antelopejs/interface-x": "workspace:^" },
        peerDependencies: { "@antelopejs/interface-y": "workspace:^" },
        optionalDependencies: {},
      }),
    });
    const passed = runStep(text, "Apply dependency ranges", x, { ...hermeticGit, MODE: "stable" });
    assert.deepEqual([passed.status, passed.stderr], [0, ""]);
  });
});

describe("release-npm.yml", () => {
  test("Apply dependency ranges rewrites only the preview specs of a name and names the commit", () => {
    const directory = packageDirectory(`release-ranges`, {
      name: "@antelopejs/x",
      dependencies: { "@antelopejs/core": "0.6.0-next.1.gabc1234" },
      peerDependencies: { "@antelopejs/core": ">=0.5.1 <0.6.0" },
      devDependencies: { "@antelopejs/core": "0.6.0-next.1.gabc1234", "@antelopejs/db": "0.5.0-next.2.gabc1234" },
    });
    const ranges = JSON.stringify({ "@antelopejs/core": ">=0.6.0 <0.7.0", "@antelopejs/db": ">=0.5.0 <0.6.0" });
    const applied = runStep(text, "Apply dependency ranges", directory, { DEPENDENCY_RANGES: ranges });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.outputs, "message=fix(deps): depend on the stable @antelopejs/core and @antelopejs/db\n");
    assert.deepEqual(JSON.parse(readText(join(directory, "package.json"))), {
      name: "@antelopejs/x",
      dependencies: { "@antelopejs/core": ">=0.6.0 <0.7.0" },
      peerDependencies: { "@antelopejs/core": ">=0.5.1 <0.6.0" },
      devDependencies: { "@antelopejs/core": ">=0.6.0 <0.7.0", "@antelopejs/db": ">=0.5.0 <0.6.0" },
    });
    assert.equal(runStep(text, "Apply dependency ranges", directory, { DEPENDENCY_RANGES: "{}" }).outputs, "");
    const stable = runStep(text, "Apply dependency ranges", directory, { DEPENDENCY_RANGES: '{"@antelopejs/core":">=0.7.0 <0.8.0"}' });
    assert.equal(stable.status, 1);
    assert.match(stable.stderr, /does not pin to a preview: @antelopejs\/core$/m);
    const absent = runStep(text, "Apply dependency ranges", directory, { DEPENDENCY_RANGES: '{"@antelopejs/nope":"~1.0.0"}' });
    assert.equal(absent.status, 1);
    assert.match(absent.stderr, /does not pin to a preview: @antelopejs\/nope$/m);
    for (const range of ["file:../x", "github:AntelopeJS/x#next", "0.7.0-next.1.gabc1234", "latest", `${Array.from({ length: 40 }, () => "1").join("      ")}!`]) {
      const invalid = runStep(text, "Apply dependency ranges", directory, { DEPENDENCY_RANGES: JSON.stringify({ "@antelopejs/core": range }) });
      assert.deepEqual([invalid.status, invalid.stderr], [1, `dependency-ranges must map each name to a stable version range:\n@antelopejs/core ${range}\n`]);
    }
  });

  test("Apply dependency ranges refuses the release while a runtime preview remains after it rewrote another, and names the remaining one", () => {
    const directory = packageDirectory(`release-remaining`, {
      name: "@antelopejs/x",
      dependencies: { "@antelopejs/core": "0.6.0-next.1.gabc1234", "@antelopejs/db": "0.5.0-next.2.gabc1234" },
    });
    const refused = runStep(text, "Apply dependency ranges", directory, { MODE: "stable", DEPENDENCY_RANGES: '{"@antelopejs/core":">=0.6.0 <0.7.0"}' });
    assert.deepEqual(
      [refused.status, refused.stderr],
      [
        1,
        "A stable release depends only on stable registry version ranges. Give each preview a stable range in dependency-ranges, and replace each other spec:\n" +
          "dependencies @antelopejs/db 0.5.0-next.2.gabc1234\n",
      ],
    );
  });

  test("Resolve release mode previews a dispatch with preview of the default branch or a work/* branch, previews a pull request, releases a dispatch on the default branch, and refuses any other event", () => {
    const mode = (event: string, ref: string, inputs: Partial<ModeInputs> = {}) => {
      const { version = "", commit = head, pullRequest = "", preview = "false" } = inputs;
      return runStep(text, "Resolve release mode", root, {
        GITHUB_EVENT_NAME: event,
        GITHUB_REF: ref,
        DEFAULT_BRANCH: "main",
        RELEASE_VERSION: version,
        RELEASE_COMMIT: commit,
        PULL_REQUEST: pullRequest,
        PREVIEW: preview,
      });
    };
    assert.equal(mode("workflow_dispatch", "refs/heads/main", { commit: "", preview: "true" }).outputs, "mode=preview\ntag=next\n");
    assert.equal(mode("workflow_dispatch", "refs/heads/work/ant-12-cache", { commit: "", preview: "true" }).outputs, "mode=preview\ntag=next\n");
    assert.equal(mode("workflow_dispatch", "refs/heads/main", { version: "0.5.0", preview: "true" }).outputs, "mode=preview\ntag=next\n");
    assert.equal(mode("workflow_dispatch", "refs/heads/next", { commit: "", preview: "true" }).status, 1);
    assert.equal(mode("workflow_dispatch", "refs/heads/feat/work/x", { commit: "", preview: "true" }).status, 1);
    assert.equal(mode("workflow_dispatch", "refs/tags/v1.0.0", { commit: "", preview: "true" }).status, 1);
    assert.equal(mode("workflow_dispatch", "refs/heads/main", { version: "0.5.0" }).outputs, "mode=stable\n");
    assert.equal(mode("workflow_dispatch", "refs/heads/main", { version: "0.5.0", commit: "" }).status, 1);
    assert.equal(mode("workflow_dispatch", "refs/heads/main", { version: "0.5.0", commit: head.slice(0, 7) }).status, 1);
    assert.equal(mode("workflow_dispatch", "refs/heads/main").outputs, "mode=repin\n");
    assert.equal(mode("workflow_dispatch", "refs/heads/main", { commit: "" }).status, 1);
    assert.equal(mode("workflow_dispatch", "refs/heads/main", { version: "0.5.0-next.1" }).status, 1);
    assert.equal(mode("workflow_dispatch", "refs/heads/next", { version: "0.5.0" }).status, 1);
    assert.equal(mode("workflow_dispatch", "refs/heads/work/x", { version: "0.5.0" }).status, 1);
    assert.deepEqual(mode("pull_request", "refs/pull/12/merge", { commit: "", pullRequest: "12" }).outputs, "mode=pull-request\ntag=pr-12\n");
    assert.equal(mode("pull_request_target", "refs/heads/main", { commit: "", pullRequest: "12" }).status, 1);
    const pushed = mode("push", "refs/heads/main", { commit: "", preview: "" });
    assert.deepEqual(
      [pushed.status, pushed.outputs, pushed.stderr],
      [
        1,
        "",
        "A workflow_dispatch with preview of main or a work/* branch publishes a preview, a pull_request with the preview label publishes a pull request preview, and a workflow_dispatch of main without preview publishes a stable release. A push of refs/heads/main publishes nothing.\n",
      ],
    );
  });

  test("Check the planned commit refuses a branch that moved since the plan", () => {
    const check = (commit: string) =>
      runStep(text, "Check the planned commit", checkout, { RELEASE_COMMIT: commit, GITHUB_REF_NAME: "main" });
    assert.equal(check(head).status, 0);
    const moved = check(firstCommit);
    assert.equal(moved.status, 1);
    assert.equal(
      moved.stderr,
      `main moved since the plan: HEAD is ${head}, the plan released ${firstCommit}. Run the release train again.\n`,
    );
  });
});

describe("release-npm.yml", () => {
  test("a repin run commits the devDependency ranges to the default branch, and refuses a runtime pin or no range", () => {
    const preview = "0.4.3-next.117.g3645dff";
    const manifest = (spec: string) => `${JSON.stringify({ name: "@antelopejs/m", version: "1.8.6", devDependencies: { "@antelopejs/interface-database": spec } }, null, 2)}\n`;
    const bare = join(root, "repin-origin.git");
    const seed = join(root, "repin-seed");
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
    git(root, "clone", "--quiet", bare, seed);
    commitFiles(seed, "chore: pin the interface preview", { "package.json": manifest(preview), "pnpm-lock.yaml": lockfile(preview, preview) });
    git(seed, "push", "--quiet", "origin", "main");
    const runner = join(root, "repin-runner");
    git(root, "clone", "--quiet", bare, runner);
    const env = { ...hermeticGit, RUNNER_TEMP: join(root, "repin-temp"), GITHUB_TOKEN: "token" };
    mkdirSync(env.RUNNER_TEMP);
    assert.equal(runStep(text, "Configure release identity", runner, env).status, 0);
    const ranges = runStep(text, "Apply dependency ranges", runner, { ...env, MODE: "repin", DEPENDENCY_RANGES: '{"@antelopejs/interface-database":">=0.5.0 <0.6.0"}' });
    assert.equal(ranges.status, 0, ranges.stderr);
    const message = ranges.outputs.replace(/^message=/, "").trim();
    assert.equal(message, "fix(deps): depend on the stable @antelopejs/interface-database");
    writeFileSync(join(runner, "pnpm-lock.yaml"), lockfile(">=0.5.0 <0.6.0", "0.5.0"));
    assert.equal(runStep(text, "Stage stable dependencies", runner, { ...env, PACKAGE_DIRECTORY: ".", LOCKFILE: "pnpm-lock.yaml" }).status, 0);
    const pushed = runStep(text, "Push the stable ranges", runner, { ...env, MESSAGE: message, GITHUB_REF_NAME: "main" });
    assert.equal(pushed.status, 0, pushed.stderr);
    assert.equal(git(bare, "log", "-1", "--format=%s", "main"), message);
    assert.equal(`${git(bare, "show", "main:package.json")}\n`, manifest(">=0.5.0 <0.6.0"));
    assert.deepEqual(git(bare, "branch", "--list"), "* main");
    assert.deepEqual(git(bare, "tag", "--list"), "");

    const runtime = packageDirectory(`release-repin-runtime`, {
      name: "@antelopejs/x",
      dependencies: { "@antelopejs/core": "0.6.0-next.1.gabc1234" },
      devDependencies: { "@antelopejs/db": "0.5.0-next.2.gabc1234" },
    });
    const refused = runStep(text, "Apply dependency ranges", runtime, { MODE: "repin", DEPENDENCY_RANGES: '{"@antelopejs/core":">=0.6.0 <0.7.0","@antelopejs/db":">=0.5.0 <0.6.0"}' });
    assert.deepEqual([refused.status, refused.outputs], [1, ""]);
    assert.match(refused.stderr, /a runtime pin needs a release: @antelopejs\/core$/m);
    const empty = runStep(text, "Apply dependency ranges", runtime, { MODE: "repin", DEPENDENCY_RANGES: "{}" });
    assert.deepEqual([empty.status, empty.outputs], [1, ""]);
  });
});

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import { runInNewContext } from "node:vm";
import { readText } from "./helpers/read.ts";
import { SYNC_PATH, syncRepository } from "./helpers/sync.ts";
import { git, repoFile, runStep, write } from "./helpers/workflow.ts";

const renovateSync = repoFile(".github/workflows/ci-renovate-sync.yml");
const DETECT = "Detect a dependency bump";
const SYNC = "Run antelopejs-sync and the format script";

describe("ci-renovate-sync.yml", () => {
  const renovateBranch = (dir: string, files: Record<string, string>): void => {
    git(dir, "checkout", "-qb", "renovate/bump");
    write(dir, files);
    git(dir, "commit", "-qam", "chore(deps): bump");
  };

  test("syncs a bump that only moves a lockfile, such as a patch of @antelopejs/core", () => {
    const dir = syncRepository("antelopejs-sync", "README.md");
    renovateBranch(dir, { "pnpm-lock.yaml": "core: 1.24.8\n" });

    assert.equal(runStep(renovateSync, DETECT, dir, { BASE_REF: "main" }).outputs.bumped, "true");
  });

  test("leaves a bump that changes no manifest or lockfile alone", () => {
    const dir = syncRepository("antelopejs-sync", "README.md");
    renovateBranch(dir, { "README.md": "Tested with 1.24.8\n" });

    assert.equal(runStep(renovateSync, DETECT, dir, { BASE_REF: "main" }).outputs.bumped, undefined);
  });

  test("runs the repository's own sync script, so its profile is the one its sync:check reads", () => {
    for (const [script, written] of [
      ["antelopejs-sync", "synced \n"],
      ["antelopejs-sync --profile template", "synced --profile template\n"],
    ]) {
      const dir = syncRepository(script, "AGENTS.md");

      const sync = runStep(renovateSync, SYNC, dir, SYNC_PATH);

      assert.equal(sync.status, 0, sync.stdout);
      assert.equal(sync.outputs.changed, "true");
      assert.equal(readText(join(dir, "AGENTS.md")), written);
    }
  });

  const formatRepository = (format: string, source: string): string => {
    const dir = syncRepository(undefined, "AGENTS.md");
    write(dir, { "package.json": `${JSON.stringify({ name: "app", scripts: { format } })}\n`, "src/index.ts": source });
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "format script");
    return dir;
  };

  test("commits the reformat of an oxfmt bump, so the pull request lands with the files it formats", () => {
    const dir = formatRepository("printf 'export const a = [1, 2];\\n' > src/index.ts", "export const a = [\n  1,\n  2\n];\n");

    const sync = runStep(renovateSync, SYNC, dir, SYNC_PATH);

    assert.equal(sync.status, 0, sync.stdout);
    assert.equal(sync.outputs.changed, "true");
    assert.equal(readText(join(dir, "src/index.ts")), "export const a = [1, 2];\n");
  });

  test("commits nothing when the format script leaves every file as it is", () => {
    const dir = formatRepository("true", "export const a = 1;\n");

    const sync = runStep(renovateSync, SYNC, dir, SYNC_PATH);

    assert.equal(sync.status, 0, sync.stdout);
    assert.equal(sync.outputs.changed, undefined);
  });

  test("pushes nothing when the format script changes more than whitespace, such as a lint fix", () => {
    for (const format of ["printf 'export const a = 1;\\n' > src/index.ts", "rm src/index.ts", "echo x > src/new.ts"]) {
      const dir = formatRepository(format, "export let a = 1;\n");

      const sync = runStep(renovateSync, SYNC, dir, SYNC_PATH);

      assert.notEqual(sync.status, 0, format);
      assert.match(sync.stdout, /::error::The format script changes more than whitespace/);
      assert.equal(sync.outputs.changed, undefined);
    }
  });

  test("runs only on a Renovate pull request from this repository", () => {
    const lines = renovateSync.split("\n");
    const start = lines.findIndex((line) => line.trim() === "if: >-");
    const condition = lines
      .slice(start + 1, lines.findIndex((line, index) => index > start && line.trim().startsWith("runs-on:")))
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("#"))
      .join(" ")
      .replace(/==/g, "===");
    const runs = (event: string, head: string, fork: string): boolean =>
      runInNewContext(condition, {
        startsWith: (text: string, prefix: string) => text.startsWith(prefix),
        github: { event_name: event, head_ref: head, repository: "AntelopeJS/app", event: { pull_request: { head: { repo: { full_name: fork } } } } },
      }) === true;

    assert.equal(runs("pull_request", "renovate/oxfmt", "AntelopeJS/app"), true);
    assert.equal(runs("pull_request", "fix/oxfmt", "AntelopeJS/app"), false);
    assert.equal(runs("pull_request", "renovate/oxfmt", "someone/app"), false);
    assert.equal(runs("merge_group", "renovate/oxfmt", "AntelopeJS/app"), false);
  });

  test("pushes nothing when the format script touches a workflow", () => {
    const dir = syncRepository(undefined, "AGENTS.md");
    write(dir, { "package.json": `${JSON.stringify({ name: "app", scripts: { format: "mkdir -p .github/workflows && echo x > .github/workflows/ci.yml" } })}\n` });
    git(dir, "commit", "-qam", "format script");

    const sync = runStep(renovateSync, SYNC, dir, SYNC_PATH);

    assert.notEqual(sync.status, 0);
    assert.match(sync.stdout, /::error::The sync output changes workflow paths/);
    assert.equal(sync.outputs.changed, undefined);
  });

  test("changes nothing in a repository without a sync script", () => {
    const sync = runStep(renovateSync, SYNC, syncRepository(undefined, "AGENTS.md"), SYNC_PATH);

    assert.equal(sync.status, 0, sync.stdout);
    assert.equal(sync.outputs.changed, undefined);
  });

  test("pushes nothing when the sync output touches a workflow", () => {
    const sync = runStep(renovateSync, SYNC, syncRepository("antelopejs-sync", ".github/workflows/release.yml"), SYNC_PATH);

    assert.notEqual(sync.status, 0);
    assert.match(sync.stdout, /::error::The sync output changes workflow paths/);
    assert.equal(sync.outputs.changed, undefined);
  });
});

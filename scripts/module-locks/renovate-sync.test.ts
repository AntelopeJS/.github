import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
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

  test("formats the repository after the sync, so a bump of oxfmt lands with the files it formats", () => {
    const dir = syncRepository("antelopejs-sync", "AGENTS.md");
    write(dir, { "package.json": `${JSON.stringify({ name: "app", scripts: { sync: "antelopejs-sync", format: "cat AGENTS.md > src/index.ts" } })}\n`, "src/index.ts": "unformatted\n" });
    git(dir, "commit", "-qam", "format script");

    const sync = runStep(renovateSync, SYNC, dir, SYNC_PATH);

    assert.equal(sync.status, 0, sync.stdout);
    assert.equal(sync.outputs.changed, "true");
    assert.equal(readText(join(dir, "src/index.ts")), "synced \n");
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

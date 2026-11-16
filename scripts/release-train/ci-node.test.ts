import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { commit, git } from "./fixtures.ts";

const workflow = readFileSync(new URL("../../.github/workflows/ci-node.yml", import.meta.url), "utf8").split("\n");
const root = mkdtempSync(join(tmpdir(), "ci-node-"));
after(() => rmSync(root, { recursive: true, force: true }));

function tierScript(): string {
  const start = workflow.indexOf("      - name: Pick the tier from the event, the target branch and the draft flag");
  const run = workflow.indexOf("        run: |", start);
  assert.ok(start !== -1 && run !== -1, "tier step not found");
  const body: string[] = [];
  for (const line of workflow.slice(run + 1)) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

function fastTierTests(changed: string[]): string {
  const repository = mkdtempSync(join(root, "repo-"));
  git(repository, "init", "--quiet");
  commit(repository, "chore: base", { "package.json": {} });
  commit(repository, "chore: change", Object.fromEntries(changed.map((file) => [file, "x"])));
  const script = join(repository, "..", `${repository.split("/").pop()}.sh`);
  const output = `${script}.out`;
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, tierScript());
  writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      EVENT: "pull_request",
      DEFAULT_BRANCH: "main",
      REPOSITORY: "o/r",
      HEAD_REPOSITORY: "o/r",
      BASE_REF: "next",
      HEAD_REF: "feature",
      DRAFT: "false",
      WINDOWS: "false",
      WINDOWS_PULL_REQUESTS: "false",
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: `${output}.summary`,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const match = /^tests=(.*)$/m.exec(readFileSync(output, "utf8"));
  assert.ok(match, "no tests output");
  return match[1];
}

describe("ci-node fast tier", () => {
  test("skips the tests for playground content only", () => {
    assert.equal(fastTierTests(["packages/dms/playground/src/app.ts", "README.md"]), "false");
  });

  test("runs the tests when a checks config under a playground changes", () => {
    assert.equal(fastTierTests(["packages/dms/playground/checks/client-lint.config.mjs"]), "true");
  });

  test("runs the tests when a checks config changes next to playground content", () => {
    assert.equal(fastTierTests(["packages/dms/playground/src/app.ts", "packages/dms/playground/checks/client-lint.config.mjs"]), "true");
  });
});

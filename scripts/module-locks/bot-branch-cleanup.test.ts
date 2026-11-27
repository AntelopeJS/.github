import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readText } from "./helpers/read.ts";
import { repoFile, root, runStep, runs } from "./helpers/workflow.ts";

const cleanup = repoFile(".github/workflows/bot-branch-cleanup.yml");

const STEP = "Delete the branch when it still points at the closed pull request";
const BRANCH = "renovate/argo-suite";
const HEAD = "a".repeat(40);
const DELETE = `gh api -X DELETE repos/AntelopeJS/api/git/refs/heads/${BRANCH}`;

interface Scene {
  branch?: string;
  base?: string;
  refs?: { ref: string; object: { sha: string } }[];
  protected?: boolean;
  rules?: { type: string }[];
  pulls?: { number: number }[];
  deleteStatus?: number;
}

interface Outcome {
  status: number;
  stdout: string;
  calls: string[];
  summary: string;
}

function close(scene: Scene = {}): Outcome {
  const temp = mkdtempSync(join(root, "cleanup-"));
  const log = join(temp, "gh.log");
  const step = runStep(cleanup, STEP, root, {
    GH_LOG: log,
    GH_REPO: "AntelopeJS/api",
    NUMBER: "42",
    BRANCH: scene.branch ?? BRANCH,
    HEAD_SHA: HEAD,
    BASE: scene.base ?? "main",
    DEFAULT_BRANCH: "main",
    GH_REFS: JSON.stringify(scene.refs ?? [{ ref: `refs/heads/${BRANCH}`, object: { sha: HEAD } }]),
    GH_BRANCH: JSON.stringify({ protected: scene.protected ?? false }),
    GH_RULES: JSON.stringify(scene.rules ?? []),
    GH_PULLS: JSON.stringify(scene.pulls ?? []),
    GH_DELETE_STATUS: String(scene.deleteStatus ?? 0),
  });
  const summary = join(root, `runner-${runs}`, "summary");
  return {
    status: step.status,
    stdout: step.stdout,
    calls: existsSync(log) ? readText(log).trimEnd().split("\n") : [],
    summary: existsSync(summary) ? readText(summary) : "",
  };
}

const deletes = (calls: string[]): string[] => calls.filter((call) => call.startsWith("gh api -X DELETE"));

describe("bot-branch-cleanup.yml", () => {
  test("deletes the head branch once it still points at the commit the pull request closed with", () => {
    const outcome = close();

    assert.equal(outcome.status, 0, outcome.stdout);
    assert.deepEqual(deletes(outcome.calls), [DELETE]);
    assert.match(outcome.summary, /^Deleted renovate\/argo-suite, the head of #42, closed unmerged\.$/m);
  });

  test("does nothing when the branch is already gone, even when one whose name starts with it remains", () => {
    const gone = close({ refs: [] });
    assert.equal(gone.status, 0, gone.stdout);
    assert.deepEqual(deletes(gone.calls), []);
    assert.match(gone.summary, /is already gone/);

    const longer = close({ refs: [{ ref: `refs/heads/${BRANCH}-old`, object: { sha: HEAD } }] });
    assert.deepEqual(deletes(longer.calls), []);
  });

  test("leaves a branch that moved since the pull request closed, since a new push or pull request reuses it", () => {
    const outcome = close({ refs: [{ ref: `refs/heads/${BRANCH}`, object: { sha: "b".repeat(40) } }] });

    assert.equal(outcome.status, 0, outcome.stdout);
    assert.deepEqual(deletes(outcome.calls), []);
    assert.match(outcome.summary, /moved to b{40} since #42 closed at a{40}/);
  });

  test("leaves a protected branch, and one whose ruleset forbids deletion", () => {
    const protectedBranch = close({ protected: true });
    assert.deepEqual(deletes(protectedBranch.calls), []);
    assert.match(protectedBranch.summary, /it is protected/);

    const ruled = close({ rules: [{ type: "deletion" }] });
    assert.deepEqual(deletes(ruled.calls), []);
    assert.match(ruled.summary, /a ruleset forbids its deletion/);

    const otherRules = close({ rules: [{ type: "pull_request" }] });
    assert.deepEqual(deletes(otherRules.calls), [DELETE]);
  });

  test("leaves a branch another open pull request is made from", () => {
    const outcome = close({ pulls: [{ number: 43 }] });

    assert.equal(outcome.status, 0, outcome.stdout);
    assert.deepEqual(deletes(outcome.calls), []);
    assert.match(outcome.summary, /another pull request is open from it/);
  });

  test("leaves the default branch and the base branch alone without a single API call", () => {
    for (const scene of [{ branch: "main" }, { branch: "develop", base: "develop" }]) {
      const outcome = close(scene);
      assert.equal(outcome.status, 0, outcome.stdout);
      assert.deepEqual(outcome.calls, [], scene.branch);
      assert.match(outcome.summary, /it is the default branch or the base of #42/);
    }
  });

  test("passes no branch name the API path cannot carry", () => {
    for (const branch of ["a b", "-x", "/x", 'x"y', "x?y", "x#y", "x%2Fy", ""]) {
      const outcome = close({ branch });
      assert.equal(outcome.status, 0, outcome.stdout);
      assert.deepEqual(outcome.calls, [], branch);
      assert.match(outcome.summary, /holds a character this workflow does not pass to the API/);
    }
  });

  test("fails and names the permission the caller lacks when the deletion is refused", () => {
    const outcome = close({ deleteStatus: 1 });

    assert.equal(outcome.status, 1);
    assert.deepEqual(deletes(outcome.calls), [DELETE]);
    assert.match(outcome.stdout, /::error::renovate\/argo-suite, the head of #42, could not be deleted\. The job that calls bot-branch-cleanup\.yml must grant contents: write\./);
  });

  test("runs on a pull request closed unmerged by a bot from the same repository, with a write on contents alone", () => {
    assert.match(cleanup, /^on:\n {2}workflow_call:\n\n/m);
    const job = cleanup.slice(cleanup.indexOf("  cleanup:\n"));
    assert.match(
      job,
      /^ {4}if: >-\n {6}github\.event_name == 'pull_request'\n {6}&& github\.event\.action == 'closed'\n {6}&& !github\.event\.pull_request\.merged\n {6}&& github\.event\.pull_request\.user\.type == 'Bot'\n {6}&& github\.event\.pull_request\.head\.repo\.full_name == github\.repository\n/m,
    );
    assert.match(job, /^ {4}permissions:\n {6}contents: write\n {4}[a-z]/m);
    assert.equal((job.match(/^ {6}GH_TOKEN: \$\{\{ github\.token \}\}$/gm) ?? []).length, 1);
    assert.doesNotMatch(job, /create-github-app-token|secrets\./);
  });
});

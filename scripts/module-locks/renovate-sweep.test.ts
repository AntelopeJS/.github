import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { Json } from "../ci-metrics/json.ts";
import { readText } from "./helpers/read.ts";
import { moveOf, parsePull, tickRebase, type RenovatePull } from "./renovate-sweep.ts";

const BODY = "Update rimraf.\n\n---\n\n - [ ] <!-- rebase-check -->If you want to rebase/retry this PR, check this box\n";

interface Node {
  repo?: string;
  rollup?: string | null;
  autoMerge?: boolean;
  inQueue?: boolean;
  mergeable?: string;
  last?: string | null;
  body?: string;
  mergeQueue?: boolean;
  draft?: boolean;
  head?: string;
  fork?: boolean;
  author?: string;
  removals?: { at: string; by: string }[];
}

const RENOVATE = "29139614+renovate[bot]@users.noreply.github.com";
const HEAD_AT = "2026-11-20T15:42:14Z";
const QUEUE_REMOVAL = { at: "2026-11-20T15:42:34Z", by: "github-merge-queue" };
/** The sweep's clock in the tests of `moveOf`, a week after the head was built. */
const NOW = Date.parse("2026-11-27T15:42:14Z");
const HOUR = 60 * 60 * 1000;

/** A search node shaped as GitHub's GraphQL API answered for AntelopeJS/brevo-private#49 on 2026-11-27. */
function node(scene: Node = {}): Json {
  return {
    number: 49,
    isDraft: scene.draft ?? false,
    headRefName: scene.head ?? "renovate/antelopejs-tooling-configs",
    baseRefName: "main",
    isCrossRepository: scene.fork ?? false,
    isInMergeQueue: scene.inQueue ?? false,
    mergeable: scene.mergeable ?? "MERGEABLE",
    body: scene.body ?? BODY,
    autoMergeRequest: scene.autoMerge === true ? { enabledAt: "2026-11-27T00:24:04Z" } : null,
    repository: {
      nameWithOwner: scene.repo ?? "AntelopeJS/brevo-private",
      isArchived: false,
      defaultBranchRef: { name: "main" },
      mergeQueue: scene.mergeQueue === false ? null : { id: "MQ_1" },
    },
    commits: {
      nodes: [{
        commit: {
          oid: "a".repeat(40),
          committedDate: HEAD_AT,
          author: { email: scene.author ?? RENOVATE },
          statusCheckRollup: scene.rollup === null ? null : { state: scene.rollup ?? "SUCCESS" },
        },
      }],
    },
    removals: { nodes: (scene.removals ?? [QUEUE_REMOVAL]).map(({ at, by }) => ({ createdAt: at, actor: { login: by } })) },
    timelineItems: { nodes: scene.last === null ? [] : [{ __typename: scene.last ?? "RemovedFromMergeQueueEvent" }] },
  };
}

function pull(scene: Node = {}): RenovatePull {
  const parsed = parsePull(node(scene));
  assert.notEqual(parsed, null);
  // SAFETY: the assertion above fails the test when parsePull answered null.
  return parsed as RenovatePull;
}

const behind = () => true;
const current = () => false;

describe("renovate-sweep", () => {
  test("re-arms auto-merge on a green pull request the merge queue removed", () => {
    assert.equal(moveOf(pull(), current, NOW), "rearm");
  });

  test("leaves a green pull request alone unless the queue removed it and nothing armed it since", () => {
    assert.equal(moveOf(pull({ autoMerge: true, last: "AutoMergeEnabledEvent" }), current, NOW), "none");
    assert.equal(moveOf(pull({ last: "AutoMergeDisabledEvent" }), current, NOW), "none", "someone turned auto-merge off");
    assert.equal(moveOf(pull({ last: null }), current, NOW), "none", "auto-merge was never armed");
    assert.equal(moveOf(pull({ inQueue: true, last: "AddedToMergeQueueEvent" }), current, NOW), "none");
  });

  test("re-arms a head once: a head the queue removed again stays as it is, and so does one a person dequeued", () => {
    const earlier = { at: "2026-11-20T11:37:34Z", by: "github-merge-queue" };
    assert.equal(moveOf(pull({ removals: [earlier, QUEUE_REMOVAL] }), current, NOW), "rearm", "the earlier removal was of an older head");
    assert.equal(moveOf(pull({ removals: [QUEUE_REMOVAL, { at: "2026-11-20T16:40:00Z", by: "github-merge-queue" }] }), current, NOW), "none");
    assert.equal(moveOf(pull({ removals: [{ at: QUEUE_REMOVAL.at, by: "antony" }] }), current, NOW), "none");
  });

  test("never arms auto-merge where it would not land through a merge queue or on a held repository", () => {
    assert.equal(moveOf(pull({ mergeQueue: false }), current, NOW), "none");
    assert.equal(moveOf(pull({ repo: "AntelopeJS/cloud" }), current, NOW), "none");
    assert.equal(moveOf(pull({ mergeable: "CONFLICTING" }), current, NOW), "none");
    assert.equal(moveOf(pull({ draft: true }), current, NOW), "none");
  });

  test("asks Renovate to rebase a red pull request once its base moved past its head", () => {
    assert.equal(moveOf(pull({ rollup: "FAILURE", autoMerge: true, last: "AutoMergeEnabledEvent" }), behind, NOW), "rebase");
    assert.equal(moveOf(pull({ rollup: "ERROR", last: "RemovedFromMergeQueueEvent" }), behind, NOW), "rebase");
  });

  test("asks at most once per base commit: not while the head holds the base, nor while the request is pending", () => {
    assert.equal(moveOf(pull({ rollup: "FAILURE" }), current, NOW), "none");
    const asked = pull({ rollup: "FAILURE", body: tickRebase(BODY) });
    assert.equal(asked.rebaseBox, "ticked");
    assert.equal(moveOf(asked, behind, NOW), "none");
  });

  test("never asks Renovate to rebase a major update, which stays red until someone migrates it", () => {
    const major = BODY.replace("Update rimraf.", "| Package | Type | Update | Change |\n|---|---|---|---|\n| [rimraf](https://redirect.github.com/isaacs/rimraf) | devDependencies | major | `^6.1.3` → `^7.0.0` |");
    assert.equal(pull({ body: major }).major, true);
    assert.equal(moveOf(pull({ rollup: "FAILURE", body: major }), behind, NOW), "none");
    const minor = major.replace("| major |", "| minor |");
    assert.equal(moveOf(pull({ rollup: "FAILURE", body: minor }), behind, NOW), "rebase");
    const notes = `${minor}\n### Release Notes\n\n| Change | Kind |\n|---|---|\n| drop Node 18 | major |\n`;
    assert.equal(pull({ body: notes }).major, false, "a release note table below the updates table names no update");
  });

  test("asks Renovate to rebase a red pull request at most once a day, since each rebase builds a new head", () => {
    const built = Date.parse(HEAD_AT);
    assert.equal(moveOf(pull({ rollup: "FAILURE" }), behind, built + 23 * HOUR), "none");
    assert.equal(moveOf(pull({ rollup: "FAILURE" }), behind, built + 24 * HOUR), "rebase");
  });

  test("never asks for a rebase that would drop someone's commit on the Renovate branch", () => {
    assert.equal(moveOf(pull({ rollup: "FAILURE", author: "dev@example.com" }), behind, NOW), "none");
    const noted = `${BODY}\n🔕 Renovate will not automatically rebase this PR, because it does not recognize the last commit author.\n`;
    assert.equal(moveOf(pull({ rollup: "FAILURE", body: noted }), behind, NOW), "none");
    assert.equal(moveOf(pull({ rollup: "FAILURE", author: "41898282+github-actions[bot]@users.noreply.github.com" }), behind, NOW), "rebase");
  });

  test("reads the base only for a red pull request with an unticked rebase checkbox", () => {
    let reads = 0;
    const counted = () => {
      reads++;
      return true;
    };
    moveOf(pull(), counted, NOW);
    moveOf(pull({ rollup: "PENDING" }), counted, NOW);
    moveOf(pull({ rollup: null }), counted, NOW);
    moveOf(pull({ rollup: "FAILURE", body: "no checkbox" }), counted, NOW);
    assert.equal(reads, 0);
  });

  test("ticks only Renovate's rebase checkbox", () => {
    const ticked = tickRebase(`${BODY} - [ ] <!-- other -->\n`);
    assert.match(ticked, / - \[x\] <!-- rebase-check -->If you want/);
    assert.match(ticked, / - \[ \] <!-- other -->/);
  });

  test("parses only pull requests from a renovate/ branch of their own repository", () => {
    assert.equal(parsePull(node({ head: "feat/x" })), null);
    assert.equal(parsePull(node({ fork: true })), null);
  });
});

const scratch = mkdtempSync(join(tmpdir(), "renovate-sweep-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
writeFileSync(
  join(scratch, "gh"),
  `#!/usr/bin/env bash
echo "gh $1 $2" >> "$GH_LOG"
case "$1 $2" in
  "api graphql") cat "$GH_ANSWER" ;;
  "api repos/AntelopeJS/web/compare/"*) printf '<!DOCTYPE html>\n<html><body>Unicorn!</body></html>\n' ;;
  "api repos/"*"/compare/"*) echo "HTTP 404: Not Found" >&2; exit 1 ;;
  *) exit 0 ;;
esac
`,
);
chmodSync(join(scratch, "gh"), 0o755);

interface Sweep {
  status: number | null;
  stdout: string;
  calls: string[];
}

let sweeps = 0;

/** Runs the sweep with `--dry-run` against a `gh` whose GraphQL answer is `answer`, as GitHub's text. */
function sweep(answer: string): Sweep {
  sweeps++;
  const file = join(scratch, `answer-${sweeps}`);
  const log = join(scratch, `gh-${sweeps}.log`);
  writeFileSync(file, answer);
  const main = new URL("renovate-sweep-main.ts", import.meta.url).pathname;
  const result = spawnSync(process.execPath, [main, "AntelopeJS", "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${scratch}:${process.env.PATH}`, GH_ANSWER: file, GH_LOG: log },
  });
  return { status: result.status, stdout: result.stdout, calls: existsSync(log) ? readText(log).trimEnd().split("\n") : [] };
}

const page = (...nodes: Json[]): string => JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });

/** A search page of `nodes` that also carries GraphQL `errors`. */
const answer = (nodes: Json[], errors: Json[]): string => JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } }, errors });

/** The error GitHub answers for node `index` when the token may not read its check rollup, or of another `type`. */
const hiddenRollup = (index: number, type = "FORBIDDEN"): Json => ({
  type,
  path: ["search", "nodes", index, "commits", "nodes", 0, "commit", "statusCheckRollup"],
  message: "Resource not accessible by integration",
});

describe("renovate-sweep-main.ts", () => {
  test("reads a search page larger than 1 MiB, as GitHub answered for 50 pull requests on 2026-11-28", () => {
    const run = sweep(page(node({ body: `${BODY}${"x".repeat(2 * 1024 * 1024)}` })));
    assert.equal(run.stdout, "- AntelopeJS/brevo-private#49: re-arm auto-merge (green, removed from the merge queue)\n");
    assert.equal(run.status, 0);
  });

  test("retries an answer that is not JSON, then reports its first line", () => {
    const run = sweep("<!DOCTYPE html>\n<html><body>Unicorn!</body></html>\n");
    assert.equal(run.stdout, "::error::gh api graphql answered no JSON 3 times; the last answer: <!DOCTYPE html>\n");
    assert.equal(run.calls.filter((call) => call === "gh api graphql").length, 3);
    assert.equal(run.status, 1);
  });

  test("moves the other pull requests when one cannot be read, and exits nonzero at the end", () => {
    const run = sweep(page(node({ repo: "AntelopeJS/api", rollup: "FAILURE" }), node()));
    assert.equal(
      run.stdout,
      "::error::AntelopeJS/api#49: Command failed: gh api repos/AntelopeJS/api/compare/main...aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" +
        "- AntelopeJS/brevo-private#49: re-arm auto-merge (green, removed from the merge queue)\n",
    );
    assert.equal(run.status, 1);
  });

  test("reports the first line of a base comparison that is not JSON", () => {
    const run = sweep(page(node({ repo: "AntelopeJS/web", rollup: "FAILURE" })));
    assert.equal(run.stdout, "::error::AntelopeJS/web#49: gh api compare answered no JSON: <!DOCTYPE html>\n");
    assert.equal(run.status, 1);
  });

  test("names GitHub's error when the search answers no result", () => {
    const run = sweep(JSON.stringify({ data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }));
    assert.equal(run.stdout, "::error::The pull request search answered no search result: ?: API rate limit exceeded\n");
    assert.equal(run.status, 1);
  });

  test("warns of each pull request whose checks the token may not read, moves the others, and still succeeds", () => {
    const run = sweep(answer([node({ repo: "AntelopeJS/dms-saas", rollup: null }), node()], [hiddenRollup(0)]));
    assert.equal(
      run.stdout,
      "::warning::AntelopeJS/dms-saas#49: search.nodes.0.commits.nodes.0.commit.statusCheckRollup: Resource not accessible by integration\n" +
        "- AntelopeJS/brevo-private#49: re-arm auto-merge (green, removed from the merge queue)\n" +
        "1 pull request could not be read: the release app needs Checks and Commit statuses read access\n",
    );
    assert.equal(run.status, 0);
  });

  test("leaves out a pull request of a held repository before its checks are judged", () => {
    const run = sweep(answer([node({ repo: "AntelopeJS/cloud", rollup: null })], [hiddenRollup(0)]));
    assert.equal(run.stdout, "");
    assert.equal(run.status, 0);
  });

  test("still fails when the check rollup failed for another reason than the token's access", () => {
    const run = sweep(answer([node({ repo: "AntelopeJS/dms-saas", rollup: null })], [hiddenRollup(0, "INTERNAL")]));
    assert.equal(run.stdout, "::warning::AntelopeJS/dms-saas#49: search.nodes.0.commits.nodes.0.commit.statusCheckRollup: Resource not accessible by integration\n");
    assert.equal(run.status, 1);
  });

  test("still fails on an error other than unreadable checks", () => {
    const run = sweep(answer([node()], [{ type: "INTERNAL", message: "Something went wrong" }]));
    assert.equal(run.stdout, "::warning::?: Something went wrong\n- AntelopeJS/brevo-private#49: re-arm auto-merge (green, removed from the merge queue)\n");
    assert.equal(run.status, 1);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Json } from "../ci-metrics/json.ts";
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
}

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
    commits: { nodes: [{ commit: { oid: "a".repeat(40), statusCheckRollup: scene.rollup === null ? null : { state: scene.rollup ?? "SUCCESS" } } }] },
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
    assert.equal(moveOf(pull(), current), "rearm");
  });

  test("leaves a green pull request alone unless the queue removed it and nothing armed it since", () => {
    assert.equal(moveOf(pull({ autoMerge: true, last: "AutoMergeEnabledEvent" }), current), "none");
    assert.equal(moveOf(pull({ last: "AutoMergeDisabledEvent" }), current), "none", "someone turned auto-merge off");
    assert.equal(moveOf(pull({ last: null }), current), "none", "auto-merge was never armed");
    assert.equal(moveOf(pull({ inQueue: true, last: "AddedToMergeQueueEvent" }), current), "none");
  });

  test("never arms auto-merge where it would not land through a merge queue or on a held repository", () => {
    assert.equal(moveOf(pull({ mergeQueue: false }), current), "none");
    assert.equal(moveOf(pull({ repo: "AntelopeJS/cloud" }), current), "none");
    assert.equal(moveOf(pull({ mergeable: "CONFLICTING" }), current), "none");
    assert.equal(moveOf(pull({ draft: true }), current), "none");
  });

  test("asks Renovate to rebase a red pull request once its base moved past its head", () => {
    assert.equal(moveOf(pull({ rollup: "FAILURE", autoMerge: true, last: "AutoMergeEnabledEvent" }), behind), "rebase");
    assert.equal(moveOf(pull({ rollup: "ERROR", last: "RemovedFromMergeQueueEvent" }), behind), "rebase");
  });

  test("asks at most once per base commit: not while the head holds the base, nor while the request is pending", () => {
    assert.equal(moveOf(pull({ rollup: "FAILURE" }), current), "none");
    const asked = pull({ rollup: "FAILURE", body: tickRebase(BODY) });
    assert.equal(asked.rebaseBox, "ticked");
    assert.equal(moveOf(asked, behind), "none");
  });

  test("reads the base only for a red pull request with an unticked rebase checkbox", () => {
    let reads = 0;
    const counted = () => {
      reads++;
      return true;
    };
    moveOf(pull(), counted);
    moveOf(pull({ rollup: "PENDING" }), counted);
    moveOf(pull({ rollup: null }), counted);
    moveOf(pull({ rollup: "FAILURE", body: "no checkbox" }), counted);
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

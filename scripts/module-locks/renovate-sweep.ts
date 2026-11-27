import { isBoolean, isList, isNumber, isObject, isText, textOf, type Json } from "../ci-metrics/json.ts";

/** Repositories whose default branch only Antony merges into: the sweep never arms auto-merge there. */
export const HELD_REPOSITORIES: ReadonlySet<string> = new Set([
  "AntelopeJS/cloud",
  "AntelopeJS/k8s-gitops-infra",
  "AntelopeJS/antelope-hardening",
  "AntelopeJS/antelope-compliance",
]);

const UNTICKED_REBASE = "- [ ] <!-- rebase-check -->";
const TICKED_REBASE = "- [x] <!-- rebase-check -->";

/** The combined state of a head commit's checks. */
export type Checks = "green" | "red" | "pending";

/** An open Renovate pull request, as the search of the sweep reads it. */
export interface RenovatePull {
  repo: string;
  number: number;
  headRef: string;
  baseRef: string;
  headSha: string;
  /** The base is the repository's default branch, and that branch has a merge queue. */
  queuedBase: boolean;
  draft: boolean;
  checks: Checks;
  autoMergeArmed: boolean;
  inQueue: boolean;
  conflicting: boolean;
  /** Its last merge-queue or auto-merge event is a removal from the queue. */
  removedFromQueue: boolean;
  /** Renovate's rebase checkbox: unticked, ticked and not yet handled, or absent from the body. */
  rebaseBox: "unticked" | "ticked" | "absent";
  body: string;
}

/** What the sweep does to a pull request. */
export type Move = "rearm" | "rebase" | "none";

function checksOf(state: string | null): Checks {
  if (state === "SUCCESS") return "green";
  if (state === "FAILURE" || state === "ERROR") return "red";
  return "pending";
}

function rebaseBoxOf(body: string): RenovatePull["rebaseBox"] {
  if (body.includes(UNTICKED_REBASE)) return "unticked";
  if (body.includes(TICKED_REBASE)) return "ticked";
  return "absent";
}

interface Repository {
  repo: string;
  defaultBranch: string | null;
  mergeQueue: boolean;
}

function parseRepository(raw: Json | undefined): Repository | null {
  if (!isObject(raw) || !isText(raw.nameWithOwner) || raw.isArchived !== false) return null;
  const defaultBranch = isObject(raw.defaultBranchRef) ? textOf(raw.defaultBranchRef.name) : null;
  return { repo: raw.nameWithOwner, defaultBranch, mergeQueue: isObject(raw.mergeQueue) };
}

const first = (connection: Json | undefined): Json | undefined =>
  isObject(connection) && isList(connection.nodes) ? connection.nodes[0] : undefined;

/** A pull request node of the sweep's search, or `null` when it is not one from a `renovate/` branch of its own repository. */
export function parsePull(raw: Json): RenovatePull | null {
  if (!isObject(raw) || !isNumber(raw.number) || !isText(raw.headRefName) || !isText(raw.baseRefName) || !isText(raw.body)) return null;
  if (!raw.headRefName.startsWith("renovate/") || raw.isCrossRepository !== false) return null;
  const repository = parseRepository(raw.repository);
  if (repository === null) return null;
  const tip = first(raw.commits);
  const commit = isObject(tip) && isObject(tip.commit) ? tip.commit : null;
  if (commit === null || !isText(commit.oid)) return null;
  const rollup = isObject(commit.statusCheckRollup) ? textOf(commit.statusCheckRollup.state) : null;
  const last = first(raw.timelineItems);
  return {
    repo: repository.repo,
    number: raw.number,
    headRef: raw.headRefName,
    baseRef: raw.baseRefName,
    headSha: commit.oid,
    queuedBase: repository.defaultBranch === raw.baseRefName && repository.mergeQueue,
    draft: isBoolean(raw.isDraft) && raw.isDraft,
    checks: checksOf(rollup),
    autoMergeArmed: isObject(raw.autoMergeRequest),
    inQueue: isBoolean(raw.isInMergeQueue) && raw.isInMergeQueue,
    conflicting: raw.mergeable === "CONFLICTING",
    removedFromQueue: isObject(last) && last.__typename === "RemovedFromMergeQueueEvent",
    rebaseBox: rebaseBoxOf(raw.body),
    body: raw.body,
  };
}

/**
 * The move for a pull request. `behind` tells whether its head lacks commits of its base; the sweep calls it only
 * for a red pull request whose rebase checkbox is unticked.
 *
 * A green pull request the queue removed gets auto-merge back. A red one whose base moved since its head was built
 * gets Renovate's rebase checkbox ticked, so Renovate rebases it once on the newer base and its checks run again.
 * Once rebased it is no longer behind, so it gets no second request before the base moves again.
 */
export function moveOf(pull: RenovatePull, behind: () => boolean): Move {
  if (pull.draft || pull.inQueue || HELD_REPOSITORIES.has(pull.repo)) return "none";
  if (pull.checks === "green") {
    const rearm = pull.queuedBase && pull.removedFromQueue && !pull.autoMergeArmed && !pull.conflicting;
    return rearm ? "rearm" : "none";
  }
  if (pull.checks === "red" && pull.rebaseBox === "unticked" && behind()) return "rebase";
  return "none";
}

/** The body with Renovate's rebase checkbox ticked. */
export function tickRebase(body: string): string {
  return body.replace(UNTICKED_REBASE, TICKED_REBASE);
}

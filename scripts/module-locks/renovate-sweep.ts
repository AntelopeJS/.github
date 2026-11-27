import { isBoolean, isList, isNumber, isObject, isText, textOf, type Json } from "../ci-metrics/json.ts";

/** Repositories whose default branch only Antony merges into: the sweep never arms auto-merge there. */
export const HELD_REPOSITORIES: ReadonlySet<string> = new Set([
  "AntelopeJS/cloud",
  "AntelopeJS/k8s-gitops-infra",
  "AntelopeJS/antelope-hardening",
  "AntelopeJS/antelope-compliance",
]);

/** The authors whose commits Renovate rebases away without losing anyone's work: itself and the Renovate sync. */
const BOT_AUTHORS: ReadonlySet<string> = new Set([
  "29139614+renovate[bot]@users.noreply.github.com",
  "41898282+github-actions[bot]@users.noreply.github.com",
]);

/** What Renovate writes in the body once someone else pushed to its branch. */
const FOREIGN_COMMIT_NOTES = ["does not recognize the last commit author", "custom changes will be lost"];

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
  /**
   * Its last merge-queue or auto-merge event is a removal by the queue itself, not by a person, and the queue removed
   * its current head at most once: one re-arm per head, so a head the queue keeps removing is not re-armed forever.
   */
  retryAfterRemoval: boolean;
  /** The head commit is Renovate's or the Renovate sync's, and Renovate noted no one else's commit: a rebase loses nobody's change. */
  botOnly: boolean;
  /** Renovate's rebase checkbox: unticked, ticked and not yet handled, or absent from the body. */
  rebaseBox: "unticked" | "ticked" | "absent";
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

const QUEUE_ACTOR = "github-merge-queue";

/**
 * Whether the last two queue removals, newest last, leave the head committed at `committedAt` one retry: the newest
 * was made by the queue, and at most one of them came after that commit.
 */
function retryable(removals: Json | undefined, committedAt: string | null): boolean {
  if (committedAt === null || !isObject(removals) || !isList(removals.nodes)) return false;
  const nodes = removals.nodes.filter(isObject);
  const newest = nodes.at(-1);
  if (newest === undefined || !isObject(newest.actor) || newest.actor.login !== QUEUE_ACTOR) return false;
  const sinceHead = nodes.filter((node) => isText(node.createdAt) && Date.parse(node.createdAt) > Date.parse(committedAt));
  return sinceHead.length <= 1;
}

const first = (connection: Json | undefined): Json | undefined =>
  isObject(connection) && isList(connection.nodes) ? connection.nodes[0] : undefined;

/** The head commit of a pull request node. */
interface Head {
  sha: string;
  committedAt: string | null;
  author: string | null;
  checks: Checks;
}

function parseHead(commits: Json | undefined): Head | null {
  const tip = first(commits);
  const commit = isObject(tip) && isObject(tip.commit) ? tip.commit : null;
  if (commit === null || !isText(commit.oid)) return null;
  return {
    sha: commit.oid,
    committedAt: textOf(commit.committedDate),
    author: isObject(commit.author) ? textOf(commit.author.email) : null,
    checks: checksOf(isObject(commit.statusCheckRollup) ? textOf(commit.statusCheckRollup.state) : null),
  };
}

/** A pull request node of the sweep's search, or `null` when it is not one from a `renovate/` branch of its own repository. */
export function parsePull(raw: Json): RenovatePull | null {
  if (!isObject(raw) || !isNumber(raw.number) || !isText(raw.headRefName) || !isText(raw.baseRefName) || !isText(raw.body)) return null;
  if (!raw.headRefName.startsWith("renovate/") || raw.isCrossRepository !== false) return null;
  const repository = parseRepository(raw.repository);
  if (repository === null) return null;
  const head = parseHead(raw.commits);
  if (head === null) return null;
  const body = raw.body;
  const last = first(raw.timelineItems);
  return {
    repo: repository.repo,
    number: raw.number,
    headRef: raw.headRefName,
    baseRef: raw.baseRefName,
    headSha: head.sha,
    queuedBase: repository.defaultBranch === raw.baseRefName && repository.mergeQueue,
    draft: isBoolean(raw.isDraft) && raw.isDraft,
    checks: head.checks,
    autoMergeArmed: isObject(raw.autoMergeRequest),
    inQueue: isBoolean(raw.isInMergeQueue) && raw.isInMergeQueue,
    conflicting: raw.mergeable === "CONFLICTING",
    retryAfterRemoval: isObject(last) && last.__typename === "RemovedFromMergeQueueEvent" && retryable(raw.removals, head.committedAt),
    botOnly: head.author !== null && BOT_AUTHORS.has(head.author) && !FOREIGN_COMMIT_NOTES.some((note) => body.includes(note)),
    rebaseBox: rebaseBoxOf(body),
  };
}

/**
 * The move for a pull request. `behind` tells whether its head lacks commits of its base; the sweep calls it only
 * for a red pull request of bot commits whose rebase checkbox is unticked.
 *
 * A green pull request the queue removed gets auto-merge back, once per head. A red one whose base moved since its
 * head was built gets Renovate's rebase checkbox ticked, so Renovate rebases it once on the newer base and its checks
 * run again. Once rebased it is no longer behind, so it gets no second request before the base moves again.
 */
export function moveOf(pull: RenovatePull, behind: () => boolean): Move {
  if (pull.draft || pull.inQueue || HELD_REPOSITORIES.has(pull.repo)) return "none";
  if (pull.checks === "green") {
    const rearm = pull.queuedBase && pull.retryAfterRemoval && !pull.autoMergeArmed && !pull.conflicting;
    return rearm ? "rearm" : "none";
  }
  if (pull.checks === "red" && pull.botOnly && pull.rebaseBox === "unticked" && behind()) return "rebase";
  return "none";
}

/** The body with Renovate's rebase checkbox ticked. */
export function tickRebase(body: string): string {
  return body.replace(UNTICKED_REBASE, TICKED_REBASE);
}

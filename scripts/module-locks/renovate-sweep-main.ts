import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { isList, isNumber, isObject, isText, parseJson, type Json } from "../ci-metrics/json.ts";
import { moveOf, parsePull, tickRebase, type RenovatePull } from "./renovate-sweep.ts";

const usage = `usage: node scripts/module-locks/renovate-sweep-main.ts <organisation> [--dry-run]

Re-arms auto-merge on each green Renovate pull request of the organisation that the merge queue removed, and ticks
Renovate's rebase checkbox on each red one whose base moved since its head was built. Prints one Markdown line per
move; --dry-run prints them without making them.
`;

const SEARCH = `query($search: String!, $cursor: String) {
  search(query: $search, type: ISSUE, first: 20, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number isDraft headRefName baseRefName isCrossRepository isInMergeQueue mergeable body
        autoMergeRequest { enabledAt }
        repository { nameWithOwner isArchived defaultBranchRef { name } mergeQueue { id } }
        commits(last: 1) { nodes { commit { oid committedDate author { email } statusCheckRollup { state } } } }
        removals: timelineItems(last: 2, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) { nodes { ... on RemovedFromMergeQueueEvent { createdAt actor { login } } } }
        timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT, AUTO_MERGE_ENABLED_EVENT, AUTO_MERGE_DISABLED_EVENT]) {
          nodes { __typename }
        }
      }
    }
  }
}`;

/** Room for a page of Renovate bodies, each up to 65536 characters: Node's default of 1 MiB cut a page of 50 short. */
const MAX_ANSWER = 64 * 1024 * 1024;
const ATTEMPTS = 3;

const gh = (args: string[], input?: string): string => execFileSync("gh", args, { encoding: "utf8", input, maxBuffer: MAX_ANSWER });

/** The JSON of one answer of `gh api graphql`, or `undefined` when `gh` could not be run or answered no JSON. */
function parseAnswer(result: SpawnSyncReturns<string>): Json | undefined {
  if (result.error !== undefined) return undefined;
  try {
    return parseJson(result.stdout);
  } catch {
    return undefined;
  }
}

/** The first line the texts hold, cut to 200 characters, since a cut JSON answer is one line of a megabyte. */
const firstLine = (...texts: string[]): string =>
  (texts.flatMap((text) => text.split("\n")).find((line) => line.trim() !== "") ?? "nothing").slice(0, 200);

function warnErrors(answer: Json): void {
  if (!isObject(answer) || !isList(answer.errors)) return;
  for (const entry of answer.errors) {
    const path = isObject(entry) && isList(entry.path) ? entry.path.map((part) => (isText(part) || isNumber(part) ? String(part) : "?")).join(".") : "?";
    const message = isObject(entry) && isText(entry.message) ? entry.message : "unknown error";
    process.stdout.write(`::warning::${path}: ${message}\n`);
  }
}

/**
 * The answer of a GraphQL query, asked up to three times while GitHub answers something that is not JSON. A field the
 * token may not read comes back null with an error, and `gh` then exits nonzero; each such error is printed as a
 * warning, and the pull request it hides is left alone.
 */
function graphql(args: string[]): Json {
  let last = "nothing";
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const result = spawnSync("gh", ["api", "graphql", ...args], { encoding: "utf8", maxBuffer: MAX_ANSWER });
    const answer = parseAnswer(result);
    if (answer !== undefined) {
      warnErrors(answer);
      return answer;
    }
    last = firstLine(result.error?.message ?? "", result.stdout, result.stderr);
  }
  throw new Error(`gh api graphql answered no JSON ${ATTEMPTS} times; the last answer: ${last}`);
}

function searchPulls(org: string): RenovatePull[] {
  const pulls: RenovatePull[] = [];
  let cursor: string | null = null;
  do {
    const args = ["-f", `query=${SEARCH}`, "-f", `search=org:${org} is:pr is:open archived:false author:app/renovate`];
    if (cursor !== null) args.push("-f", `cursor=${cursor}`);
    const page = graphql(args);
    const search = isObject(page) && isObject(page.data) ? page.data.search : undefined;
    if (!isObject(search) || !isList(search.nodes) || !isObject(search.pageInfo)) throw new Error("The pull request search answered no search result.");
    pulls.push(...search.nodes.flatMap((node) => parsePull(node) ?? []));
    cursor = search.pageInfo.hasNextPage === true && isText(search.pageInfo.endCursor) ? search.pageInfo.endCursor : null;
  } while (cursor !== null);
  return pulls;
}

function isBehind(pull: RenovatePull): boolean {
  const comparison = parseJson(gh(["api", `repos/${pull.repo}/compare/${encodeURIComponent(pull.baseRef)}...${pull.headSha}`]));
  return isObject(comparison) && isNumber(comparison.behind_by) && comparison.behind_by > 0;
}

function rearm(pull: RenovatePull): void {
  gh(["pr", "merge", "-R", pull.repo, String(pull.number), "--squash", "--auto"]);
}

/** Ticks the rebase checkbox in the body as it is now, since Renovate may have rewritten it since the search. */
function requestRebase(pull: RenovatePull): void {
  const body = gh(["pr", "view", "-R", pull.repo, String(pull.number), "--json", "body", "--jq", ".body"]).replace(/\n$/, "");
  const ticked = tickRebase(body);
  if (ticked !== body) gh(["pr", "edit", "-R", pull.repo, String(pull.number), "--body-file", "-"], ticked);
}

const [org, flag] = process.argv.slice(2);
if (org === undefined || org === "--help" || (flag !== undefined && flag !== "--dry-run")) {
  process.stdout.write(usage);
  process.exit(org === "--help" ? 0 : 2);
}
const dryRun = flag === "--dry-run";

let pulls: RenovatePull[];
try {
  pulls = searchPulls(org);
} catch (error) {
  process.stdout.write(`::error::${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`);
  process.exit(1);
}
let failed = 0;
for (const pull of pulls) {
  const link = `${pull.repo}#${pull.number}`;
  try {
    const move = moveOf(pull, () => isBehind(pull));
    if (move === "rearm") {
      if (!dryRun) rearm(pull);
      process.stdout.write(`- ${link}: re-arm auto-merge (green, removed from the merge queue)\n`);
    } else if (move === "rebase") {
      if (!dryRun) requestRebase(pull);
      process.stdout.write(`- ${link}: ask Renovate to rebase (red, behind ${pull.baseRef})\n`);
    }
  } catch (error) {
    failed = 1;
    process.stdout.write(`::error::${link}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`);
  }
}
process.exit(failed);

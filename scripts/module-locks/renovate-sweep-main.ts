import { execFileSync } from "node:child_process";
import { isList, isNumber, isObject, isText, parseJson, type Json } from "../ci-metrics/json.ts";
import { moveOf, parsePull, tickRebase, type RenovatePull } from "./renovate-sweep.ts";

const usage = `usage: node scripts/module-locks/renovate-sweep-main.ts <organisation> [--dry-run]

Re-arms auto-merge on each green Renovate pull request of the organisation that the merge queue removed, and ticks
Renovate's rebase checkbox on each red one whose base moved since its head was built. Prints one Markdown line per
move; --dry-run prints them without making them.
`;

const SEARCH = `query($search: String!, $cursor: String) {
  search(query: $search, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number isDraft headRefName baseRefName isCrossRepository isInMergeQueue mergeable body
        autoMergeRequest { enabledAt }
        repository { nameWithOwner isArchived defaultBranchRef { name } mergeQueue { id } }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
        timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT, AUTO_MERGE_ENABLED_EVENT, AUTO_MERGE_DISABLED_EVENT]) {
          nodes { __typename }
        }
      }
    }
  }
}`;

const gh = (args: string[], input?: string): string => execFileSync("gh", args, { encoding: "utf8", input });

function searchPulls(org: string): RenovatePull[] {
  const pulls: RenovatePull[] = [];
  let cursor: string | null = null;
  do {
    const args = ["api", "graphql", "-f", `query=${SEARCH}`, "-f", `search=org:${org} is:pr is:open archived:false author:app/renovate`];
    if (cursor !== null) args.push("-f", `cursor=${cursor}`);
    const page: Json = parseJson(gh(args));
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

function requestRebase(pull: RenovatePull): void {
  gh(["api", "-X", "PATCH", `repos/${pull.repo}/pulls/${pull.number}`, "--input", "-"], JSON.stringify({ body: tickRebase(pull.body) }));
}

const [org, flag] = process.argv.slice(2);
if (org === undefined || org === "--help" || (flag !== undefined && flag !== "--dry-run")) {
  process.stdout.write(usage);
  process.exit(org === "--help" ? 0 : 2);
}
const dryRun = flag === "--dry-run";

let failed = 0;
for (const pull of searchPulls(org)) {
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

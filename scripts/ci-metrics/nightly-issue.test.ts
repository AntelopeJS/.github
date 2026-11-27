import assert from "node:assert/strict";
import { test } from "node:test";
import { isObject, parseJson } from "./json.ts";
import {
  findNightlyIssue,
  formatNightlyIssue,
  issueApi,
  nightlyIssueTitle,
  parseOpenIssue,
  planNightlyIssue,
  syncNightlyIssue,
  type OpenIssue,
} from "./nightly-issue.ts";
import { nightlyReport, type Nightly, type NightlyDataset, type NightlyJob, type RepoNightlies } from "./nightly.ts";

const day = (n: number): string => new Date(Date.UTC(2026, 10, n, 2, 25)).toISOString();
const runUrl = "https://github.com/AntelopeJS/.github/actions/runs/7";

let nextId = 1;
function job(name: string, conclusion: string): NightlyJob {
  return { id: nextId++, name, attempt: 1, conclusion, started: true, failedStep: conclusion === "failure" ? "Run tests" : null };
}

function nightly(n: number, jobs?: NightlyJob[]): Nightly {
  const conclusion = jobs?.some((one) => one.conclusion === "failure") === true ? "failure" : "success";
  const built: Nightly = { id: 1000 + n, sha: `s${n}`, startedAt: day(n), conclusion, url: `https://github.com/AntelopeJS/dms/actions/runs/${1000 + n}` };
  if (jobs !== undefined) built.jobs = jobs;
  return built;
}

const repo = (name: string, nightlies: Nightly[]): RepoNightlies => ({ repo: name, nightlies, queue: {}, commits: {}, annotations: {} });
const dataset = (...repos: RepoNightlies[]): NightlyDataset => ({ org: "AntelopeJS", to: day(20), days: 30, repos });

const redReport = () => nightlyReport(dataset(
  repo("dms", [nightly(16), nightly(17, [job("ci / Test 24", "failure")]), nightly(18, [job("ci / Test 24", "failure"), job("e2e (2)", "failure")])]),
  repo("redis", [nightly(18)]),
));
const greenReport = () => nightlyReport(dataset(repo("dms", [nightly(17), nightly(18)]), repo("redis", [nightly(18)])));

const open = (fields: Partial<OpenIssue> = {}): OpenIssue => ({
  number: 12, title: nightlyIssueTitle, body: "", author: "github-actions[bot]", isPullRequest: false, ...fields,
});

test("a red night lists each red latest nightly with its run and failed jobs, and which also failed the night before", () => {
  const issue = formatNightlyIssue(redReport(), runUrl);
  assert.equal(issue.red, true);
  assert.match(issue.body, /^\*\*1 of 2\*\* repositories with a merge queue failed their latest nightly, as of 2026-11-20 02:25 UTC\.$/m);
  assert.match(
    issue.body,
    /^\| dms \| \[2026-11-18 02:25 UTC\]\(https:\/\/github\.com\/AntelopeJS\/dms\/actions\/runs\/1018\) \| `ci \/ Test 24`, also the night before<br>`e2e \(2\)` \|$/m,
  );
  assert.doesNotMatch(issue.body, /redis/);
  assert.match(issue.body, /Report run: https:\/\/github\.com\/AntelopeJS\/\.github\/actions\/runs\/7\./);
  assert.match(issue.body, /cannot read the private and internal ones/);
  assert.ok(issue.body.includes(issue.table));
  assert.ok(issue.comment.includes(issue.table));
});

test("a job name comes out as a code span, so the issue mentions nobody and keeps its columns", () => {
  const report = nightlyReport(dataset(repo("dms", [nightly(18, [job("e2e @smoke | `shard` 1", "failure")])])));
  const { body } = formatNightlyIssue(report, runUrl);
  assert.match(body, /`e2e @smoke \\\| 'shard' 1`/);
  assert.doesNotMatch(body.replaceAll(/`[^`]*`/g, ""), /@/);
});

test("a green night says every latest nightly passed and has no table", () => {
  const issue = formatNightlyIssue(greenReport(), runUrl);
  assert.equal(issue.red, false);
  assert.equal(issue.table, "");
  assert.match(issue.comment, /^Every latest nightly passed as of 2026-11-20 02:25 UTC, in all 2 repositories with a merge queue\. Report run: /);
});

test("the plan opens on a red night, updates when the red nightlies changed, and closes once the night is green", () => {
  const red = formatNightlyIssue(redReport(), runUrl);
  const green = formatNightlyIssue(greenReport(), runUrl);
  assert.deepEqual(planNightlyIssue(null, red), { kind: "create" });
  assert.deepEqual(planNightlyIssue(open({ body: "an older table" }), red), { kind: "update", number: 12 });
  assert.deepEqual(planNightlyIssue(open({ body: red.body.replace(runUrl, "an earlier run") }), red), { kind: "none", number: 12 });
  assert.deepEqual(planNightlyIssue(open(), green), { kind: "close", number: 12 });
  assert.deepEqual(planNightlyIssue(null, green), { kind: "none", number: null });
});

test("the report's issue is the open one the workflow titled, never a pull request or another author's", () => {
  assert.equal(findNightlyIssue([open({ isPullRequest: true }), open({ author: "someone" }), open({ title: "Nightly CI" })]), null);
  assert.equal(findNightlyIssue([open({ title: "other" }), open({ number: 40 })])?.number, 40);
  assert.deepEqual(parseOpenIssue({ number: 3, title: "t", body: null, user: { login: "github-actions[bot]" }, pull_request: {} }), {
    number: 3, title: "t", body: "", author: "github-actions[bot]", isPullRequest: true,
  });
  assert.equal(parseOpenIssue({ title: "no number" }), null);
});

test("the sync opens the issue, then updates it with a comment, then comments and closes it", async () => {
  const calls: string[] = [];
  let listed: unknown[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = String(input).replace("https://api.github.com/repos/AntelopeJS/.github", "");
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer test-token");
    const text = await new Response(init?.body).text();
    const sent = text === "" ? null : parseJson(text);
    calls.push(`${method} ${path}${isObject(sent) ? ` ${Object.keys(sent).join(",")}` : ""}`);
    if (method === "GET") return Response.json(listed);
    if (method === "POST" && path === "/issues") return Response.json({ number: 51 }, { status: 201 });
    return Response.json({}, { status: 200 });
  };
  const api = issueApi("AntelopeJS/.github", "test-token", fetcher);
  const red = formatNightlyIssue(redReport(), runUrl);

  assert.deepEqual(await syncNightlyIssue(api, red), { kind: "create", number: 51 });
  listed = [{ number: 51, title: nightlyIssueTitle, body: "an older table", user: { login: "github-actions[bot]" } }];
  assert.deepEqual(await syncNightlyIssue(api, red), { kind: "update", number: 51 });
  listed = [{ number: 51, title: nightlyIssueTitle, body: red.body, user: { login: "github-actions[bot]" } }];
  assert.deepEqual(await syncNightlyIssue(api, red), { kind: "none", number: 51 });
  assert.deepEqual(await syncNightlyIssue(api, formatNightlyIssue(greenReport(), runUrl)), { kind: "close", number: 51 });

  const list = "GET /issues?state=open&creator=github-actions%5Bbot%5D&per_page=100&page=1";
  assert.deepEqual(calls, [
    list, "POST /issues title,body",
    list, "PATCH /issues/51 body", "POST /issues/51/comments body",
    list,
    list, "POST /issues/51/comments body", "PATCH /issues/51 state,state_reason",
  ]);
});

test("an answer that is not a success stops the sync", async () => {
  const fetcher = async (): Promise<Response> => new Response("Resource not accessible by integration", { status: 403 });
  await assert.rejects(
    syncNightlyIssue(issueApi("AntelopeJS/.github", "test-token", fetcher), formatNightlyIssue(redReport(), runUrl)),
    /GET \/issues\?state=open.*: 403 Resource not accessible by integration/,
  );
});

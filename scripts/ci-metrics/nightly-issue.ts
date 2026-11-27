import { isList, isNumber, isObject, isText, parseJson, textOf, type Json } from "./json.ts";
import { failedLatest, type Failure, type NightlyReport, type RepoNightlyReport } from "./nightly.ts";

/** The title of the one issue the nightly report keeps open while a latest nightly is red. */
export const nightlyIssueTitle = "Nightly CI report";

/** The account the workflow's `GITHUB_TOKEN` writes as, the only author whose issue the report updates. */
export const nightlyIssueAuthor = "github-actions[bot]";

/** What the issue says about one report. */
export interface NightlyIssue {
  /** Whether the latest nightly of a repository failed. */
  red: boolean;
  /** The table of the red repositories, the part of the body that changes only when the nightlies do. */
  table: string;
  body: string;
  /** What a comment says: the table on a red night, the all-clear on a green one. */
  comment: string;
}

/** An open issue or pull request of the repository, as the issues API lists it. */
export interface OpenIssue {
  number: number;
  title: string;
  body: string;
  author: string;
  isPullRequest: boolean;
}

/** What the report does to the issue. */
export type IssueAction =
  | { kind: "create" }
  | { kind: "update"; number: number }
  | { kind: "close"; number: number }
  | { kind: "none"; number: number | null };

const hourMs = 3_600_000;

/** The text as a Markdown code span in a table cell: no mention, link or column break can come out of it. */
const code = (text: string): string => `\`${text.replaceAll("`", "'").replaceAll("|", "\\|").replaceAll("\n", " ")}\``;

const minute = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** Whether the same job of the same repository failed the nightly that ran 12 to 36 hours before this one. */
function failedTheNightBefore(report: NightlyReport, failure: Failure): boolean {
  const at = Date.parse(failure.nightly.startedAt);
  return report.failures.some((other) => {
    const before = at - Date.parse(other.nightly.startedAt);
    return other.repo === failure.repo && other.job === failure.job && other.nightly.id !== failure.nightly.id
      && before > 12 * hourMs && before < 36 * hourMs;
  });
}

function jobsCell(report: NightlyReport, failures: readonly Failure[]): string {
  if (failures.length === 0) return "no job failed in its first attempt";
  return failures.map((failure) => {
    const infra = failure.kind === "infra" ? ", runner or network" : "";
    const again = failedTheNightBefore(report, failure) ? ", also the night before" : "";
    return `${code(failure.job)}${infra}${again}`;
  }).join("<br>");
}

function row(report: NightlyReport, repo: RepoNightlyReport): string[] {
  const { latest } = repo;
  if (latest === null) return [];
  const { nightly, failures } = latest;
  return [`| ${repo.repo} | [${minute(nightly.startedAt)}](${nightly.url}) | ${jobsCell(report, failures)} |`];
}

/**
 * The issue a report writes: on a red night, the repositories whose latest nightly failed, each with a link to
 * that run and its failed jobs. Names come out as code spans, so a job name never mentions or links anyone.
 */
export function formatNightlyIssue(report: NightlyReport, runUrl: string): NightlyIssue {
  const red = failedLatest(report);
  const total = report.repos.length;
  const asOf = minute(report.window.to);
  const coverage = "It covers the public repositories with a merge queue: the workflow's token cannot read the private and internal ones.";
  if (red.length === 0) {
    const comment = `Every latest nightly passed as of ${asOf}, in all ${total} repositories with a merge queue. Report run: ${runUrl}`;
    return { red: false, table: "", body: comment, comment };
  }
  const table = [
    "| repository | latest nightly | failed jobs |",
    "| --- | --- | --- |",
    ...red.flatMap((repo) => row(report, repo)),
  ].join("\n");
  const summary = `**${red.length} of ${total}** repositories with a merge queue failed their latest nightly, as of ${asOf}.`;
  const body = [
    summary,
    "",
    table,
    "",
    `Report run: ${runUrl}. The nightly report workflow updates this issue after each night and closes it once every latest nightly passes. ${coverage}`,
    "",
  ].join("\n");
  return { red: true, table, body, comment: `${summary}\n\n${table}\n\nReport run: ${runUrl}\n` };
}

/** The report's issue among the open issues: the one titled {@link nightlyIssueTitle} that the workflow opened. */
export function findNightlyIssue(issues: readonly OpenIssue[]): OpenIssue | null {
  return issues.find((issue) => issue.title === nightlyIssueTitle && issue.author === nightlyIssueAuthor && !issue.isPullRequest) ?? null;
}

/**
 * What to do with the issue: open it on a red night, update it when the red nightlies changed, close it once
 * every latest nightly passed, and leave it alone otherwise.
 */
export function planNightlyIssue(existing: OpenIssue | null, issue: NightlyIssue): IssueAction {
  if (!issue.red) return existing === null ? { kind: "none", number: null } : { kind: "close", number: existing.number };
  if (existing === null) return { kind: "create" };
  return existing.body.includes(issue.table) ? { kind: "none", number: existing.number } : { kind: "update", number: existing.number };
}

/** An item of the REST API's issues list, or `null` when the value is not one. */
export function parseOpenIssue(raw: Json): OpenIssue | null {
  if (!isObject(raw) || !isNumber(raw.number) || !isText(raw.title)) return null;
  const author = isObject(raw.user) ? textOf(raw.user.login) : null;
  return { number: raw.number, title: raw.title, body: textOf(raw.body) ?? "", author: author ?? "", isPullRequest: raw.pull_request !== undefined };
}

/** The calls the report makes on the issues of one repository. */
export interface IssueApi {
  listOpen(): Promise<OpenIssue[]>;
  create(title: string, body: string): Promise<number>;
  update(number: number, body: string): Promise<void>;
  comment(number: number, body: string): Promise<void>;
  close(number: number): Promise<void>;
}

/** The issues API of `repo` (`owner/name`) with `token`. Any answer that is not a success throws. */
export function issueApi(repo: string, token: string, fetcher: typeof fetch = fetch): IssueApi {
  const call = async (method: string, path: string, body?: Record<string, string>): Promise<Json> => {
    const response = await fetcher(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "antelopejs-ci-metrics",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
    return text === "" ? null : parseJson(text);
  };
  return {
    async listOpen() {
      const issues: OpenIssue[] = [];
      for (let page = 1; ; page++) {
        const listed = await call("GET", `/issues?state=open&creator=${encodeURIComponent(nightlyIssueAuthor)}&per_page=100&page=${page}`);
        if (!isList(listed)) return issues;
        issues.push(...listed.flatMap((raw) => parseOpenIssue(raw) ?? []));
        if (listed.length < 100) return issues;
      }
    },
    async create(title, body) {
      const created = await call("POST", "/issues", { title, body });
      if (!isObject(created) || !isNumber(created.number)) throw new Error("POST /issues: the answer names no issue number");
      return created.number;
    },
    async update(number, body) {
      await call("PATCH", `/issues/${number}`, { body });
    },
    async comment(number, body) {
      await call("POST", `/issues/${number}/comments`, { body });
    },
    async close(number) {
      await call("PATCH", `/issues/${number}`, { state: "closed", state_reason: "completed" });
    },
  };
}

/** What the report did to the issue, and the issue's number when there is one. */
export interface IssueResult {
  kind: IssueAction["kind"];
  number: number | null;
}

/**
 * Opens, updates or closes the report's issue for `issue`. An update rewrites the body and comments with the
 * night's table, so the people who watch the repository get one notification per night that changed.
 */
export async function syncNightlyIssue(api: IssueApi, issue: NightlyIssue): Promise<IssueResult> {
  const action = planNightlyIssue(findNightlyIssue(await api.listOpen()), issue);
  switch (action.kind) {
    case "create":
      return { kind: "create", number: await api.create(nightlyIssueTitle, issue.body) };
    case "update":
      await api.update(action.number, issue.body);
      await api.comment(action.number, issue.comment);
      return action;
    case "close":
      await api.comment(action.number, issue.comment);
      await api.close(action.number);
      return action;
    case "none":
      return action;
  }
}

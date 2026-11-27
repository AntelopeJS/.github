import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseJson } from "./json.ts";
import { formatNightlyIssue, issueApi, syncNightlyIssue } from "./nightly-issue.ts";
import { nightlyReport, parseNightlyDataset } from "./nightly.ts";

const usage = `usage: node scripts/ci-metrics/nightly-issue-main.ts --load <dataset> --repo <owner/name> --run-url <url> [--dry-run]

Opens, updates or closes the "Nightly CI report" issue of a repository from a dataset that nightly-main.ts --save
wrote: open while the latest nightly of a repository is red, closed once every latest nightly passed. It writes
with GH_TOKEN, which needs issues: write on that repository. --dry-run prints the issue and the comment instead.
`;

const { values } = parseArgs({
  options: {
    load: { type: "string" },
    repo: { type: "string" },
    "run-url": { type: "string", default: "" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  process.stderr.write(message);
  process.exit(2);
}

if (values.help) {
  process.stdout.write(usage);
} else {
  const file = values.load ?? fail(`--load names the dataset\n${usage}`);
  const dataset = parseNightlyDataset(parseJson(readFileSync(file, "utf8"))) ?? fail(`${file} is not a dataset that --save wrote\n`);
  const issue = formatNightlyIssue(nightlyReport(dataset), values["run-url"]);
  if (values["dry-run"]) {
    process.stdout.write(`## Nightly CI report issue, dry run\n\n${issue.red ? "Open or update it with:" : "Close it, if open, with:"}\n\n${issue.red ? issue.body : issue.comment}\n`);
  } else {
    const repo = values.repo ?? fail(`--repo names the repository of the issue\n${usage}`);
    const token = process.env.GH_TOKEN ?? fail("GH_TOKEN is not set\n");
    const result = await syncNightlyIssue(issueApi(repo, token), issue);
    const done = { create: "opened", update: "updated", close: "closed", none: "left unchanged" }[result.kind];
    process.stdout.write(`Nightly CI report issue ${done}${result.number === null ? "" : `: #${result.number}`}\n`);
  }
}

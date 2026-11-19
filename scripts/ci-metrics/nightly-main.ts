import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { collectNightlies } from "./nightly-github.ts";
import { formatNightlyMarkdown, nightlyReport, parseNightlyDataset, type NightlyDataset } from "./nightly.ts";

const usage = `usage: node scripts/ci-metrics/nightly-main.ts [options]

Reads the nightly CI runs of every repository whose default branch has a merge queue, and prints, as Markdown,
the nightly failures the merge queue missed over a window.

  --org <name>      organization to read (default AntelopeJS)
  --days <n>        window length in days, ending now or at --to (default 30)
  --to <iso date>   end of the window (default now)
  --save <file>     write the collected dataset as JSON
  --load <file>     read a dataset that --save wrote instead of the API
  --json <file>     write the full report as JSON
`;

const { values } = parseArgs({
  options: {
    org: { type: "string", default: "AntelopeJS" },
    days: { type: "string", default: "30" },
    to: { type: "string" },
    save: { type: "string" },
    load: { type: "string" },
    json: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  process.stderr.write(message);
  process.exit(2);
}

async function dataset(): Promise<NightlyDataset> {
  if (values.load !== undefined) {
    return parseNightlyDataset(JSON.parse(readFileSync(values.load, "utf8"))) ?? fail(`${values.load} is not a dataset that --save wrote\n`);
  }
  const days = Number(values.days);
  if (!Number.isFinite(days) || days <= 0) fail(`--days takes a positive number, not ${values.days}\n${usage}`);
  const to = values.to === undefined ? new Date() : new Date(values.to);
  if (Number.isNaN(to.getTime())) fail(`--to takes an ISO date, not ${values.to}\n${usage}`);
  const collected = await collectNightlies({ org: values.org, days, to, concurrency: 8 });
  if (collected.repos.length === 0) fail(`no repository of ${values.org} has a merge queue that this token can read\n`);
  if (values.save !== undefined) writeFileSync(values.save, `${JSON.stringify(collected)}\n`);
  return collected;
}

if (values.help) {
  process.stdout.write(usage);
} else {
  const result = nightlyReport(await dataset());
  if (values.json !== undefined) writeFileSync(values.json, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(formatNightlyMarkdown(result));
}

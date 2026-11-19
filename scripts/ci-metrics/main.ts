import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadBaseline } from "./baseline.ts";
import { collect } from "./github.ts";
import { formatTable, report, type Dataset, type Inputs } from "./metrics.ts";

const usage = `usage: node scripts/ci-metrics/main.ts [options]

Reads the CI runs of a GitHub organization over a window and prints a short table.

  --org <name>          organization to read (default AntelopeJS)
  --days <n>            window length in days, ending now or at --to (default 14)
  --to <iso date>       end of the window (default now)
  --sample <n>          sampled runs per repository for the ci workflow (default 20)
  --other-sample <n>    sampled runs per repository for every other workflow (default 6)
  --save <file>         write the collected dataset as JSON
  --load <file>         read a dataset that --save wrote instead of the API
  --baseline <dir>      read the November 2026 baseline directory instead of the API
  --json <file>         write the full report as JSON
  --focus <repo>        repository the report details (default dms)
  --small <minutes>     median job-minutes per run under which a repository is small (default 5)
`;

const { values } = parseArgs({
  options: {
    org: { type: "string", default: "AntelopeJS" },
    days: { type: "string", default: "14" },
    to: { type: "string" },
    sample: { type: "string", default: "20" },
    "other-sample": { type: "string", default: "6" },
    save: { type: "string" },
    load: { type: "string" },
    baseline: { type: "string" },
    json: { type: "string" },
    focus: { type: "string", default: "dms" },
    small: { type: "string", default: "5" },
    help: { type: "boolean", default: false },
  },
});

function count(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    process.stderr.write(`--${name} takes a non-negative number, not ${value}\n${usage}`);
    process.exit(2);
  }
  return parsed;
}

async function inputs(): Promise<Inputs> {
  if (values.baseline !== undefined) return loadBaseline(values.baseline);
  const dataset: Dataset = values.load !== undefined
    ? JSON.parse(readFileSync(values.load, "utf8"))
    : await collect({
      org: values.org,
      days: count("days", values.days),
      to: values.to === undefined ? new Date() : new Date(values.to),
      ciSample: count("sample", values.sample),
      otherSample: count("other-sample", values["other-sample"]),
      concurrency: 8,
    });
  if (values.save !== undefined) writeFileSync(values.save, `${JSON.stringify(dataset)}\n`);
  return { ci: dataset, org: dataset };
}

if (values.help) {
  process.stdout.write(usage);
} else {
  const result = report(await inputs(), { focus: values.focus, smallJobMinutes: count("small", values.small) });
  if (values.json !== undefined) writeFileSync(values.json, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(formatTable(result));
}

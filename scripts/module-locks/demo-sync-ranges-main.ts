import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJson } from "../ci-metrics/json.ts";
import { alignRanges, formatMovedRanges, rangesOf, type MovedRange } from "./demo-sync-ranges.ts";

const usage = `usage: node scripts/module-locks/demo-sync-ranges-main.ts <template-dms-adonis checkout>

Raises, in the checkout's package.json and demo/package.json, every range that the synced
demo/frontend-vue/package.json declares at a higher version, and prints the moved ranges as a Markdown table.
`;

const [target] = process.argv.slice(2);
if (target === undefined || target === "--help") {
  process.stdout.write(usage);
  process.exit(target === undefined ? 2 : 0);
}

const read = (file: string) => parseJson(readFileSync(join(target, file), "utf8"));
const synced = rangesOf(read("demo/frontend-vue/package.json"));
const moved: MovedRange[] = [];
for (const file of ["package.json", "demo/package.json"]) {
  const result = alignRanges(synced, read(file), file);
  if (result.moved.length === 0) continue;
  writeFileSync(join(target, file), `${JSON.stringify(result.manifest, null, 2)}\n`);
  moved.push(...result.moved);
}
process.stdout.write(formatMovedRanges(moved));

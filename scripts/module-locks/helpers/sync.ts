import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repository, root, stubs, write } from "./workflow.ts";

const syncStubs = join(root, "sync-bin");
mkdirSync(syncStubs);
writeFileSync(
  join(syncStubs, "pnpm"),
  `#!/usr/bin/env bash
if [ "$1" = run ] && [ "\${!#}" = sync ]; then
  script=$(jq -r '.scripts.sync // empty' package.json)
  [ -z "$script" ] || PATH="$PWD/node_modules/.bin:$PATH" bash -c "$script"
fi
`,
);
chmodSync(join(syncStubs, "pnpm"), 0o755);
export const SYNC_PATH = { PATH: `${syncStubs}:${stubs}:${process.env.PATH}` };

/** A repository whose `sync` script, when it has one, runs an antelopejs-sync that writes the flags it got to `target`. */
export function syncRepository(sync: string | undefined, target: string): string {
  const scripts = sync === undefined ? {} : { sync };
  const dir = repository({ "package.json": `${JSON.stringify({ name: "app", scripts })}\n`, "pnpm-lock.yaml": "core: 1.24.6\n", "README.md": "Tested with 1.24.6\n" });
  write(dir, { "node_modules/.bin/antelopejs-sync": `#!/usr/bin/env bash\nmkdir -p "$(dirname ${target})"\necho "synced $*" > ${target}\n` });
  chmodSync(join(dir, "node_modules/.bin/antelopejs-sync"), 0o755);
  return dir;
}

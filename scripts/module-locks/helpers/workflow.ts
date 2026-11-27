import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";
import { readText } from "./read.ts";

/** The text of a file of this repository. */
export const repoFile = (path: string): string => readText(new URL(`../../../${path}`, import.meta.url));

export const root = mkdtempSync(join(tmpdir(), "module-locks-"));
after(() => rmSync(root, { recursive: true, force: true }));

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

export const stubs = join(root, "bin");
mkdirSync(stubs);
writeFileSync(join(stubs, "pnpm"), '#!/usr/bin/env bash\necho "pnpm $*" >> "${PNPM_LOG:-/dev/null}"\n');
chmodSync(join(stubs, "pnpm"), 0o755);
writeFileSync(
  join(stubs, "gh"),
  `#!/usr/bin/env bash
echo "gh $*" >> "\${GH_LOG:-/dev/null}"
case "$1 $2" in
  "pr list") response=$GH_OPEN ;;
  "pr create") echo "https://github.com/$GITHUB_REPOSITORY/pull/7"; exit 0 ;;
  "api graphql") response=$GH_GRAPHQL ;;
  "api repos/"*"/git/matching-refs/"*) response=\${GH_REFS:-[]} ;;
  *) exit 0 ;;
esac
while [ "$#" -gt 0 ] && [ "$1" != --jq ]; do shift; done
jq -r "$2" <<< "$response"
`,
);
chmodSync(join(stubs, "gh"), 0o755);

const indent = (line: string): number => line.length - line.trimStart().length;

function runBlock(text: string, step: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${step}`);
  assert.notEqual(start, -1, `no step ${step}`);
  const run = lines.findIndex((line, index) => index > start && line.trim() === "run: |");
  assert.notEqual(run, -1, `step ${step} has no run block`);
  const own = indent(lines[run]);
  const end = lines.findIndex((line, index) => index > run && line.trim() !== "" && indent(line) <= own);
  return lines
    .slice(run + 1, end === -1 ? undefined : end)
    .map((line) => line.slice(own + 2))
    .join("\n");
}

export interface StepResult {
  status: number;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
}

export let runs = 0;

/** Counts one more scratch folder and returns its number. */
export function nextRun(): number {
  runs += 1;
  return runs;
}
export function runStep(text: string, step: string, cwd: string, env: Record<string, string> = {}): StepResult {
  const temp = join(root, `runner-${nextRun()}`);
  mkdirSync(temp);
  const script = join(temp, "step.sh");
  const output = join(temp, "output");
  writeFileSync(script, runBlock(text, step));
  writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${stubs}:${process.env.PATH}`,
      RUNNER_TEMP: temp,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(temp, "summary"),
      ...env,
    },
  });
  const outputs = Object.fromEntries(
    readText(output)
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, outputs };
}

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

export function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

let repos = 0;
export function repository(files: Record<string, string>): string {
  repos += 1;
  const origin = join(root, `origin-${repos}.git`);
  const dir = join(root, `repo-${repos}`);
  mkdirSync(dir);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "init", "-q", "-b", "main");
  write(dir, { ".gitignore": "node_modules\n", ...files });
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "initial");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "origin", "main");
  return dir;
}

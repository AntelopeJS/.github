import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { runInNewContext } from "node:vm";
import { readText } from "./helpers/read.ts";
import { isJsonObject, isString, readJson } from "./json.ts";
import type { Json, JsonObject } from "./json.ts";

export const workflowText = (file: string): string => readText(new URL(`../../.github/workflows/${file}`, import.meta.url));
export const text = workflowText("release-npm.yml");
export const root = mkdtempSync(join(tmpdir(), "release-workflows-"));
after(() => rmSync(root, { recursive: true, force: true }));

function runBlock(text: string, step: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(`      - name: ${step}`);
  assert.notEqual(start, -1, `no step ${step}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("      - "));
  const runLine = lines.indexOf("        run: |", start);
  assert.ok(runLine !== -1 && (end === -1 || runLine < end), `step ${step} has no run block`);
  const body: string[] = [];
  for (const line of lines.slice(runLine + 1)) {
    if (line !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
}

/** The outcome of one workflow run step executed in bash. */
export interface StepResult {
  status: number;
  stdout: string;
  stderr: string;
  outputs: string;
}

let scripts = 0;
export function runStep(text: string, step: string, cwd: string, env: Record<string, string> = {}): StepResult {
  scripts += 1;
  const script = join(root, `step-${scripts}.sh`);
  const output = join(root, `output-${scripts}`);
  writeFileSync(script, runBlock(text, step));
  writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, RUNNER_TEMP: root, GITHUB_OUTPUT: output, WORKSPACE_DIRECTORY: ".", ...env },
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, outputs: readText(output) };
}

export function afterBump(workspace: string): string[] {
  return [
    `pnpm --dir '${realpathSync(workspace)}' run --if-present sync`,
    "test ! -f scripts/check-docs-module-version.mts || node scripts/check-docs-module-version.mts --write",
    "git add --update -- :/",
  ];
}

/** The contexts a workflow expression reads. */
export interface Scope {
  matrix?: object;
  steps?: object;
  inputs?: object;
  github?: object;
  vars?: object;
  needs?: object;
  secrets?: object;
  env?: object;
  runner?: object;
}

/** What a workflow expression evaluates to. */
export type Evaluated = Json | undefined;

export function evaluate(expression: string, scope: Scope): Evaluated {
  const source = expression
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/\.labels\.\*\.name\b/g, ".labels")
    .replace(/\b(inputs|matrix|outputs)\.([\w-]+)/g, '$1["$2"]')
    .replace(/==/g, "===")
    .replace(/!=/g, "!==");
  assert.doesNotMatch(source, /\*/, `the test cannot evaluate ${expression}`);
  const contains = (list: string[], item: string): boolean => list.includes(item);
  const format = (template: string, ...values: unknown[]): string => template.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)]));
  const value: unknown = runInNewContext(`(${source})`, { matrix: scope.matrix, steps: scope.steps, inputs: scope.inputs, github: scope.github, vars: scope.vars, needs: scope.needs, secrets: scope.secrets, env: scope.env, runner: scope.runner, contains, fromJSON: JSON.parse, format });
  return value === undefined ? undefined : readJson(JSON.stringify(value));
}

export function evaluateStrings(expression: string, scope: Scope): string[] {
  const value = evaluate(expression, scope);
  assert.ok(Array.isArray(value), `${expression} is not a list`);
  return value.filter(isString);
}

export function evaluateRules(expression: string, scope: Scope): Record<string, string>[] {
  const value = evaluate(expression, scope);
  assert.ok(Array.isArray(value), `${expression} is not a list`);
  return value.map((rule) => {
    assert.ok(isJsonObject(rule), `${expression} holds a non-object`);
    return Object.fromEntries(Object.entries(rule).filter((entry): entry is [string, string] => isString(entry[1])));
  });
}

export function interpolate(template: string, scope: Scope): string {
  return template.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) => {
    const value = evaluate(expression, scope) ?? "";
    return isString(value) ? value : JSON.stringify(value);
  });
}

export function stepOf(text: string, name: string): string {
  const step = text.split("\n      - ").find((candidate) => candidate.startsWith(`name: ${name}\n`));
  assert.notEqual(step, undefined, `no step ${name}`);
  return step ?? "";
}

export function packageDirectory(name: string, manifest: JsonObject): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

export const fakeNpm = join(root, "bin");
mkdirSync(fakeNpm);
writeFileSync(join(fakeNpm, "pnpm"), '#!/bin/sh\necho "pnpm $*"\n');
writeFileSync(join(fakeNpm, "gh"), '#!/bin/sh\nif [ -n "$FAKE_GH_DOWN" ]; then echo "gh: down" >&2; exit 1; fi\necho "$FAKE_PULLS"\n');
chmodSync(join(fakeNpm, "gh"), 0o755);
chmodSync(join(fakeNpm, "pnpm"), 0o755);
writeFileSync(
  join(fakeNpm, "npm"),
  [
    "#!/bin/sh",
    'if [ "$3" = repository.url ]; then',
    '  if [ -n "$FAKE_REPOSITORY" ]; then echo "$FAKE_REPOSITORY"; exit 0; fi',
    '  echo "npm error code E404" >&2; exit 1',
    "fi",
    'if [ "$2" = "@antelopejs/x" ]; then',
    '  if [ -n "$FAKE_LATEST" ]; then echo "$FAKE_LATEST"; exit 0; fi',
    '  echo "npm error code E404" >&2; exit 1',
    "fi",
    'if [ "$2" = "@antelopejs/x@next" ] && [ "$3" = gitHead ]; then echo "$FAKE_NEXT_HEAD"; exit 0; fi',
    'if [ "$3" = gitHead ]; then echo "$FAKE_STABLE_HEAD"; exit 0; fi',
    'if [ "$2" = "@antelopejs/x@$FAKE_PUBLISHED" ]; then echo "$FAKE_PUBLISHED"; fi',
    "",
  ].join("\n"),
);
chmodSync(join(fakeNpm, "npm"), 0o755);

export const hermeticGit = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...hermeticGit },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export const checkout = join(root, "checkout");
export const packagePath = join(checkout, "packages", "x");
mkdirSync(packagePath, { recursive: true });
git(checkout, "init", "--quiet");
writeFileSync(join(packagePath, "package.json"), `${JSON.stringify({ name: "@antelopejs/x", version: "0.4.2" })}\n`);
git(checkout, "add", "--all");
git(checkout, "commit", "--quiet", "-m", "feat: x");
export const firstCommit = git(checkout, "rev-parse", "HEAD");
writeFileSync(join(packagePath, "index.js"), "x\n");
git(checkout, "add", "--all");
git(checkout, "commit", "--quiet", "-m", "fix: x");
export const packageCommit = git(checkout, "rev-parse", "HEAD");
writeFileSync(join(checkout, "README.md"), "x\n");
git(checkout, "add", "--all");
git(checkout, "commit", "--quiet", "-m", "docs: readme");
export const head = git(checkout, "rev-parse", "HEAD");
export const previewSuffix = `next.3.g${git(checkout, "rev-parse", "--short=7", "HEAD")}`;

export function commitFiles(cwd: string, message: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  git(cwd, "add", "--all");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

/** A committed repository under the scratch root. */
export interface Repository {
  directory: string;
  sha: string;
}

export function repository(name: string, files: Record<string, string>): Repository {
  const directory = join(root, name);
  mkdirSync(directory);
  git(directory, "init", "--quiet");
  return { directory, sha: commitFiles(directory, "feat: x", files) };
}

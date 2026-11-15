import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const workflows = ["release-npm-public.yml", "release-npm-private.yml"].map((file) => ({
  file,
  text: readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8"),
}));
const root = mkdtempSync(join(tmpdir(), "release-workflows-"));
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

interface StepResult {
  status: number;
  stderr: string;
  outputs: string;
}

let scripts = 0;
function runStep(text: string, step: string, cwd: string, env: Record<string, string> = {}): StepResult {
  scripts += 1;
  const script = join(root, `step-${scripts}.sh`);
  const output = join(root, `output-${scripts}`);
  writeFileSync(script, runBlock(text, step));
  writeFileSync(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, RUNNER_TEMP: root, GITHUB_OUTPUT: output, ...env },
  });
  return { status: result.status ?? 1, stderr: result.stderr, outputs: readFileSync(output, "utf8") };
}

function packageDirectory(name: string, manifest: object): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

const fakeNpm = join(root, "bin");
mkdirSync(fakeNpm);
writeFileSync(
  join(fakeNpm, "npm"),
  [
    "#!/bin/sh",
    'if [ "$2" = "@antelopejs/x" ]; then',
    '  if [ -n "$FAKE_LATEST" ]; then echo "$FAKE_LATEST"; exit 0; fi',
    '  echo "npm error code E404" >&2; exit 1',
    "fi",
    'if [ "$2" = "@antelopejs/x@next" ] && [ "$3" = gitHead ]; then echo "$FAKE_NEXT_HEAD"; exit 0; fi',
    'if [ "$2" = "@antelopejs/x@$FAKE_PUBLISHED" ]; then echo "$FAKE_PUBLISHED"; fi',
    "",
  ].join("\n"),
);
chmodSync(join(fakeNpm, "npm"), 0o755);

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const checkout = join(root, "checkout");
const packagePath = join(checkout, "packages", "x");
mkdirSync(packagePath, { recursive: true });
git(checkout, "init", "--quiet");
writeFileSync(join(packagePath, "package.json"), `${JSON.stringify({ name: "@antelopejs/x", version: "0.4.2" })}\n`);
git(checkout, "add", "--all");
git(checkout, "commit", "--quiet", "-m", "feat: x");
const firstCommit = git(checkout, "rev-parse", "HEAD");
writeFileSync(join(packagePath, "index.js"), "x\n");
git(checkout, "add", "--all");
git(checkout, "commit", "--quiet", "-m", "fix: x");
const packageCommit = git(checkout, "rev-parse", "HEAD");
writeFileSync(join(checkout, "README.md"), "x\n");
git(checkout, "add", "--all");
git(checkout, "commit", "--quiet", "-m", "docs: readme");
const head = git(checkout, "rev-parse", "HEAD");
const previewSuffix = `next.3.g${git(checkout, "rev-parse", "--short=7", "HEAD")}`;

for (const { file, text } of workflows) {
  describe(file, () => {
    test("Refuse preview dependencies fails on every preview spec and passes a stable manifest", () => {
      const pinned = packageDirectory(`${file}-pinned`, {
        name: "@antelopejs/x",
        dependencies: { "@antelopejs/a": "0.5.0-next.12.g3f9a2c1", "@antelopejs/b": ">=1.0.0 <1.1.0" },
        devDependencies: { "@antelopejs/c": "^2.0.0-beta.1" },
      });
      const refused = runStep(text, "Refuse preview dependencies", pinned);
      assert.equal(refused.status, 1);
      assert.equal(
        refused.stderr,
        "A stable release cannot depend on a preview. Give each a stable range in dependency-ranges:\n" +
          "dependencies @antelopejs/a 0.5.0-next.12.g3f9a2c1\ndevDependencies @antelopejs/c ^2.0.0-beta.1\n",
      );
      const clean = packageDirectory(`${file}-clean`, { name: "@antelopejs/x", dependencies: { "@antelopejs/b": "~1.8.6" } });
      assert.equal(runStep(text, "Refuse preview dependencies", clean).status, 0);
    });

    test("Apply dependency ranges rewrites only the preview specs of a name and names the commit", () => {
      const directory = packageDirectory(`${file}-ranges`, {
        name: "@antelopejs/x",
        dependencies: { "@antelopejs/core": "0.6.0-next.1.gabc1234" },
        peerDependencies: { "@antelopejs/core": ">=0.5.1 <0.6.0" },
        devDependencies: { "@antelopejs/core": "0.6.0-next.1.gabc1234", "@antelopejs/db": "0.5.0-next.2.gabc1234" },
      });
      const ranges = JSON.stringify({ "@antelopejs/core": ">=0.6.0 <0.7.0", "@antelopejs/db": ">=0.5.0 <0.6.0" });
      const applied = runStep(text, "Apply dependency ranges", directory, { DEPENDENCY_RANGES: ranges });
      assert.equal(applied.status, 0, applied.stderr);
      assert.equal(applied.outputs, "message=fix(deps): depend on the stable @antelopejs/core and @antelopejs/db\n");
      assert.deepEqual(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")), {
        name: "@antelopejs/x",
        dependencies: { "@antelopejs/core": ">=0.6.0 <0.7.0" },
        peerDependencies: { "@antelopejs/core": ">=0.5.1 <0.6.0" },
        devDependencies: { "@antelopejs/core": ">=0.6.0 <0.7.0", "@antelopejs/db": ">=0.5.0 <0.6.0" },
      });
      assert.equal(runStep(text, "Apply dependency ranges", directory, { DEPENDENCY_RANGES: "{}" }).outputs, "");
      const stable = runStep(text, "Apply dependency ranges", directory, { DEPENDENCY_RANGES: '{"@antelopejs/core":">=0.7.0 <0.8.0"}' });
      assert.equal(stable.status, 1);
      assert.match(stable.stderr, /does not pin to a preview: @antelopejs\/core$/m);
      const absent = runStep(text, "Apply dependency ranges", directory, { DEPENDENCY_RANGES: '{"@antelopejs/nope":"~1.0.0"}' });
      assert.equal(absent.status, 1);
      assert.match(absent.stderr, /does not pin to a preview: @antelopejs\/nope$/m);
    });

    test("Resolve release mode previews a push off the default branch and releases a dispatch on it", () => {
      const mode = (event: string, ref: string, version = "") =>
        runStep(text, "Resolve release mode", root, {
          GITHUB_EVENT_NAME: event,
          GITHUB_REF: ref,
          DEFAULT_BRANCH: "main",
          RELEASE_VERSION: version,
        });
      assert.equal(mode("push", "refs/heads/next").outputs, "mode=preview\n");
      assert.equal(mode("workflow_dispatch", "refs/heads/main", "0.5.0").outputs, "mode=stable\n");
      assert.equal(mode("workflow_dispatch", "refs/heads/main").status, 1);
      assert.equal(mode("workflow_dispatch", "refs/heads/main", "0.5.0-next.1").status, 1);
      assert.equal(mode("workflow_dispatch", "refs/heads/next", "0.5.0").status, 1);
      assert.equal(mode("push", "refs/heads/main").status, 1);
      assert.equal(mode("push", "refs/tags/v1.0.0").status, 1);
    });

    test("Resolve release version derives the preview from npm latest and skips what needs no publish", () => {
      const version = (env: Record<string, string>) =>
        runStep(text, "Resolve release version", packagePath, {
          PATH: `${fakeNpm}:${process.env.PATH ?? ""}`,
          MODE: "preview",
          GITHUB_SHA: head,
          FAKE_NEXT_HEAD: "",
          FAKE_LATEST: "",
          FAKE_PUBLISHED: "",
          ...env,
        });
      assert.equal(version({ FAKE_LATEST: "0.4.2" }).outputs, `version=0.4.3-${previewSuffix}\n`);
      assert.equal(version({ FAKE_NEXT_HEAD: "0".repeat(40), FAKE_LATEST: "1.8.6" }).outputs, `version=1.8.7-${previewSuffix}\n`);
      assert.equal(version({ FAKE_NEXT_HEAD: firstCommit, FAKE_LATEST: "0.4.2" }).outputs, `version=0.4.3-${previewSuffix}\n`);
      assert.equal(version({}).outputs, `version=0.4.2-${previewSuffix}\n`);
      const unchanged = version({ FAKE_NEXT_HEAD: packageCommit, FAKE_LATEST: "0.4.2" });
      assert.deepEqual([unchanged.status, unchanged.outputs], [0, ""]);
      const published = version({ FAKE_LATEST: "0.4.2", FAKE_PUBLISHED: `0.4.3-${previewSuffix}` });
      assert.deepEqual([published.status, published.outputs], [0, ""]);
    });

    test("Resolve release version refuses a stable version that changes the major or does not move forward", () => {
      const stable = (release: string, latest: string) =>
        runStep(text, "Resolve release version", packagePath, {
          PATH: `${fakeNpm}:${process.env.PATH ?? ""}`,
          MODE: "stable",
          RELEASE_VERSION: release,
          FAKE_LATEST: latest,
        });
      assert.equal(stable("0.5.0", "0.4.2").outputs, "version=0.5.0\n");
      assert.equal(stable("0.4.3", "0.4.2").outputs, "version=0.4.3\n");
      assert.equal(stable("0.1.0", "").outputs, "version=0.1.0\n");
      assert.equal(stable("1.0.0", "0.4.2").status, 1);
      assert.equal(stable("0.4.2", "0.4.2").status, 1);
      assert.equal(stable("0.3.9", "0.4.2").status, 1);
    });
  });
}

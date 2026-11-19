import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { nonRegistrySpecs, registrySpecs } from "./registry-specs.ts";

const workflowText = (file: string): string => readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");
const text = workflowText("release-npm.yml");
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
  stdout: string;
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
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, outputs: readFileSync(output, "utf8") };
}

interface Scope {
  steps?: object;
  inputs?: object;
  github?: object;
}

function evaluate(expression: string, scope: Scope): unknown {
  const source = expression
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replace(/\.labels\.\*\.name\b/g, ".labels")
    .replace(/\binputs\.([\w-]+)/g, 'inputs["$1"]')
    .replace(/==/g, "===")
    .replace(/!=/g, "!==");
  assert.doesNotMatch(source, /\*/, `the test cannot evaluate ${expression}`);
  const contains = (list: string[], item: string): boolean => list.includes(item);
  return new Function("steps", "inputs", "github", "contains", `return (${source})`)(scope.steps, scope.inputs, scope.github, contains);
}

function interpolate(template: string, scope: Scope): string {
  return template.replace(/\$\{\{(.*?)\}\}/g, (_, expression: string) => String(evaluate(expression, scope) ?? ""));
}

function stepOf(text: string, name: string): string {
  const step = text.split("\n      - ").find((candidate) => candidate.startsWith(`name: ${name}\n`));
  assert.notEqual(step, undefined, `no step ${name}`);
  return step ?? "";
}

function packageDirectory(name: string, manifest: object): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return directory;
}

const fakeNpm = join(root, "bin");
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

const hermeticGit = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...hermeticGit },
  });
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

function commitFiles(cwd: string, message: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  git(cwd, "add", "--all");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function repository(name: string, files: Record<string, string>): { directory: string; sha: string } {
  const directory = join(root, name);
  mkdirSync(directory);
  git(directory, "init", "--quiet");
  return { directory, sha: commitFiles(directory, "feat: x", files) };
}

const realNpm = realpathSync(spawnSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).stdout.trim());
const recordingNpm = join(root, "recording-npm", "bin");
mkdirSync(recordingNpm, { recursive: true });
symlinkSync(join(dirname(realNpm), "..", "node_modules"), join(recordingNpm, "..", "node_modules"));
writeFileSync(
  join(recordingNpm, "npm"),
  `#!/bin/sh\nif [ "$1" = publish ]; then printf '%s\\n' "$PWD" "$@" > "$NPM_PUBLISH_LOG"; exit 0; fi\nexec '${realNpm}' "$@"\n`,
);
chmodSync(join(recordingNpm, "npm"), 0o755);
const ghOnly = join(root, "gh-only");
mkdirSync(ghOnly);
symlinkSync(join(fakeNpm, "gh"), join(ghOnly, "gh"));
const releaseIt = process.env.RELEASE_IT ?? "";
assert.ok(existsSync(releaseIt), "RELEASE_IT names the bin/release-it.js of release-it 19, which the stable run tests drive");

interface Publication {
  manifest: unknown;
  args: string[];
}

let previews = 0;
function publishPreview(text: string, cwd: string, version: string, env: Record<string, string> = {}): StepResult & { publication: Publication | null } {
  previews += 1;
  const log = join(root, `npm-publish-${previews}.log`);
  assert.equal(runStep(text, "Write the publish script", cwd).status, 0);
  const result = runStep(text, "Publish preview", cwd, { PATH: `${recordingNpm}:${process.env.PATH ?? ""}`, VERSION: version, TAG: "next", NPM_PUBLISH_LOG: log, ...hermeticGit, ...env });
  if (!existsSync(log)) return { ...result, publication: null };
  const [directory = "", ...args] = readFileSync(log, "utf8").trimEnd().split("\n");
  const tarball = args.find((arg) => arg.endsWith(".tgz"));
  const manifest = tarball === undefined ? readFileSync(join(directory, "package.json"), "utf8") : spawnSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }).stdout;
  return { ...result, publication: { manifest: JSON.parse(manifest), args: args.filter((arg) => arg !== tarball) } };
}

function lockfile(spec: string, version: string): string {
  return [
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    dependencies:",
    "      '@antelopejs/interface-database':",
    `        specifier: ${spec}`,
    `        version: ${version}`,
    "",
    "packages:",
    "",
    `  '@antelopejs/interface-database@${version}':`,
    "    resolution: {integrity: sha512-x}",
    "",
  ].join("\n");
}

describe("release-npm.yml", () => {
  test("Apply dependency ranges refuses every runtime preview or non-registry spec but a workspace: one, and warns on a devDependency preview", () => {
    const pinned = packageDirectory(`release-pinned`, {
      name: "@antelopejs/x",
      dependencies: { "@antelopejs/a": "0.5.0-next.12.g3f9a2c1", "@antelopejs/b": ">=1.0.0 <1.1.0" },
      optionalDependencies: { "@antelopejs/d": "1.0.1-next.3.gabc1234" },
      devDependencies: { "@antelopejs/c": "^2.0.0-beta.1" },
    });
    const refused = runStep(text, "Apply dependency ranges", pinned);
    assert.equal(refused.status, 1);
    assert.equal(
      refused.stderr,
      "A stable release depends only on stable registry version ranges. Give each preview a stable range in dependency-ranges, and replace each other spec:\n" +
        "dependencies @antelopejs/a 0.5.0-next.12.g3f9a2c1\noptionalDependencies @antelopejs/d 1.0.1-next.3.gabc1234\n",
    );
    const unpacked = nonRegistrySpecs.filter((spec) => !spec.startsWith("workspace:"));
    const local = packageDirectory(`release-local`, {
      name: "@antelopejs/x",
      dependencies: { ...Object.fromEntries(unpacked.map((spec, index) => [`@antelopejs/d${index}`, spec])), "@antelopejs/w": "workspace:^" },
      peerDependencies: { "@antelopejs/p": "file:../p" },
      optionalDependencies: { "@antelopejs/o": "link:../o" },
      devDependencies: { "@antelopejs/dev": "file:../dev" },
    });
    const unpublishable = runStep(text, "Apply dependency ranges", local);
    assert.equal(unpublishable.status, 1);
    assert.deepEqual(unpublishable.stderr.trim().split("\n").slice(1), [
      ...unpacked.map((spec, index) => `dependencies @antelopejs/d${index} ${spec}`),
      "peerDependencies @antelopejs/p file:../p",
      "optionalDependencies @antelopejs/o link:../o",
    ]);
    const ranges = packageDirectory(`release-registry`, {
      name: "@antelopejs/x",
      dependencies: Object.fromEntries(registrySpecs.filter((spec) => !/\d-/.test(spec)).map((spec, index) => [`@antelopejs/r${index}`, spec])),
    });
    assert.equal(runStep(text, "Apply dependency ranges", ranges).status, 0);
    const dev = packageDirectory(`release-dev`, {
      name: "@antelopejs/x",
      dependencies: { "@antelopejs/b": "~1.8.6" },
      devDependencies: { "@antelopejs/c": "^2.0.0-beta.1" },
    });
    const warned = runStep(text, "Apply dependency ranges", dev);
    assert.deepEqual([warned.status, warned.stdout], [0, "::warning::This run keeps the devDependency preview @antelopejs/c ^2.0.0-beta.1.\n"]);
    const clean = packageDirectory(`release-clean`, { name: "@antelopejs/x", dependencies: { "@antelopejs/b": "~1.8.6" } });
    const passed = runStep(text, "Apply dependency ranges", clean);
    assert.deepEqual([passed.status, passed.stdout], [0, ""]);
  });

  test("Apply dependency ranges refuses a runtime spec on a released workspace sibling that is not workspace:, but not in a repin", () => {
    const manifest = (name: string, fields: object = {}) => `${JSON.stringify({ name, version: "0.1.0", ...fields })}\n`;
    const own = {
      dependencies: { "@antelopejs/interface-x": ">=0.7.0 <0.8.0", "@antelopejs/interface-y": "workspace:^", "@antelopejs/fixture": "^1.0.0", "@antelopejs/b": "~1.8.6" },
      peerDependencies: { "@antelopejs/interface-y": "^0.4.0" },
      optionalDependencies: { "@antelopejs/interface-x": "0.7.1-next.1.gabc1234" },
      devDependencies: { "@antelopejs/interface-y": "^0.4.0", "@antelopejs/c": "0.2.0-next.1.gabc1234" },
    };
    const { directory } = repository("release-literal-siblings", {
      "package.json": JSON.stringify({ name: "workspace", private: true }),
      "packages/interface-x/package.json": manifest("@antelopejs/interface-x"),
      "packages/interface-x/.release-it.json": "{}\n",
      "packages/interface-y/package.json": manifest("@antelopejs/interface-y"),
      "packages/interface-y/.release-it.json": "{}\n",
      "packages/x/test/fixture/package.json": manifest("@antelopejs/fixture"),
      "packages/x/package.json": manifest("@antelopejs/x", own),
      "packages/x/.release-it.json": "{}\n",
    });
    const x = join(directory, "packages", "x");
    const refused = runStep(text, "Apply dependency ranges", x, { ...hermeticGit, MODE: "stable", DEPENDENCY_RANGES: '{"@antelopejs/interface-x":">=0.7.1 <0.8.0"}' });
    assert.deepEqual([refused.status, refused.stderr], [
      1,
      "A stable release names each workspace sibling as workspace:^, which pnpm pack turns into the range of the version it releases. Replace each literal range with workspace:^:\n" +
        "dependencies @antelopejs/interface-x >=0.7.0 <0.8.0\npeerDependencies @antelopejs/interface-y ^0.4.0\noptionalDependencies @antelopejs/interface-x 0.7.1-next.1.gabc1234\n",
    ]);
    const repinned = runStep(text, "Apply dependency ranges", x, { ...hermeticGit, MODE: "repin", DEPENDENCY_RANGES: '{"@antelopejs/c":">=0.2.0 <0.3.0"}' });
    assert.doesNotMatch(repinned.stderr, /workspace sibling/);
    git(directory, "checkout", "--quiet", "--", ".");
    commitFiles(directory, "fix(x): name the siblings as workspace:^", {
      "packages/x/package.json": manifest("@antelopejs/x", {
        ...own,
        dependencies: { ...own.dependencies, "@antelopejs/interface-x": "workspace:^" },
        peerDependencies: { "@antelopejs/interface-y": "workspace:^" },
        optionalDependencies: {},
      }),
    });
    const passed = runStep(text, "Apply dependency ranges", x, { ...hermeticGit, MODE: "stable" });
    assert.deepEqual([passed.status, passed.stderr], [0, ""]);
  });

  test("Apply dependency ranges rewrites only the preview specs of a name and names the commit", () => {
    const directory = packageDirectory(`release-ranges`, {
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
    for (const range of ["file:../x", "github:AntelopeJS/x#next", "0.7.0-next.1.gabc1234", "latest", `${Array.from({ length: 40 }, () => "1").join("      ")}!`]) {
      const invalid = runStep(text, "Apply dependency ranges", directory, { DEPENDENCY_RANGES: JSON.stringify({ "@antelopejs/core": range }) });
      assert.deepEqual([invalid.status, invalid.stderr], [1, `dependency-ranges must map each name to a stable version range:\n@antelopejs/core ${range}\n`]);
    }
  });

  test("Apply dependency ranges refuses the release while a runtime preview remains after it rewrote another, and names the remaining one", () => {
    const directory = packageDirectory(`release-remaining`, {
      name: "@antelopejs/x",
      dependencies: { "@antelopejs/core": "0.6.0-next.1.gabc1234", "@antelopejs/db": "0.5.0-next.2.gabc1234" },
    });
    const refused = runStep(text, "Apply dependency ranges", directory, { MODE: "stable", DEPENDENCY_RANGES: '{"@antelopejs/core":">=0.6.0 <0.7.0"}' });
    assert.deepEqual(
      [refused.status, refused.stderr],
      [
        1,
        "A stable release depends only on stable registry version ranges. Give each preview a stable range in dependency-ranges, and replace each other spec:\n" +
          "dependencies @antelopejs/db 0.5.0-next.2.gabc1234\n",
      ],
    );
  });

  test("Resolve release mode previews a push to the default branch, previews a pull request, releases a dispatch on the default branch, and refuses any other event", () => {
    const mode = (event: string, ref: string, version = "", commit = head, pullRequest = "") =>
      runStep(text, "Resolve release mode", root, {
        GITHUB_EVENT_NAME: event,
        GITHUB_REF: ref,
        DEFAULT_BRANCH: "main",
        RELEASE_VERSION: version,
        RELEASE_COMMIT: commit,
        PULL_REQUEST: pullRequest,
      });
    assert.equal(mode("push", "refs/heads/main").outputs, "mode=preview\ntag=next\n");
    assert.equal(mode("push", "refs/heads/main", "", "").outputs, "mode=preview\ntag=next\n");
    assert.equal(mode("workflow_dispatch", "refs/heads/main", "0.5.0").outputs, "mode=stable\n");
    assert.equal(mode("workflow_dispatch", "refs/heads/main", "0.5.0", "").status, 1);
    assert.equal(mode("workflow_dispatch", "refs/heads/main", "0.5.0", head.slice(0, 7)).status, 1);
    assert.equal(mode("workflow_dispatch", "refs/heads/main").outputs, "mode=repin\n");
    assert.equal(mode("workflow_dispatch", "refs/heads/main", "", "").status, 1);
    assert.equal(mode("workflow_dispatch", "refs/heads/main", "0.5.0-next.1").status, 1);
    assert.equal(mode("workflow_dispatch", "refs/heads/next", "0.5.0").status, 1);
    assert.deepEqual(mode("pull_request", "refs/pull/12/merge", "", "", "12").outputs, "mode=pull-request\ntag=pr-12\n");
    assert.equal(mode("pull_request_target", "refs/heads/main", "", "", "12").status, 1);
    const next = mode("push", "refs/heads/next");
    assert.deepEqual(
      [next.status, next.outputs, next.stderr],
      [
        1,
        "",
        "A push to main publishes a preview, a pull_request with the preview label publishes a pull request preview, and a workflow_dispatch of main publishes a stable release. A push of refs/heads/next publishes nothing.\n",
      ],
    );
    assert.equal(mode("push", "refs/tags/v1.0.0").status, 1);
  });

  test("Check the planned commit refuses a branch that moved since the plan", () => {
    const check = (commit: string) =>
      runStep(text, "Check the planned commit", checkout, { RELEASE_COMMIT: commit, GITHUB_REF_NAME: "main" });
    assert.equal(check(head).status, 0);
    const moved = check(firstCommit);
    assert.equal(moved.status, 1);
    assert.equal(
      moved.stderr,
      `main moved since the plan: HEAD is ${head}, the plan released ${firstCommit}. Run the release train again.\n`,
    );
  });

  test("Write release notes puts the cycle's section on top of the changelog and points release-it at it", () => {
    const write = (name: string, files: Record<string, string>) => {
      const directory = join(root, `release-${name}`);
      mkdirSync(join(directory, "docs"), { recursive: true });
      git(directory, "init", "--quiet");
      commitFiles(directory, "feat: first", { "package.json": "{}\n", ...files });
      git(directory, "tag", "v0.4.2");
      const fix = commitFiles(directory, "fix: close the feed", { "feed.js": "x\n" });
      const result = runStep(text, "Write release notes", directory, {
        PATH: `${fakeNpm}:${process.env.PATH ?? ""}`,
        FAKE_PULLS: "[]",
        GITHUB_REPOSITORY: "AntelopeJS/x",
        DEFAULT_BRANCH: "main",
        RELEASE_VERSION: "0.5.0",
        ...hermeticGit,
      });
      assert.equal(result.status, 0, result.stderr);
      const read = (path: string): string => readFileSync(join(directory, path), "utf8");
      const config: unknown = JSON.parse(readFileSync(join(root, "release-it.json"), "utf8"));
      const notes = [
        "[compare changes](https://github.com/AntelopeJS/x/compare/v0.4.2...v0.5.0)",
        "### 🩹 Fixes",
        `- Close the feed ([${fix.slice(0, 7)}](https://github.com/AntelopeJS/x/commit/${fix}))`,
        "### ❤️ Contributors",
        "- Test",
      ].join("\n\n");
      return { read, staged: git(directory, "diff", "--cached", "--name-only"), config, notes, section: `## v0.5.0\n\n${notes}\n\n` };
    };
    const existing = write("existing", {
      "CHANGELOG.md": "# Changelog\n\n## v0.4.2\n\n### 🩹 Fixes\n\n- Old\n",
      ".release-it.json": JSON.stringify({
        git: { tagName: "v${version}", requireCommits: true },
        github: { release: true },
        plugins: { "release-it-changelogen": { disableVersion: true }, "@release-it/bumper": {} },
      }),
    });
    assert.equal(existing.read("CHANGELOG.md"), `# Changelog\n\n${existing.section}## v0.4.2\n\n### 🩹 Fixes\n\n- Old\n`);
    assert.equal(readFileSync(join(root, "release-notes.md"), "utf8"), existing.notes);
    assert.deepEqual(existing.config, {
      git: { tagName: "v${version}", requireCommits: true, requireCleanWorkingDir: false },
      github: { release: true, releaseNotes: `cat '${join(root, "release-notes.md")}'` },
      plugins: { "@release-it/bumper": {} },
      npm: { publish: false },
      hooks: { "before:npm:release": [`bash '${join(root, "publish.sh")}' latest`] },
    });

    const fresh = write("fresh", {});
    assert.equal(fresh.read("CHANGELOG.md"), `# Changelog\n\n${fresh.section}`);
    assert.equal(fresh.staged, "CHANGELOG.md");
    assert.deepEqual(fresh.config, {
      git: { requireCleanWorkingDir: false },
      github: { releaseNotes: `cat '${join(root, "release-notes.md")}'` },
      npm: { publish: false },
      hooks: { "before:npm:release": [`bash '${join(root, "publish.sh")}' latest`] },
    });

    const custom = write("custom", {
      "changelogen.config.json": JSON.stringify({ output: "docs/CHANGES.md" }),
      "docs/CHANGES.md": "# Changes\n",
      ".release-it.json": JSON.stringify({ plugins: { "release-it-changelogen": {} } }),
    });
    assert.equal(custom.read("docs/CHANGES.md"), `# Changes\n\n${custom.section}`);
    assert.equal(custom.staged, "docs/CHANGES.md");
    assert.deepEqual(custom.config, {
      git: { requireCleanWorkingDir: false },
      github: { releaseNotes: `cat '${join(root, "release-notes.md")}'` },
      npm: { publish: false },
      hooks: { "before:npm:release": [`bash '${join(root, "publish.sh")}' latest`] },
    });
  });

  test("Write release notes start from the highest tag below the released version, never from a stray tag above it", () => {
    const { directory } = repository(`release-stray-major`, { "package.json": "{}\n" });
    git(directory, "tag", "v1.24.1");
    commitFiles(directory, "feat: accidental major", { "major.js": "x\n" });
    git(directory, "tag", "v2.0.1");
    const fix = commitFiles(directory, "fix: close the feed", { "feed.js": "x\n" });
    const result = runStep(text, "Write release notes", directory, {
      PATH: `${fakeNpm}:${process.env.PATH ?? ""}`,
      FAKE_PULLS: "[]",
      GITHUB_REPOSITORY: "AntelopeJS/x",
      DEFAULT_BRANCH: "main",
      RELEASE_VERSION: "1.24.2",
      ...hermeticGit,
    });
    assert.equal(result.status, 0, result.stderr);
    const notes = readFileSync(join(root, "release-notes.md"), "utf8").split("\n\n");
    assert.equal(notes[0], "[compare changes](https://github.com/AntelopeJS/x/compare/v1.24.1...v1.24.2)");
    assert.ok(notes.includes(`- Close the feed ([${fix.slice(0, 7)}](https://github.com/AntelopeJS/x/commit/${fix}))`), notes.join("\n\n"));
    assert.ok(notes.some((line) => line.startsWith("- Accidental major")), notes.join("\n\n"));
  });

  test("Write release notes lists one line per task of the cycle from the promotion's head, with breaking changes and contributors", () => {
    const repo = join(root, `release-cycle`);
    mkdirSync(repo);
    git(repo, "init", "--quiet", "--initial-branch=main");
    const by = (author: string, subject: string, body = ""): string => {
      writeFileSync(join(repo, "log.txt"), `${subject}\n`, { flag: "a" });
      git(repo, "add", "--all");
      git(repo, "commit", "--quiet", `--author=${author} <a@example.com>`, "-m", subject, ...(body === "" ? [] : ["-m", body]));
      return git(repo, "rev-parse", "HEAD");
    };
    const antony = "Antony Rizzitelli";
    commitFiles(repo, "feat: first", { "package.json": "{}\n" });
    git(repo, "checkout", "--quiet", "-b", "next");
    const oldHead = by(antony, "fix: an old task (#88)");
    git(repo, "checkout", "--quiet", "main");
    git(repo, "merge", "--quiet", "--squash", "next");
    git(repo, "commit", "--quiet", "-m", "fix: promote next (#90)");
    const oldSquash = git(repo, "rev-parse", "HEAD");
    commitFiles(repo, "chore(release): v0.4.1", { "CHANGELOG.md": "## v0.4.1\n" });
    git(repo, "tag", "v0.4.1");
    git(repo, "checkout", "--quiet", "next");
    git(repo, "merge", "--quiet", "--no-ff", "--no-edit", "main");
    by(antony, "feat(query): ReadCursor hands over rows in batches (#97)");
    const guard = by("Carol", "fix: guard the empty batch");
    const close = by("Carol", "fix(cursor): close on error", "BREAKING CHANGE: the cursor throws");
    by("renovate[bot]", "ci: run the checks on Windows (#94)");
    by("Bob", "Update the README");
    by(antony, "wip: half done");
    by(antony, "fix(deps): depend on the stable @antelopejs/core");
    const head = by(antony, "feat(query)!: rename ReadCursor.next to ReadCursor.read (#101)");
    git(repo, "checkout", "--quiet", "main");
    git(repo, "merge", "--quiet", "--squash", "next");
    git(repo, "commit", "--quiet", "-m", "feat(query): batch reads and cursor fixes (#122)");
    const squash = git(repo, "rev-parse", "HEAD");
    const pulls = [
      { number: 122, mergeCommit: { oid: squash }, headRefOid: head },
      { number: 90, mergeCommit: { oid: oldSquash }, headRefOid: oldHead },
      { number: 89, mergeCommit: { oid: oldSquash }, headRefOid: "d".repeat(40) },
      { number: 7,mergeCommit: { oid: "e".repeat(40) }, headRefOid: "f".repeat(40) },
    ];
    const env = {
      PATH: `${fakeNpm}:${process.env.PATH ?? ""}`,
      FAKE_PULLS: JSON.stringify(pulls),
      GITHUB_REPOSITORY: "AntelopeJS/interface-database",
      DEFAULT_BRANCH: "main",
      RELEASE_VERSION: "0.5.0",
      DEPENDENCY_RANGES: JSON.stringify({ "@antelopejs/mongodb": ">=1.8.7 <1.9.0", "@antelopejs/core": ">=1.24.0 <1.25.0" }),
      ...hermeticGit,
    };
    const result = runStep(text, "Write release notes", repo, env);
    assert.deepEqual([result.status, result.stderr], [0, ""]);
    const pull =(number: number): string => `[#${number}](https://github.com/AntelopeJS/interface-database/pull/${number})`;
    const commitLink = (sha: string): string => `[${sha.slice(0, 7)}](https://github.com/AntelopeJS/interface-database/commit/${sha})`;
    const closeOnError = `- **cursor:** Close on error (${commitLink(close)})`;
    assert.equal(
      readFileSync(join(root, "release-notes.md"), "utf8"),
      [
        "[compare changes](https://github.com/AntelopeJS/interface-database/compare/v0.4.1...v0.5.0)",
        "",
        "### 🚀 Enhancements",
        "",
        `- **query:** ReadCursor hands over rows in batches (${pull(97)})`,
        `- **query:** Rename ReadCursor.next to ReadCursor.read (${pull(101)})`,
        "",
        "### 🩹 Fixes",
        "",
        `- Guard the empty batch (${commitLink(guard)})`,
        closeOnError,
        "- **deps:** Depend on the stable @antelopejs/mongodb and @antelopejs/core",
        "",
        "### 🤖 CI",
        "",
        `- Run the checks on Windows (${pull(94)})`,
        "",
        "#### ⚠️ Breaking Changes",
        "",
        closeOnError,
        `- **query:** Rename ReadCursor.next to ReadCursor.read (${pull(101)})`,
        "",
        "### ❤️ Contributors",
        "",
        "- Antony Rizzitelli",
        "- Carol",
      ].join("\n"),
    );
    const down = runStep(text, "Write release notes", repo, { ...env, FAKE_GH_DOWN: "1" });
    assert.equal(down.status, 1);
  });

  test("Write release notes lists the tooling commits of a cycle that released nothing in the next release", () => {
    const repo = join(root, `release-tooling`);
    mkdirSync(repo);
    git(repo, "init", "--quiet", "--initial-branch=main");
    commitFiles(repo, "feat: first", { "package.json": "{}\n" });
    git(repo, "tag", "v0.4.2");
    const build = commitFiles(repo, "build: move to @antelopejs/tooling-configs 0.8", { "tsconfig.json": "{}\n" });
    const fix = commitFiles(repo, "fix: close the feed", { "index.js": "\n" });
    const env = { PATH: `${fakeNpm}:${process.env.PATH ?? ""}`, FAKE_PULLS: "[]", GITHUB_REPOSITORY: "AntelopeJS/interface-database", DEFAULT_BRANCH: "main", RELEASE_VERSION: "0.4.3", ...hermeticGit };
    const result = runStep(text, "Write release notes", repo, env);
    assert.equal(result.status, 0, result.stderr);
    const link = (sha: string): string => `[${sha.slice(0, 7)}](https://github.com/AntelopeJS/interface-database/commit/${sha})`;
    const notes = readFileSync(join(root, "release-notes.md"), "utf8");
    const sections = ["### 🩹 Fixes", "", `- Close the feed (${link(fix)})`, "", "### 📦 Build", "", `- Move to @antelopejs/tooling-configs 0.8 (${link(build)})`].join("\n");
    assert.ok(notes.includes(sections), notes);
  });

  test("Write release notes leave out a reverted commit and its revert, with the tasks of their pull requests", () => {
    const repo = join(root, `release-reverts`);
    mkdirSync(repo);
    git(repo, "init", "--quiet", "--initial-branch=main");
    commitFiles(repo, "feat: first", { "package.json": "{}\n" });
    git(repo, "tag", "v1.24.2");
    git(repo, "checkout", "--quiet", "-b", "next");
    const reordered = commitFiles(repo, "fix(modules): stop consumers before the providers they are bound to (#516)", { "stop.js": "consumers\n" });
    writeFileSync(join(repo, "stop.js"), "providers\n");
    git(repo, "commit", "--quiet", "--all", "-m", "refactor(modules): restore the stop order of 1.24.2 (#522)", "-m", `This reverts commit ${reordered}.\nReverts AntelopeJS/antelopejs#516`);
    const kept = commitFiles(repo, "fix(modules): converge install --fix on a prerelease interface (#525)", { "install.js": "\n" });
    git(repo, "checkout", "--quiet", "main");
    git(repo, "merge", "--quiet", "--squash", "next");
    git(repo, "commit", "--quiet", "-m", "feat: promote next to main (#524)");
    const promotion = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "--quiet", "-b", "cache");
    const task = commitFiles(repo, "fix(cache): drop the lock folder", { "cache.js": "drop\n" });
    git(repo, "checkout", "--quiet", "main");
    git(repo, "merge", "--quiet", "--squash", "cache");
    git(repo, "commit", "--quiet", "-m", "fix(cache): drop the lock folder (#530)");
    const dropped = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "--quiet", "-b", "restore");
    git(repo, "revert", "--no-edit", dropped);
    const revertTask = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "--quiet", "main");
    git(repo, "merge", "--quiet", "--squash", "restore");
    git(repo, "commit", "--quiet", "-m", "fix(cache): keep the lock folder (#531)", "-m", `This reverts commit ${dropped}.`);
    const restored = git(repo, "rev-parse", "HEAD");
    const pulls = [
      { number: 531, mergeCommit: { oid: restored }, headRefOid: revertTask },
      { number: 530, mergeCommit: { oid: dropped }, headRefOid: task },
      { number: 524, mergeCommit: { oid: promotion }, headRefOid: kept },
    ];
    const env = { PATH: `${fakeNpm}:${process.env.PATH ?? ""}`, FAKE_PULLS: JSON.stringify(pulls), GITHUB_REPOSITORY: "AntelopeJS/antelopejs", DEFAULT_BRANCH: "main", RELEASE_VERSION: "1.24.3", ...hermeticGit };
    const result = runStep(text, "Write release notes", repo, env);
    assert.equal(result.status, 0, result.stderr);
    const notes = [
      "[compare changes](https://github.com/AntelopeJS/antelopejs/compare/v1.24.2...v1.24.3)",
      "",
      "### 🩹 Fixes",
      "",
      "- **modules:** Converge install --fix on a prerelease interface ([#525](https://github.com/AntelopeJS/antelopejs/pull/525))",
      "",
      "### ❤️ Contributors",
      "",
      "- Test",
    ].join("\n");
    assert.equal(readFileSync(join(root, "release-notes.md"), "utf8"), notes);
    assert.equal(readFileSync(join(repo, "CHANGELOG.md"), "utf8"), `# Changelog\n\n## v1.24.3\n\n${notes}\n\n`);
  });

  test("Publish stable release runs release-it with the written config", () => {
    const bin = join(root, `release-pnpm`);
    mkdirSync(bin);
    writeFileSync(join(bin, "pnpm"), '#!/bin/sh\necho "$@"\n');
    chmodSync(join(bin, "pnpm"), 0o755);
    const published = runStep(text, "Publish stable release", checkout, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      RELEASE_VERSION: "0.5.0",
      GITHUB_TOKEN: "token",
      GITHUB_REF_NAME: "main",
    });
    assert.equal(published.status, 0, published.stderr);
    assert.equal(
      published.stdout,
      `exec release-it --config ${join(root, "release-it.json")} --ci --verbose --git.requireBranch=main --git.tagExclude=*.*.*-* --increment=0.5.0\n`,
    );
  });

  test("Publish stable release prints the stdout and stderr of a hook that fails", () => {
    const { directory } = repository(`release-failing-hook`, {
      "package.json": JSON.stringify({ name: "@antelopejs/x", version: "0.4.2" }),
      "lint.sh": "echo 'src/index.ts:3:7 error x is unused'\necho 'ELIFECYCLE Command failed with exit code 1.' >&2\nexit 1\n",
    });
    mkdirSync(join(directory, "node_modules", ".bin"), { recursive: true });
    symlinkSync(releaseIt, join(directory, "node_modules", ".bin", "release-it"));
    writeFileSync(join(root, "release-it.json"), JSON.stringify({ hooks: { "before:init": "sh lint.sh" }, npm: false, github: { release: false } }));
    const published = runStep(text, "Publish stable release", directory, { ...hermeticGit, RELEASE_VERSION: "0.5.0", GITHUB_TOKEN: "token", GITHUB_REF_NAME: "main" });
    assert.notEqual(published.status, 0);
    const log = published.stdout + published.stderr;
    assert.ok(log.includes("src/index.ts:3:7 error x is unused"), log);
    assert.ok(log.includes("ELIFECYCLE Command failed with exit code 1."), log);
  });

  test("a stable run of a workspace package publishes it packed after release-it's bump, with each sibling's released range", () => {
    const bare = join(root, `release-workspace.git`);
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
    const seed = join(root, `release-workspace-seed`);
    git(root, "clone", "--quiet", bare, seed);
    const manifest = {
      name: "@antelopejs/x",
      version: "0.12.1",
      license: "Apache-2.0",
      dependencies: { "@antelopejs/interface-x": "workspace:^" },
      peerDependencies: { "@antelopejs/interface-x": "workspace:*" },
    };
    commitFiles(seed, "feat: first", {
      ".gitignore": "node_modules\npnpm-lock.yaml\n",
      "package.json": JSON.stringify({ name: "workspace", private: true }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/interface-x/package.json": JSON.stringify({ name: "@antelopejs/interface-x", version: "0.11.0" }),
      "packages/x/package.json": `${JSON.stringify(manifest, null, 2)}\n`,
      "packages/x/.release-it.json": JSON.stringify({ git: { tagName: "v${version}" }, github: { release: false } }),
    });
    git(seed, "tag", "v0.12.1");
    commitFiles(seed, "fix: x", { "packages/x/index.js": "x\n" });
    git(seed, "push", "--quiet", "origin", "main", "--tags");
    const runner = join(root, `release-workspace-runner`);
    git(root, "clone", "--quiet", bare, runner);
    const planned = git(runner, "rev-parse", "HEAD");
    const installed = spawnSync("pnpm", ["install", "--offline", "--no-frozen-lockfile", "--silent"], { cwd: runner, encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    const x = join(runner, "packages", "x");
    mkdirSync(join(x, "node_modules", ".bin"), { recursive: true });
    symlinkSync(releaseIt, join(x, "node_modules", ".bin", "release-it"));
    const log = join(root, `release-workspace-publish.log`);
    const env = { ...hermeticGit, PATH: `${recordingNpm}:${ghOnly}:${process.env.PATH ?? ""}`, NPM_PUBLISH_LOG: log, RELEASE_VERSION: "0.13.0" };
    for (const [step, cwd, extra] of [
      ["Configure release identity", runner, {}],
      ["Apply dependency ranges", x, {}],
      ["Write the publish script", x, {}],
      ["Write release notes", x, { FAKE_PULLS: "[]", GITHUB_REPOSITORY: "AntelopeJS/x", DEFAULT_BRANCH: "main" }],
      ["Publish stable release", x, { GITHUB_TOKEN: "token", GITHUB_REF_NAME: "main" }],
    ] as const) {
      const result = runStep(text, step, cwd, { ...env, ...extra });
      assert.equal(result.status, 0, `${step}\n${result.stdout}${result.stderr}`);
    }
    const [directory = "", ...args] = readFileSync(log, "utf8").trimEnd().split("\n");
    const tarball = args.find((arg) => arg.endsWith(".tgz")) ?? join(directory, "package.json");
    const published = tarball.endsWith(".tgz") ? spawnSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }).stdout : readFileSync(tarball, "utf8");
    assert.deepEqual(
      { manifest: JSON.parse(published), args: args.filter((arg) => arg !== tarball) },
      {
        manifest: {
          ...manifest,
          version: "0.13.0",
          dependencies: { "@antelopejs/interface-x": "^0.11.0" },
          peerDependencies: { "@antelopejs/interface-x": "0.11.0" },
          gitHead: planned,
        },
        args: ["publish", "--tag", "latest"],
      },
    );
    assert.deepEqual(JSON.parse(git(bare, "show", "v0.13.0:packages/x/package.json")), { ...manifest, version: "0.13.0" });
    assert.equal(git(runner, "status", "--porcelain"), "");
  });

  test("Publish preview publishes the packed package, with each workspace: spec resolved and the commit as gitHead", () => {
    const { directory, sha } = repository(`release-monorepo`, {
      "package.json": JSON.stringify({ name: "workspace", private: true }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/interface-x/package.json": JSON.stringify({ name: "@antelopejs/interface-x", version: "0.10.0" }),
      "packages/x/package.json": JSON.stringify({
        name: "@antelopejs/x",
        version: "0.12.1",
        dependencies: { "@antelopejs/interface-x": "workspace:^" },
        peerDependencies: { "@antelopejs/interface-x": "workspace:*" },
      }),
    });
    const installed = spawnSync("pnpm", ["install", "--offline", "--no-frozen-lockfile", "--silent"], { cwd: directory, encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    const preview = publishPreview(text, join(directory, "packages", "x"), "0.12.2-next.2.gabc1234");
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(preview.publication, {
      manifest: {
        name: "@antelopejs/x",
        version: "0.12.2-next.2.gabc1234",
        dependencies: { "@antelopejs/interface-x": "^0.10.0" },
        peerDependencies: { "@antelopejs/interface-x": "0.10.0" },
        gitHead: sha,
      },
      args: ["publish", "--tag", "next"],
    });
  });

  test("a preview pins each workspace sibling's preview from its commit or its unreleased next, and keeps the stable range of one released since", () => {
    const manifest = (name: string, version: string, dependencies: Record<string, string> = {}) => `${JSON.stringify({ name, version, dependencies })}\n`;
    const { directory, sha: first } = repository(`release-siblings`, {
      "package.json": JSON.stringify({ name: "workspace", private: true }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/interface-x/package.json": manifest("@antelopejs/interface-x", "0.10.0"),
      "packages/interface-x/.release-it.json": "{}\n",
      "packages/interface-y/package.json": manifest("@antelopejs/interface-y", "0.4.0"),
      "packages/interface-y/.release-it.json": "{}\n",
      "packages/interface-z/package.json": manifest("@antelopejs/interface-z", "0.2.0"),
      "packages/interface-z/.release-it.json": "{}\n",
      "packages/x/test/fixture/package.json": manifest("@antelopejs/interface-x", "0.0.0"),
      "packages/x/package.json": manifest("@antelopejs/x", "0.12.1", {
        "@antelopejs/interface-x": "workspace:^",
        "@antelopejs/interface-y": "workspace:^",
        "@antelopejs/interface-z": "workspace:^",
      }),
      "packages/x/.release-it.json": "{}\n",
    });
    const previewed = commitFiles(directory, "fix: y and z", { "packages/interface-y/index.js": "y\n", "packages/interface-z/index.js": "z\n" });
    const sha = commitFiles(directory, "feat: x", { "packages/interface-x/index.js": "x\n", "packages/x/index.js": "x\n" });
    const views = join(root, `release-npm-views.tsv`);
    writeFileSync(
      views,
      [
        ["@antelopejs/x version", "0.12.1"],
        ["@antelopejs/x@next gitHead", first],
        ["@antelopejs/interface-x version", "0.10.0"],
        ["@antelopejs/interface-x@next gitHead", first],
        ["@antelopejs/interface-y version", "0.4.0"],
        ["@antelopejs/interface-y@next gitHead", previewed],
        ["@antelopejs/interface-y@next version", "0.4.0-next.1.g0000000"],
        ["@antelopejs/interface-z version", "0.2.0"],
        ["@antelopejs/interface-z@next gitHead", previewed],
        ["@antelopejs/interface-z@next version", "0.2.1-next.2.g1111111"],
      ]
        .map((row) => row.join("\t"))
        .join("\n") + "\n",
    );
    const registry = join(root, `release-registry-npm`);
    mkdirSync(registry);
    writeFileSync(
      join(registry, "npm"),
      `#!/bin/sh\nif [ "$1" = view ] && [ "$2 $3" = "$FAKE_DOWN" ]; then echo "npm error code E500" >&2; exit 1; fi\nif [ "$1" = view ]; then awk -F '\\t' -v key="$2 $3" '$1 == key { print $2; found = 1 } END { exit !found }' "$FAKE_VIEWS" && exit 0; echo "npm error code E404" >&2; exit 1; fi\nexec '${realNpm}' "$@"\n`,
    );
    chmodSync(join(registry, "npm"), 0o755);
    const suffix = `next.3.g${sha.slice(0, 7)}`;
    const resolve = (env: Record<string, string> = {}) =>
      runStep(text, "Resolve release version", join(directory, "packages", "x"), {
        PATH: `${registry}:${process.env.PATH ?? ""}`,
        MODE: "preview",
        GITHUB_SHA: sha,
        FAKE_VIEWS: views,
        ...hermeticGit,
        ...env,
      });
    const down = resolve({ FAKE_DOWN: "@antelopejs/interface-x version" });
    assert.deepEqual([down.status, down.outputs], [1, ""]);
    const resolved = resolve();
    assert.equal(resolved.status, 0, resolved.stderr);
    const pins = `{"@antelopejs/interface-x":"0.10.1-${suffix}","@antelopejs/interface-z":"0.2.1-next.2.g1111111"}`;
    assert.equal(resolved.outputs, `pins=${pins}\nversion=0.12.2-${suffix}\n`);
    const installed = spawnSync("pnpm", ["install", "--offline", "--no-frozen-lockfile", "--silent"], { cwd: directory, encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    const preview = publishPreview(text, join(directory, "packages", "x"), `0.12.2-${suffix}`, { PINS: pins });
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(preview.publication?.manifest, {
      name: "@antelopejs/x",
      version: `0.12.2-${suffix}`,
      dependencies: { "@antelopejs/interface-x": `0.10.1-${suffix}`, "@antelopejs/interface-y": "^0.4.0", "@antelopejs/interface-z": "0.2.1-next.2.g1111111" },
      gitHead: sha,
    });
  });

  test("Publish preview refuses a package that would ship a spec resolving only inside its repository", () => {
    const local = [
      "file:../interface-database",
      "link:../interface-database",
      "github:AntelopeJS/interface-database#next",
      "git+https://github.com/AntelopeJS/interface-database.git",
      "https://github.com/AntelopeJS/interface-database.git",
      "https://github.com/AntelopeJS/interface-database",
      "git@github.com:AntelopeJS/interface-database.git",
      "ssh://git@github.com/AntelopeJS/interface-database.git",
      "AntelopeJS/interface-database",
      "../interface-database",
      "interface-database.tgz",
      "portal:../interface-database",
    ];
    const { directory } = repository(`release-unpublishable`, {
      "package.json": JSON.stringify({
        name: "@antelopejs/x",
        version: "1.0.0",
        dependencies: { ...Object.fromEntries(local.map((spec, index) => [`@antelopejs/d${index}`, spec])), "@antelopejs/r": "^1.0.0", "@antelopejs/a": "npm:@antelopejs/x@>=1 <2", "@antelopejs/l": "latest", "@antelopejs/t": "https://example.com/t.tgz" },
        peerDependencies: { "@antelopejs/p": "file:../p" },
        optionalDependencies: { "@antelopejs/o": "link:../o" },
        devDependencies: { "@antelopejs/dev": "file:../dev" },
      }),
    });
    const refused = publishPreview(text, directory, "1.0.1-next.1.gabc1234");
    assert.deepEqual([refused.status, refused.publication], [1, null]);
    assert.equal(
      refused.stderr,
      [
        "@antelopejs/x@1.0.1-next.1.gabc1234 would ship specs that resolve only inside its repository:",
        ...local.map((spec, index) => `dependencies @antelopejs/d${index} ${spec}`),
        "peerDependencies @antelopejs/p file:../p",
        "optionalDependencies @antelopejs/o link:../o",
        "",
      ].join("\n"),
    );
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

  test("Resolve release version derives a pull request preview from the head commit, and skips one npm already holds", () => {
    const mergeCommit = "f".repeat(40);
    const version = (env: Record<string, string>) =>
      runStep(text, "Resolve release version", packagePath, {
        PATH: `${fakeNpm}:${process.env.PATH ?? ""}`,
        MODE: "pull-request",
        PULL_REQUEST: "12",
        GITHUB_SHA: mergeCommit,
        FAKE_NEXT_HEAD: "",
        FAKE_LATEST: "",
        FAKE_PUBLISHED: "",
        ...env,
      });
    const suffix = `pr.12.3.g${head.slice(0, 7)}`;
    assert.equal(version({ FAKE_LATEST: "0.4.2" }).outputs, `version=0.0.0-${suffix}\n`);
    assert.equal(version({}).outputs, `version=0.0.0-${suffix}\n`);
    assert.equal(version({ FAKE_LATEST: "0.4.2", FAKE_NEXT_HEAD: head }).outputs, `version=0.0.0-${suffix}\n`);
    const published = version({ FAKE_LATEST: "0.4.2", FAKE_PUBLISHED: `0.0.0-${suffix}` });
    assert.deepEqual([published.status, published.outputs, published.stdout], [0, "", `::notice::@antelopejs/x@0.0.0-${suffix} is already published.\n`]);
  });

  test("a private pull request preview publishes the pull request version under pr-<number>, recording the head commit as gitHead", () => {
    const { directory, sha } = repository(`release-pull-request`, { "package.json": JSON.stringify({ name: "@antelopejs/x", version: "0.4.2", dependencies: { "@antelopejs/b": "^1.0.0" } }) });
    const resolved = runStep(text, "Resolve release version", directory, {
      PATH: `${fakeNpm}:${process.env.PATH ?? ""}`,
      MODE: "pull-request",
      PULL_REQUEST: "12",
      GITHUB_SHA: "f".repeat(40),
      FAKE_LATEST: "0.4.2",
      FAKE_NEXT_HEAD: sha,
      FAKE_PUBLISHED: "",
      ...hermeticGit,
    });
    const version = `0.0.0-pr.12.1.g${sha.slice(0, 7)}`;
    assert.equal(resolved.outputs, `version=${version}\n`);
    const preview = publishPreview(text, directory, version, { TAG: "pr-12", PINS: "" });
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(preview.publication, {
      manifest: { name: "@antelopejs/x", version, dependencies: { "@antelopejs/b": "^1.0.0" }, gitHead: sha },
      args: ["publish", "--tag", "pr-12"],
    });
  });

  test("a public pull request preview installs the pinned pkg-pr-new and runs it on the package with the pull request version", () => {
    const installer = join(root, "pkg-pr-new-installer");
    mkdirSync(installer);
    const installed = join(root, "pkg-pr-new-install.log");
    writeFileSync(join(installer, "npm"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${installed}'\n`);
    chmodSync(join(installer, "npm"), 0o755);
    const install = runStep(text, "Install pkg.pr.new", root, { PATH: `${installer}:${process.env.PATH ?? ""}` });
    assert.equal(install.status, 0, install.stderr);
    assert.deepEqual(readFileSync(installed, "utf8").trimEnd().split("\n"), ["install", "--no-save", "--no-audit", "--no-fund", "--prefix", join(root, "pkg-pr-new"), "pkg-pr-new@0.0.94"]);

    const bin = join(root, "pkg-pr-new", "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pkg-pr-new"), '#!/bin/sh\nprintf \'%s\\n\' "$PWD" "$@" > "$PKG_PR_NEW_LOG"\ncat package.json >> "$PKG_PR_NEW_LOG"\n');
    chmodSync(join(bin, "pkg-pr-new"), 0o755);
    const manifest = { name: "@antelopejs/x", version: "0.4.2", dependencies: { "@antelopejs/interface-x": "workspace:^", "@antelopejs/b": "catalog:" } };
    const directory = packageDirectory(`release-pkg-pr-new`, manifest);
    const log = join(root, "pkg-pr-new-publish.log");
    const version = "0.0.0-pr.12.3.gabc1234";
    const published = runStep(text, "Publish to pkg.pr.new", directory, { VERSION: version, PKG_PR_NEW_LOG: log });
    assert.equal(published.status, 0, published.stderr);
    const [cwd = "", ...rest] = readFileSync(log, "utf8").split("\n");
    const args = rest.slice(0, 4);
    assert.equal(realpathSync(cwd), realpathSync(directory));
    assert.deepEqual(args, ["publish", "--pnpm", "--comment=update", "."]);
    assert.deepEqual(JSON.parse(rest.slice(4).join("\n")), { ...manifest, version });
  });

  test("Resolve release version publishes no preview when only the version and the changelog changed", () => {
    const repository = join(root, `release-version-changelog`);
    const directory = join(repository, "packages", "x");
    mkdirSync(directory, { recursive: true });
    git(repository, "init", "--quiet");
    const step = (files: Record<string, string>): string => {
      for (const [path, content] of Object.entries(files)) writeFileSync(join(directory, path), content);
      git(repository, "add", "--all");
      git(repository, "commit", "--quiet", "-m", "x");
      return git(repository, "rev-parse", "HEAD");
    };
    const manifest = (version: string, range = ">=1.8.6 <1.9.0") =>
      `${JSON.stringify({ name: "@antelopejs/x", version, dependencies: { "@antelopejs/mongodb": range } }, null, 2)}\n`;
    const preview = step({ "package.json": manifest("0.4.2"), "index.js": "x\n" });
    const release = step({ "package.json": manifest("0.4.3"), "CHANGELOG.md": "# Changelog\n\n## v0.4.3\n" });
    const range = step({ "package.json": manifest("0.4.4", ">=1.8.7 <1.9.0") });
    const source = step({ "index.js": "y\n" });
    const custom = step({ "changelogen.config.json": '{ "output": "./HISTORY.md" }\n' });
    const customRelease = step({ "package.json": manifest("0.4.5", ">=1.8.7 <1.9.0"), "HISTORY.md": "## v0.4.5\n" });
    const resolve = (previous: string, sha: string) => {
      git(repository, "checkout", "--quiet", "--detach", sha);
      return runStep(text, "Resolve release version", directory, {
        PATH: `${fakeNpm}:${process.env.PATH ?? ""}`,
        MODE: "preview",
        GITHUB_SHA: sha,
        FAKE_NEXT_HEAD: previous,
        FAKE_LATEST: "0.4.3",
        FAKE_PUBLISHED: "",
      });
    };
    const skipped = resolve(preview, release);
    assert.deepEqual([skipped.status, skipped.outputs], [0, ""], skipped.stderr);
    assert.equal(skipped.stdout, "::notice::@antelopejs/x ships nothing new since its last preview, so it gets no new one.\n");
    assert.match(resolve(release, range).outputs, /^version=0\.4\.4-next\.\d+\.g[0-9a-f]{7}\n$/);
    assert.match(resolve(range, source).outputs, /^version=0\.4\.4-next\./);
    assert.equal(resolve(custom, customRelease).outputs, "");
    assert.match(resolve(source, customRelease).outputs, /^version=0\.4\.4-next\./);
  });

  test("Resolve release version refuses a stable version that changes the major or does not move forward", () => {
    const stable = (release: string, latest: string, publishedFrom = "") =>
      runStep(text, "Resolve release version", packagePath, {
        PATH: `${fakeNpm}:${process.env.PATH ?? ""}`,
        MODE: "stable",
        RELEASE_VERSION: release,
        FAKE_LATEST: latest,
        FAKE_STABLE_HEAD: publishedFrom,
        GITHUB_REF_NAME: "main",
      });
    assert.equal(stable("0.5.0", "0.4.2").outputs, "version=0.5.0\n");
    assert.equal(stable("0.4.3", "0.4.2").outputs, "version=0.4.3\n");
    assert.equal(stable("0.1.0", "").outputs, "version=0.1.0\n");
    assert.equal(stable("1.0.0", "0.4.2").status, 1);
    assert.equal(stable("0.4.1", "0.4.2").status, 1);
    assert.equal(stable("0.3.9", "0.4.2").status, 1);
  });

  test("Resolve release version resumes a stable version npm holds without its tag, and refuses one it cannot finish", () => {
    const stable = (publishedFrom: string) =>
      runStep(text, "Resolve release version", packagePath, {
        PATH: `${fakeNpm}:${process.env.PATH ?? ""}`,
        MODE: "stable",
        RELEASE_VERSION: "0.4.2",
        FAKE_LATEST: "0.4.2",
        FAKE_STABLE_HEAD: publishedFrom,
        GITHUB_REF_NAME: "main",
      });
    assert.equal(stable(head).outputs, "resume=true\nversion=0.4.2\n");
    const refused = (from: string, shown = from) => {
      const result = stable(from);
      assert.deepEqual(
        [result.status, result.stderr],
        [1, `npm holds @antelopejs/x 0.4.2 from commit ${shown}, not from main at the planned commit ${head}, so this run cannot finish its release.\n`],
      );
    };
    refused(firstCommit);
    refused("1".repeat(40));
    refused("", "unknown");
    git(checkout, "tag", "v0.4.2");
    const released = stable("");
    git(checkout, "tag", "--delete", "v0.4.2");
    assert.deepEqual([released.status, released.stderr], [1, "@antelopejs/x 0.4.2 is released: npm holds it and the tag v0.4.2 exists.\n"]);
  });

  test("Write release notes leaves npm out of a resumed run and of a package that publishes itself", () => {
    const config = (name: string, releaseIt: object, resume: string): unknown => {
      const { directory } = repository(`release-${name}`, { "package.json": "{}\n", ".release-it.json": JSON.stringify(releaseIt) });
      const env = { PATH: `${fakeNpm}:${process.env.PATH ?? ""}`, FAKE_PULLS: "[]", GITHUB_REPOSITORY: "AntelopeJS/x", DEFAULT_BRANCH: "main", RELEASE_VERSION: "0.4.3", RESUME: resume, ...hermeticGit };
      const result = runStep(text, "Write release notes", directory, env);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(readFileSync(join(root, "release-it.json"), "utf8"));
    };
    const notes = `cat '${join(root, "release-notes.md")}'`;
    assert.deepEqual(config("resumed", { hooks: { "before:npm:release": "echo before" } }, "true"), {
      hooks: { "before:npm:release": "echo before" },
      git: { requireCleanWorkingDir: false },
      github: { releaseNotes: notes },
      npm: { publish: false },
    });
    assert.deepEqual(config("self-published", { npm: { publish: false, skipChecks: true }, hooks: { "after:bump": ["node scripts/publish.mjs"] } }, ""), {
      npm: { publish: false, skipChecks: true },
      hooks: { "after:bump": ["node scripts/publish.mjs"] },
      git: { requireCleanWorkingDir: false },
      github: { releaseNotes: notes },
    });
    assert.deepEqual(config("no-npm", { npm: false }, ""), {
      npm: false,
      git: { requireCleanWorkingDir: false },
      github: { releaseNotes: notes },
    });
    assert.deepEqual(config("own-hook",{ hooks: { "before:npm:release": "echo before" } }, ""), {
      hooks: { "before:npm:release": ["echo before", `bash '${join(root, "publish.sh")}' latest`] },
      git: { requireCleanWorkingDir: false },
      github: { releaseNotes: notes },
      npm: { publish: false },
    });
  });

  const manifests = {
    public: { name: "@antelopejs/x", license: "Apache-2.0", publishConfig: { access: "public", provenance: true } },
    private: { name: "@antelopejs-private/x", license: "Apache-2.0", publishConfig: { registry: "https://npm.antelopejs.cloud/" } },
  };
  const validateMetadata = (registry: string, manifest: object, repository: unknown, published = "") =>
    runStep(text, "Validate package publication metadata", packageDirectory(`release-${registry}-metadata`, { ...manifest, repository }), {
      PATH: `${fakeNpm}:${process.env.PATH ?? ""}`,
      GITHUB_REPOSITORY: "AntelopeJS/x",
      FAKE_REPOSITORY: published,
      REGISTRY: registry,
    });

  for (const [registry, valid] of Object.entries(manifests)) {
    test(`Validate package publication metadata refuses a ${registry} package of another repository`, () => {
      const validate = (repository: unknown, published = "") => validateMetadata(registry, valid, repository, published);
      assert.equal(validate({ type: "git", url: "git+https://github.com/AntelopeJS/x.git" }).status, 0);
      assert.equal(validate("https://github.com/antelopejs/x", "git+https://github.com/AntelopeJS/x.git").status, 0);
      const other = validate({ type: "git", url: "git+https://github.com/AntelopeJS/y.git" });
      assert.deepEqual([other.status, other.stderr], [1, "repository.url must name AntelopeJS/x, got git+https://github.com/AntelopeJS/y.git\n"]);
      const missing = validate(undefined);
      assert.deepEqual([missing.status, missing.stderr], [1, "repository.url must name AntelopeJS/x, got nothing\n"]);
      const taken = validate({ url: "git+https://github.com/AntelopeJS/x.git" }, "git+https://github.com/AntelopeJS/y.git");
      assert.deepEqual([taken.status, taken.stderr], [1, `${valid.name} on npm comes from git+https://github.com/AntelopeJS/y.git, not from AntelopeJS/x\n`]);
    });
  }

  test("Validate package publication metadata holds each registry to its own scope and publishConfig", () => {
    const repository = "https://github.com/AntelopeJS/x";
    const publicOnPrivate = validateMetadata("private", manifests.public, repository);
    assert.deepEqual([publicOnPrivate.status, publicOnPrivate.stderr], [1, "name must use the @antelopejs-private scope\npublishConfig.registry must be https://npm.antelopejs.cloud/\n"]);
    const privateOnPublic = validateMetadata("public", manifests.private, repository);
    assert.deepEqual(
      [privateOnPublic.status, privateOnPublic.stderr],
      [1, "name must use the @antelopejs scope\npublishConfig.access must be public\npublishConfig.provenance must be true\n"],
    );
  });

  test("Validate release credentials asks the private registry's token and refuses another registry", () => {
    const check = (env: Record<string, string>) => {
      const result = runStep(text, "Validate release credentials", root, { MODE: "preview", RELEASE_GITHUB_TOKEN: "", NPM_ANTELOPE_TOKEN: "", ...env });
      return [result.status, result.stderr];
    };
    assert.deepEqual(check({ REGISTRY: "public" }), [0, ""]);
    assert.deepEqual(check({ REGISTRY: "private" }), [1, "NPM_ANTELOPE_TOKEN is not configured.\n"]);
    assert.deepEqual(check({ REGISTRY: "private", NPM_ANTELOPE_TOKEN: "token" }), [0, ""]);
    assert.deepEqual(check({ REGISTRY: "public", MODE: "stable" }), [1, "RELEASE_GITHUB_TOKEN is not configured.\n"]);
    assert.deepEqual(check({ REGISTRY: "public", MODE: "pull-request" }), [0, ""]);
    assert.deepEqual(check({ REGISTRY: "private", MODE: "pull-request" }), [1, "NPM_ANTELOPE_TOKEN is not configured.\n"]);
    assert.deepEqual(check({ REGISTRY: "public", MODE: "repin" }), [1, "RELEASE_GITHUB_TOKEN is not configured.\n"]);
    assert.deepEqual(check({ REGISTRY: "public", MODE: "repin", RELEASE_GITHUB_TOKEN: "token" }), [0, ""]);
    assert.deepEqual(check({ REGISTRY: "npmjs" }), [1, "registry must be public or private, got 'npmjs'.\n"]);
  });

  test("a repin run commits the devDependency ranges to the default branch, and refuses a runtime pin or no range", () => {
    const preview = "0.4.3-next.117.g3645dff";
    const manifest = (spec: string) => `${JSON.stringify({ name: "@antelopejs/m", version: "1.8.6", devDependencies: { "@antelopejs/interface-database": spec } }, null, 2)}\n`;
    const bare = join(root, "repin-origin.git");
    const seed = join(root, "repin-seed");
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
    git(root, "clone", "--quiet", bare, seed);
    commitFiles(seed, "chore: pin the interface preview", { "package.json": manifest(preview), "pnpm-lock.yaml": lockfile(preview, preview) });
    git(seed, "push", "--quiet", "origin", "main");
    const runner = join(root, "repin-runner");
    git(root, "clone", "--quiet", bare, runner);
    const env = { ...hermeticGit, RUNNER_TEMP: join(root, "repin-temp"), GITHUB_TOKEN: "token" };
    mkdirSync(env.RUNNER_TEMP);
    assert.equal(runStep(text, "Configure release identity", runner, env).status, 0);
    const ranges = runStep(text, "Apply dependency ranges", runner, { ...env, MODE: "repin", DEPENDENCY_RANGES: '{"@antelopejs/interface-database":">=0.5.0 <0.6.0"}' });
    assert.equal(ranges.status, 0, ranges.stderr);
    const message = ranges.outputs.replace(/^message=/, "").trim();
    assert.equal(message, "fix(deps): depend on the stable @antelopejs/interface-database");
    writeFileSync(join(runner, "pnpm-lock.yaml"), lockfile(">=0.5.0 <0.6.0", "0.5.0"));
    assert.equal(runStep(text, "Stage stable dependencies", runner, { ...env, PACKAGE_DIRECTORY: ".", LOCKFILE: "pnpm-lock.yaml" }).status, 0);
    const pushed = runStep(text, "Push the stable ranges", runner, { ...env, MESSAGE: message, GITHUB_REF_NAME: "main" });
    assert.equal(pushed.status, 0, pushed.stderr);
    assert.equal(git(bare, "log", "-1", "--format=%s", "main"), message);
    assert.equal(`${git(bare, "show", "main:package.json")}\n`, manifest(">=0.5.0 <0.6.0"));
    assert.deepEqual(git(bare, "branch", "--list"), "* main");
    assert.deepEqual(git(bare, "tag", "--list"), "");

    const runtime = packageDirectory(`release-repin-runtime`, {
      name: "@antelopejs/x",
      dependencies: { "@antelopejs/core": "0.6.0-next.1.gabc1234" },
      devDependencies: { "@antelopejs/db": "0.5.0-next.2.gabc1234" },
    });
    const refused = runStep(text, "Apply dependency ranges", runtime, { MODE: "repin", DEPENDENCY_RANGES: '{"@antelopejs/core":">=0.6.0 <0.7.0","@antelopejs/db":">=0.5.0 <0.6.0"}' });
    assert.deepEqual([refused.status, refused.outputs], [1, ""]);
    assert.match(refused.stderr, /a runtime pin needs a release: @antelopejs\/core$/m);
    const empty = runStep(text, "Apply dependency ranges", runtime, { MODE: "repin", DEPENDENCY_RANGES: "{}" });
    assert.deepEqual([empty.status, empty.outputs], [1, ""]);
  });

  test("Resolve release version publishes no preview for a release commit or a separately released nested package", () => {
    const previews = join(root, `release-previews`);
    mkdirSync(previews);
    git(previews, "init", "--quiet");
    const manifest = (version: string, dependencies = {}) => `${JSON.stringify({ name: "@antelopejs/x", version, dependencies }, null, 2)}\n`;
    const previous = commitFiles(previews, "feat: x", {
      "package.json": manifest("0.5.0"),
      "src/index.js": "x\n",
      "inner/package.json": "{}\n",
      "inner/.release-it.json": "{}\n",
      "frontend-vue/package.json": "{}\n",
      "pnpm-lock.yaml": "inner: 0.1.0\n",
    });
    const decide = (from: string, to: string) =>
      runStep(text, "Resolve release version", previews, {
        PATH: `${fakeNpm}:${process.env.PATH ?? ""}`,
        MODE: "preview",
        GITHUB_SHA: to,
        FAKE_NEXT_HEAD: from,
        FAKE_LATEST: "0.5.0",
        FAKE_PUBLISHED: "",
      }).outputs;
    const released = commitFiles(previews, "chore(release): v0.5.1", { "package.json": manifest("0.5.1"), "CHANGELOG.md": "## v0.5.1\n" });
    assert.equal(decide(previous, released), "");
    const nested = commitFiles(previews, "chore(release): inner v0.2.0", { "inner/CHANGELOG.md": "## v0.2.0\n", "inner/index.js": "y\n", "pnpm-lock.yaml": "inner: 0.2.0\n" });
    assert.equal(decide(previous, nested), "");
    const frontend = commitFiles(previews, "fix(frontend): x", { "frontend-vue/index.vue": "x\n" });
    assert.match(decide(previous, frontend), /^version=0\.5\.1-next\./);
    const dependency = commitFiles(previews, "fix(deps): x", { "package.json": manifest("0.5.1", { "@antelopejs/y": "~1.0.0" }) });
    assert.match(decide(frontend, dependency), /^version=0\.5\.1-next\./);
  });

  const condition = (step: string): string | undefined => /^ {8}if: (.*)$/m.exec(stepOf(text, step))?.[1];
  const runs = (step: string, mode: string, registry = "public", version = "1.0.0"): boolean => {
    const expression = condition(step);
    return expression === undefined || evaluate(expression, { steps: { mode: { outputs: { mode } }, version: { outputs: { version } } }, inputs: { registry } }) === true;
  };

  test("each publishing step runs for the modes and registries it serves, and no other", () => {
    const publishers = ["Publish preview", "Install pkg.pr.new", "Publish to pkg.pr.new", "Publish stable release"];
    const published = (mode: string, registry: string, version = "1.0.0") => publishers.filter((step) => runs(step, mode, registry, version));
    for (const registry of ["public", "private"]) {
      assert.deepEqual(published("preview", registry), ["Publish preview"], `preview ${registry}`);
      assert.deepEqual(published("stable", registry), ["Publish stable release"], `stable ${registry}`);
      assert.deepEqual(published("repin", registry), [], `repin ${registry}`);
      for (const mode of ["preview", "pull-request"]) assert.deepEqual(published(mode, registry, ""), [], `${mode} ${registry} without a version`);
    }
    assert.deepEqual(published("pull-request", "private"), ["Publish preview"]);
    assert.deepEqual(published("pull-request", "public"), ["Install pkg.pr.new", "Publish to pkg.pr.new"]);
  });

  test("only a stable or repin run checks the plan, applies ranges and configures the release identity", () => {
    for (const step of ["Check the planned commit", "Apply dependency ranges", "Configure release identity"]) {
      for (const mode of ["preview", "pull-request", "stable", "repin"]) assert.equal(runs(step, mode), mode === "stable" || mode === "repin", `${step} in ${mode}`);
    }
    assert.equal(runs("Push the stable ranges", "repin"), true);
    for (const mode of ["preview", "pull-request", "stable"]) assert.equal(runs("Push the stable ranges", mode), false, mode);
  });

  test("the job runs a push only of the default branch, and a pull request only when it carries the preview label, a labeled event only for that label", () => {
    const job = /^ {4}if: (.*)$/m.exec(text)?.[1] ?? "";
    const gate = (event: string, action: string, labels: string[], label = "", branch = "main") =>
      evaluate(job, { github: { event_name: event, ref_name: branch, event: { action, label: { name: label }, pull_request: { labels }, repository: { default_branch: "main" } } } });
    assert.equal(gate("push", "", []), true);
    assert.equal(gate("push", "", [], "", "next"), false);
    assert.equal(gate("workflow_dispatch", "", []), true);
    assert.equal(gate("pull_request", "opened", []), false);
    assert.equal(gate("pull_request", "opened", ["ci:full"]), false);
    assert.equal(gate("pull_request", "opened", ["preview"]), true);
    assert.equal(gate("pull_request", "synchronize", ["ci:full", "preview"]), true);
    assert.equal(gate("pull_request", "labeled", ["preview"], "preview"), true);
    assert.equal(gate("pull_request", "labeled", ["preview", "ci:full"], "ci:full"), false);
    assert.equal(gate("pull_request", "labeled", ["ci:full"], "ci:full"), false);
  });

  test("a pull request run uses no environment, has a group of its own per pull request, and cancels the run it replaces", () => {
    const attribute = (indent: number, name: string): string => {
      const prefix = `${" ".repeat(indent)}${name}: `;
      const line = text.split("\n").find((candidate) => candidate.startsWith(prefix));
      assert.notEqual(line, undefined, name);
      return line?.slice(prefix.length) ?? "";
    };
    const scope = (event: string, number?: number) => ({ github: { repository: "AntelopeJS/x", event_name: event, event: { pull_request: number === undefined ? {} : { number } } }, inputs: { "package-directory": "." } });
    const environment = attribute(4, "environment");
    assert.equal(evaluate(environment, scope("push")), "npm-publish");
    assert.equal(evaluate(environment, scope("workflow_dispatch")), "npm-publish");
    assert.equal(evaluate(environment, scope("pull_request", 12)), "");
    const group = (event: string, number?: number): string => interpolate(attribute(6, "group"), scope(event, number));
    assert.notEqual(group("pull_request", 12), group("pull_request", 13));
    assert.equal(group("pull_request", 12), group("pull_request", 12));
    assert.notEqual(group("pull_request", 12), group("push"));
    assert.notEqual(group("push"), group("workflow_dispatch"));
    const cancel = attribute(6, "cancel-in-progress");
    assert.deepEqual([evaluate(cancel, scope("pull_request", 12)), evaluate(cancel, scope("push")), evaluate(cancel, scope("workflow_dispatch"))], [true, false, false]);
  });

  test("a pull request run builds the head commit of the pull request, and any other run the commit of its event", () => {
    const ref = /^ {10}ref: (.*)$/m.exec(text)?.[1] ?? "";
    const head = "a".repeat(40);
    assert.equal(evaluate(ref, { github: { event: { pull_request: { head: { sha: head } } } } }), head);
    assert.equal(evaluate(ref, { github: { event: { pull_request: { head: {} } } } }), "");
  });

  test("only a job that installs restores and saves the pnpm cache", () => {
    const steps = text.split("\n      - ").slice(1);
    const condition = (step: string) => /^ {8}if: (.*)$/m.exec(step)?.[1];
    const install = steps.findIndex((step) => step.startsWith("name: Install dependencies\n"));
    const cached = steps.flatMap((step, index) => (/^ {10}cache: pnpm$/m.test(step) ? [index] : []));
    assert.equal(cached.length, 1);
    assert.ok(cached[0] < install);
    assert.equal(condition(steps[cached[0]]), condition(steps[install]));
    assert.equal(condition(steps[install]), "steps.version.outputs.version != '' || steps.mode.outputs.mode == 'repin'");
  });

  test("a preview run cannot write to the repository", () => {
    assert.doesNotMatch(text, /permissions:|id-token/, "the job inherits the grant of the entry that calls it, and a private caller grants no id-token");
    for (const entry of ["release-npm-public.yml", "release-npm-private.yml"]) {
      const caller = workflowText(entry);
      const permissions = caller.slice(caller.indexOf("    permissions:\n"), caller.indexOf("    uses: ./.github/workflows/release-npm.yml\n"));
      assert.match(permissions, /^ {6}contents: read$/m, entry);
      assert.doesNotMatch(caller, /contents: write/, entry);
    }
  });

  test("only the public entry point grants id-token: write, which npm trusted publishing and provenance need", () => {
    const grant = (entry: string): string => {
      const caller = workflowText(entry);
      return caller.slice(caller.indexOf("    permissions:\n"), caller.indexOf("    uses: ./.github/workflows/release-npm.yml\n"));
    };
    assert.match(grant("release-npm-public.yml"), /^ {6}id-token: write$/m);
    assert.doesNotMatch(grant("release-npm-private.yml"), /id-token/);
  });
});

test("the starter workflow is the frozen caller that antelopejs-sync writes", () => {
  const template = readFileSync(new URL("../../workflow-templates/npm-release.yml", import.meta.url), "utf8");
  assert.equal(template, readFileSync(new URL("./frozen-caller.yml", import.meta.url), "utf8"));
});

test("the README caller example is the starter workflow", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const section = readme.slice(readme.indexOf("### Caller workflow"));
  const example = /```yaml\n([\s\S]*?)```/.exec(section)?.[1];
  assert.equal(example, readFileSync(new URL("../../workflow-templates/npm-release.yml", import.meta.url), "utf8"));
});

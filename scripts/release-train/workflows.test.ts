import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { nonRegistrySpecs, registrySpecs } from "./registry-specs.ts";

const workflowText = (file: string): string => readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");
const workflows = ["release-npm-public.yml", "release-npm-private.yml"].map((file) => ({ file, text: workflowText(file) }));
const nextSync = workflowText("next-sync.yml");
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

interface Publication {
  manifest: unknown;
  args: string[];
}

let previews = 0;
function publishPreview(text: string, cwd: string, version: string, env: Record<string, string> = {}): StepResult & { publication: Publication | null } {
  previews += 1;
  const log = join(root, `npm-publish-${previews}.log`);
  const result = runStep(text, "Publish preview", cwd, { PATH: `${recordingNpm}:${process.env.PATH ?? ""}`, VERSION: version, NPM_PUBLISH_LOG: log, ...hermeticGit, ...env });
  if (!existsSync(log)) return { ...result, publication: null };
  const [directory = "", ...args] = readFileSync(log, "utf8").trimEnd().split("\n");
  const tarball = args.find((arg) => arg.endsWith(".tgz"));
  const manifest = tarball === undefined ? readFileSync(join(directory, "package.json"), "utf8") : spawnSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }).stdout;
  return { ...result, publication: { manifest: JSON.parse(manifest), args: args.filter((arg) => arg !== tarball) } };
}

function pinned(version: string, spec: string): string {
  return `${JSON.stringify({ name: "@antelopejs/m", version, description: "m", license: "Apache-2.0", type: "module", dependencies: { "@antelopejs/interface-database": spec } }, null, 2)}\n`;
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

let origins = 0;
function promotedOrigin(): string {
  origins += 1;
  const bare = join(root, `origin-${origins}.git`);
  const seed = join(root, `seed-${origins}`);
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
  git(root, "clone", "--quiet", bare, seed);
  commitFiles(seed, "feat: first", { "package.json": pinned("1.8.6", ">=0.4.1 <0.5.0"), "pnpm-lock.yaml": lockfile(">=0.4.1 <0.5.0", "0.4.2"), "src/feed.ts": "x\n" });
  git(seed, "tag", "v1.8.6");
  git(seed, "checkout", "--quiet", "-b", "next");
  const preview = "0.4.3-next.117.g3645dff";
  commitFiles(seed, "fix(database): pin the interface preview", { "package.json": pinned("1.8.6", preview), "pnpm-lock.yaml": lockfile(preview, preview) });
  commitFiles(seed, "fix(database): close the change feed", { "src/feed.ts": "y\n" });
  git(seed, "checkout", "--quiet", "main");
  git(seed, "merge", "--quiet", "--squash", "next");
  git(seed, "commit", "--quiet", "-m", "fix(database): close the change feed (#7)");
  git(seed, "push", "--quiet", "origin", "main", "next", "--tags");
  return bare;
}

for (const { file, text } of workflows) {
  describe(file, () => {
    test("Apply dependency ranges refuses every runtime preview or non-registry spec and warns on a devDependency preview", () => {
      const pinned = packageDirectory(`${file}-pinned`, {
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
      const local = packageDirectory(`${file}-local`, {
        name: "@antelopejs/x",
        dependencies: Object.fromEntries(nonRegistrySpecs.map((spec, index) => [`@antelopejs/d${index}`, spec])),
        peerDependencies: { "@antelopejs/p": "file:../p" },
        optionalDependencies: { "@antelopejs/o": "link:../o" },
        devDependencies: { "@antelopejs/dev": "file:../dev" },
      });
      const unpublishable = runStep(text, "Apply dependency ranges", local);
      assert.equal(unpublishable.status, 1);
      assert.deepEqual(unpublishable.stderr.trim().split("\n").slice(1), [
        ...nonRegistrySpecs.map((spec, index) => `dependencies @antelopejs/d${index} ${spec}`),
        "peerDependencies @antelopejs/p file:../p",
        "optionalDependencies @antelopejs/o link:../o",
      ]);
      const ranges = packageDirectory(`${file}-registry`, {
        name: "@antelopejs/x",
        dependencies: Object.fromEntries(registrySpecs.filter((spec) => !/\d-/.test(spec)).map((spec, index) => [`@antelopejs/r${index}`, spec])),
      });
      assert.equal(runStep(text, "Apply dependency ranges", ranges).status, 0);
      const dev = packageDirectory(`${file}-dev`, {
        name: "@antelopejs/x",
        dependencies: { "@antelopejs/b": "~1.8.6" },
        devDependencies: { "@antelopejs/c": "^2.0.0-beta.1" },
      });
      const warned = runStep(text, "Apply dependency ranges", dev);
      assert.deepEqual([warned.status, warned.stdout], [0, "::warning::The stable release keeps the devDependency preview @antelopejs/c ^2.0.0-beta.1.\n"]);
      const clean = packageDirectory(`${file}-clean`, { name: "@antelopejs/x", dependencies: { "@antelopejs/b": "~1.8.6" } });
      const passed = runStep(text, "Apply dependency ranges", clean);
      assert.deepEqual([passed.status, passed.stdout], [0, ""]);
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
      for (const range of ["file:../x", "github:AntelopeJS/x#next", "0.7.0-next.1.gabc1234", "latest", `${Array.from({ length: 40 }, () => "1").join("      ")}!`]) {
        const invalid = runStep(text, "Apply dependency ranges", directory, { DEPENDENCY_RANGES: JSON.stringify({ "@antelopejs/core": range }) });
        assert.deepEqual([invalid.status, invalid.stderr], [1, `dependency-ranges must map each name to a stable version range:\n@antelopejs/core ${range}\n`]);
      }
    });

    test("Resolve release mode previews a push off the default branch and releases a dispatch on it", () => {
      const mode = (event: string, ref: string, version = "", commit = head) =>
        runStep(text, "Resolve release mode", root, {
          GITHUB_EVENT_NAME: event,
          GITHUB_REF: ref,
          DEFAULT_BRANCH: "main",
          RELEASE_VERSION: version,
          RELEASE_COMMIT: commit,
        });
      assert.equal(mode("push", "refs/heads/next").outputs, "mode=preview\n");
      assert.equal(mode("push", "refs/heads/next", "", "").outputs, "mode=preview\n");
      assert.equal(mode("workflow_dispatch", "refs/heads/main", "0.5.0").outputs, "mode=stable\n");
      assert.equal(mode("workflow_dispatch", "refs/heads/main", "0.5.0", "").status, 1);
      assert.equal(mode("workflow_dispatch", "refs/heads/main", "0.5.0", head.slice(0, 7)).status, 1);
      assert.equal(mode("workflow_dispatch", "refs/heads/main").status, 1);
      assert.equal(mode("workflow_dispatch", "refs/heads/main", "0.5.0-next.1").status, 1);
      assert.equal(mode("workflow_dispatch", "refs/heads/next", "0.5.0").status, 1);
      assert.equal(mode("push", "refs/heads/main").status, 1);
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
        const directory = join(root, `${file}-${name}`);
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
      });

      const fresh = write("fresh", {});
      assert.equal(fresh.read("CHANGELOG.md"), `# Changelog\n\n${fresh.section}`);
      assert.equal(fresh.staged, "CHANGELOG.md");
      assert.deepEqual(fresh.config, {
        git: { requireCleanWorkingDir: false },
        github: { releaseNotes: `cat '${join(root, "release-notes.md")}'` },
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
      });
    });

    test("Write release notes lists one line per task of the cycle from the promotion's head, with breaking changes and contributors", () => {
      const repo = join(root, `${file}-cycle`);
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
        { number: 7, mergeCommit: { oid: "e".repeat(40) }, headRefOid: "f".repeat(40) },
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
      assert.equal(result.status, 0, result.stderr);
      const pull = (number: number): string => `[#${number}](https://github.com/AntelopeJS/interface-database/pull/${number})`;
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
      const repo = join(root, `${file}-tooling`);
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

    test("Publish stable release runs release-it with the written config", () => {
      const bin = join(root, `${file}-pnpm`);
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
        `exec release-it --config ${join(root, "release-it.json")} --ci --git.requireBranch=main --git.tagExclude=*.*.*-* --increment=0.5.0\n`,
      );
    });

    test("Publish preview publishes the packed package, with each workspace: spec resolved and the commit as gitHead", () => {
      const { directory, sha } = repository(`${file}-monorepo`, {
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
      const { directory, sha: first } = repository(`${file}-siblings`, {
        "package.json": JSON.stringify({ name: "workspace", private: true }),
        "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
        "packages/interface-x/package.json": manifest("@antelopejs/interface-x", "0.10.0"),
        "packages/interface-x/.release-it.json": "{}\n",
        "packages/interface-y/package.json": manifest("@antelopejs/interface-y", "0.4.0"),
        "packages/interface-y/.release-it.json": "{}\n",
        "packages/interface-z/package.json": manifest("@antelopejs/interface-z", "0.2.0"),
        "packages/interface-z/.release-it.json": "{}\n",
        "packages/x/package.json": manifest("@antelopejs/x", "0.12.1", {
          "@antelopejs/interface-x": "workspace:^",
          "@antelopejs/interface-y": "workspace:^",
          "@antelopejs/interface-z": "workspace:^",
        }),
        "packages/x/.release-it.json": "{}\n",
      });
      const previewed = commitFiles(directory, "fix: y and z", { "packages/interface-y/index.js": "y\n", "packages/interface-z/index.js": "z\n" });
      const sha = commitFiles(directory, "feat: x", { "packages/interface-x/index.js": "x\n", "packages/x/index.js": "x\n" });
      const views = join(root, `${file}-npm-views.tsv`);
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
      const registry = join(root, `${file}-registry-npm`);
      mkdirSync(registry);
      writeFileSync(
        join(registry, "npm"),
        `#!/bin/sh\nif [ "$1" = view ]; then awk -F '\\t' -v key="$2 $3" '$1 == key { print $2; found = 1 } END { exit !found }' "$FAKE_VIEWS" && exit 0; echo "npm error code E404" >&2; exit 1; fi\nexec '${realNpm}' "$@"\n`,
      );
      chmodSync(join(registry, "npm"), 0o755);
      const suffix = `next.3.g${sha.slice(0, 7)}`;
      const resolved = runStep(text, "Resolve release version", join(directory, "packages", "x"), {
        PATH: `${registry}:${process.env.PATH ?? ""}`,
        MODE: "preview",
        GITHUB_SHA: sha,
        FAKE_VIEWS: views,
        ...hermeticGit,
      });
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
      const { directory } = repository(`${file}-unpublishable`, {
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

    test("Resolve release version publishes no preview when only the version and the changelog changed", () => {
      const repository = join(root, `${file}-back-merge`);
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

    test("Publish stable release leaves npm out of a resumed run", () => {
      const publish = (resume: string) =>
        runStep(text, "Publish stable release", packagePath, {
          PATH: `${fakeNpm}:${process.env.PATH ?? ""}`,
          RELEASE_VERSION: "0.4.2",
          RESUME: resume,
          GITHUB_TOKEN: "token",
          GITHUB_REF_NAME: "main",
          ...hermeticGit,
        });
      const releaseIt = `pnpm exec release-it --config ${root}/release-it.json --ci --git.requireBranch=main --git.tagExclude=*.*.*-* --increment=0.4.2`;
      assert.equal(publish("").stdout, `${releaseIt}\n`);
      assert.equal(publish("true").stdout, `${releaseIt} --no-npm.publish\n`);
    });

    test("Validate package publication metadata refuses a package of another repository", () => {
      const valid = file.includes("private")
        ? { name: "@antelopejs-private/x", license: "Apache-2.0", publishConfig: { registry: "https://npm.antelopejs.cloud/" } }
        : { name: "@antelopejs/x", license: "Apache-2.0", publishConfig: { access: "public", provenance: true } };
      const validate = (repository: unknown, published = "") =>
        runStep(text, "Validate package publication metadata", packageDirectory(`${file}-metadata`, { ...valid, repository }), {
          PATH: `${fakeNpm}:${process.env.PATH ?? ""}`,
          GITHUB_REPOSITORY: "AntelopeJS/x",
          FAKE_REPOSITORY: published,
        });
      assert.equal(validate({ type: "git", url: "git+https://github.com/AntelopeJS/x.git" }).status, 0);
      assert.equal(validate("https://github.com/antelopejs/x", "git+https://github.com/AntelopeJS/x.git").status, 0);
      const other = validate({ type: "git", url: "git+https://github.com/AntelopeJS/y.git" });
      assert.deepEqual([other.status, other.stderr], [1, "repository.url must name AntelopeJS/x, got git+https://github.com/AntelopeJS/y.git\n"]);
      const missing = validate(undefined);
      assert.deepEqual([missing.status, missing.stderr], [1, "repository.url must name AntelopeJS/x, got nothing\n"]);
      const taken = validate({ url: "git+https://github.com/AntelopeJS/x.git" }, "git+https://github.com/AntelopeJS/y.git");
      assert.deepEqual([taken.status, taken.stderr], [1, `${valid.name} on npm comes from git+https://github.com/AntelopeJS/y.git, not from AntelopeJS/x\n`]);
    });

    test("a stable run that rewrites a pin brings the range to next, so the Next sync merges without a conflict", () => {
      const release = (bringToNext: boolean): { sync: StepResult; next: string } => {
        const bare = promotedOrigin();
        const runner = join(root, `runner-${origins}`);
        git(root, "clone", "--quiet", bare, runner);
        const env = { ...hermeticGit, RUNNER_TEMP: join(root, `temp-${origins}`) };
        mkdirSync(env.RUNNER_TEMP);
        assert.equal(runStep(text, "Configure release identity", runner, env).status, 0);
        const ranges = runStep(text, "Apply dependency ranges", runner, { ...env, DEPENDENCY_RANGES: '{"@antelopejs/interface-database":">=0.5.0 <0.6.0"}' });
        assert.equal(ranges.status, 0, ranges.stderr);
        writeFileSync(join(runner, "pnpm-lock.yaml"), lockfile(">=0.5.0 <0.6.0", "0.5.0"));
        const message = ranges.outputs.replace(/^message=/, "").trim();
        const planned = git(runner, "rev-parse", "HEAD");
        assert.equal(runStep(text, "Stage stable dependencies", runner, { ...env, PACKAGE_DIRECTORY: ".", LOCKFILE: "pnpm-lock.yaml" }).status, 0);
        if (bringToNext) {
          const brought = runStep(text, "Bring the stable ranges to the integration branch", runner, { ...env, BRANCH: "next", MESSAGE: message, GITHUB_TOKEN: "token" });
          assert.deepEqual([brought.status, brought.stdout], [0, ""], brought.stderr);
          assert.equal(git(bare, "log", "-1", "--format=%s", "next"), message);
        }
        assert.equal(git(runner, "rev-parse", "HEAD"), planned);
        assert.deepEqual(git(runner, "diff", "--cached", "--name-only").split("\n"), ["package.json", "pnpm-lock.yaml"]);
        commitFiles(runner, "chore(release): v1.8.7", { "package.json": pinned("1.8.7", ">=0.5.0 <0.6.0"), "CHANGELOG.md": "## v1.8.7\n" });
        git(runner, "tag", "v1.8.7");
        git(runner, "push", "--quiet", "origin", "main", "--tags");
        const sync = join(root, `sync-${origins}`);
        mkdirSync(sync);
        const result = runStep(nextSync, "Merge", sync, {
          ...hermeticGit,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`,
          GIT_CONFIG_VALUE_0: "https://github.com/AntelopeJS/m.git",
          GH_REPO: "AntelopeJS/m",
          BRANCH: "next",
          DEFAULT_BRANCH: "main",
          TOKEN: "token",
        });
        return { sync: result, next: git(bare, "show", "next:package.json") };
      };
      const conflicted = release(false);
      assert.equal(conflicted.sync.status, 1);
      assert.equal(conflicted.sync.outputs, "files=package.json, pnpm-lock.yaml\n");
      const merged = release(true);
      assert.equal(merged.sync.status, 0, merged.sync.stdout + merged.sync.stderr);
      assert.equal(`${merged.next}\n`, pinned("1.8.7", ">=0.5.0 <0.6.0"));
    });

    test("Bring the stable ranges to the integration branch leaves a next that changed the same lines, and a repository without next", () => {
      const bare = promotedOrigin();
      const seed = join(root, `seed-${origins}`);
      git(seed, "checkout", "--quiet", "next");
      commitFiles(seed, "fix(database): pin a newer interface preview", { "package.json": pinned("1.8.6", "0.4.3-next.130.gaaaaaaa") });
      git(seed, "push", "--quiet", "origin", "next");
      const nextTip = git(bare, "rev-parse", "next");
      const runner = join(root, `runner-${origins}`);
      git(root, "clone", "--quiet", bare, runner);
      const env = { ...hermeticGit, RUNNER_TEMP: root, BRANCH: "next", GITHUB_TOKEN: "token" };
      assert.equal(runStep(text, "Configure release identity", runner, hermeticGit).status, 0);
      writeFileSync(join(runner, "package.json"), pinned("1.8.6", ">=0.5.0 <0.6.0"));
      git(runner, "add", "package.json");
      const kept = runStep(text, "Bring the stable ranges to the integration branch", runner, { ...env, MESSAGE: "fix(deps): depend on the stable @antelopejs/interface-database" });
      assert.deepEqual(
        [kept.status, kept.stdout],
        [0, "::warning::next changed the same dependency lines since the plan, so it keeps them and the Next sync of this release will conflict.\n"],
      );
      assert.equal(git(bare, "rev-parse", "next"), nextTip);
      const absent = runStep(text, "Bring the stable ranges to the integration branch", runner, { ...env, BRANCH: "integration" });
      assert.deepEqual([absent.status, absent.stdout], [0, ""]);
    });

    test("Resolve release version publishes no preview for a release back-merge or a separately released nested package", () => {
      const previews = join(root, `${file}-previews`);
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
      const backMerge = commitFiles(previews, "chore: merge main into next", { "package.json": manifest("0.5.1"), "CHANGELOG.md": "## v0.5.1\n" });
      assert.equal(decide(previous, backMerge), "");
      const nested = commitFiles(previews, "chore(release): inner v0.2.0", { "inner/CHANGELOG.md": "## v0.2.0\n", "inner/index.js": "y\n", "pnpm-lock.yaml": "inner: 0.2.0\n" });
      assert.equal(decide(previous, nested), "");
      const frontend = commitFiles(previews, "fix(frontend): x", { "frontend-vue/index.vue": "x\n" });
      assert.match(decide(previous, frontend), /^version=0\.5\.1-next\./);
      const dependency = commitFiles(previews, "fix(deps): x", { "package.json": manifest("0.5.1", { "@antelopejs/y": "~1.0.0" }) });
      assert.match(decide(frontend, dependency), /^version=0\.5\.1-next\./);
    });

    test("a preview run cannot write to the repository", () => {
      const permissions = text.slice(text.indexOf("    permissions:\n"), text.indexOf("    concurrency:\n"));
      assert.match(permissions, /^ {6}contents: read$/m);
      assert.doesNotMatch(text, /contents: write/);
    });
  });
}

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

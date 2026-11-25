import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readText } from "./helpers/read.ts";
import { parseObject } from "./json.ts";
import type { JsonObject } from "./json.ts";
import { afterBump, commitFiles, fakeNpm, git, hermeticGit, repository, root, runStep, text } from "./workflows-helpers.ts";

describe("release-npm.yml", () => {
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
      const read = (path: string): string => readText(join(directory, path));
      const config: unknown = JSON.parse(readText(join(root, "release-it.json")));
      const notes = [
        "[compare changes](https://github.com/AntelopeJS/x/compare/v0.4.2...v0.5.0)",
        "### 🩹 Fixes",
        `- Close the feed ([${fix.slice(0, 7)}](https://github.com/AntelopeJS/x/commit/${fix}))`,
        "### ❤️ Contributors",
        "- Test",
      ].join("\n\n");
      return { directory, read, staged: git(directory, "diff", "--cached", "--name-only"), config, notes, section: `## v0.5.0\n\n${notes}\n\n` };
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
    assert.equal(readText(join(root, "release-notes.md")), existing.notes);
    assert.deepEqual(existing.config, {
      git: { tagName: "v${version}", requireCommits: true, requireCleanWorkingDir: false },
      github: { release: true, releaseNotes: `cat '${join(root, "release-notes.md")}'` },
      plugins: { "@release-it/bumper": {} },
      npm: { publish: false },
      hooks: { "after:bump": afterBump(existing.directory), "before:npm:release": [`bash '${join(root, "publish.sh")}' latest`] },
    });

    const fresh = write("fresh", {});
    assert.equal(fresh.read("CHANGELOG.md"), `# Changelog\n\n${fresh.section}`);
    assert.equal(fresh.staged, "CHANGELOG.md");
    assert.deepEqual(fresh.config, {
      git: { requireCleanWorkingDir: false },
      github: { releaseNotes: `cat '${join(root, "release-notes.md")}'` },
      npm: { publish: false },
      hooks: { "after:bump": afterBump(fresh.directory), "before:npm:release": [`bash '${join(root, "publish.sh")}' latest`] },
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
      hooks: { "after:bump": afterBump(custom.directory), "before:npm:release": [`bash '${join(root, "publish.sh")}' latest`] },
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
    const notes = readText(join(root, "release-notes.md")).split("\n\n");
    assert.equal(notes[0], "[compare changes](https://github.com/AntelopeJS/x/compare/v1.24.1...v1.24.2)");
    assert.ok(notes.includes(`- Close the feed ([${fix.slice(0, 7)}](https://github.com/AntelopeJS/x/commit/${fix}))`), notes.join("\n\n"));
    assert.ok(notes.some((line) => line.startsWith("- Accidental major")), notes.join("\n\n"));
  });
});

describe("release-npm.yml", () => {
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
      readText(join(root, "release-notes.md")),
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
    const notes = readText(join(root, "release-notes.md"));
    const sections = ["### 🩹 Fixes", "", `- Close the feed (${link(fix)})`, "", "### 📦 Build", "", `- Move to @antelopejs/tooling-configs 0.8 (${link(build)})`].join("\n");
    assert.ok(notes.includes(sections), notes);
  });
});

describe("release-npm.yml", () => {
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
    assert.equal(readText(join(root, "release-notes.md")), notes);
    assert.equal(readText(join(repo, "CHANGELOG.md")), `# Changelog\n\n## v1.24.3\n\n${notes}\n\n`);
  });

  test("Write release notes leaves npm out of a resumed run and of a package that publishes itself", () => {
    const config = (name: string, releaseIt: JsonObject, resume: string): JsonObject => {
      const { directory } = repository(`release-${name}`, { "package.json": "{}\n", ".release-it.json": JSON.stringify(releaseIt) });
      const env = { PATH: `${fakeNpm}:${process.env.PATH ?? ""}`, FAKE_PULLS: "[]", GITHUB_REPOSITORY: "AntelopeJS/x", DEFAULT_BRANCH: "main", RELEASE_VERSION: "0.4.3", RESUME: resume, ...hermeticGit };
      const result = runStep(text, "Write release notes", directory, env);
      assert.equal(result.status, 0, result.stderr);
      return parseObject(readText(join(root, "release-it.json")));
    };
    const notes = `cat '${join(root, "release-notes.md")}'`;
    assert.deepEqual(config("resumed", { hooks: { "before:npm:release": "echo before" } }, "true"), {
      hooks: { "before:npm:release": "echo before", "after:bump": afterBump(join(root, "release-resumed")) },
      git: { requireCleanWorkingDir: false },
      github: { releaseNotes: notes },
      npm: { publish: false },
    });
    assert.deepEqual(config("self-published", { npm: { publish: false, skipChecks: true }, hooks: { "after:bump": ["node scripts/publish.mjs"] } }, ""), {
      npm: { publish: false, skipChecks: true },
      hooks: { "after:bump": ["node scripts/publish.mjs", ...afterBump(join(root, "release-self-published"))] },
      git: { requireCleanWorkingDir: false },
      github: { releaseNotes: notes },
    });
    assert.deepEqual(config("no-npm", { npm: false }, ""), {
      npm: false,
      hooks: { "after:bump": afterBump(join(root, "release-no-npm")) },
      git: { requireCleanWorkingDir: false },
      github: { releaseNotes: notes },
    });
    assert.deepEqual(config("own-hook",{ hooks: { "before:npm:release": "echo before" } }, ""), {
      hooks: { "after:bump": afterBump(join(root, "release-own-hook")), "before:npm:release": ["echo before", `bash '${join(root, "publish.sh")}' latest`] },
      git: { requireCleanWorkingDir: false },
      github: { releaseNotes: notes },
      npm: { publish: false },
    });
  });
});

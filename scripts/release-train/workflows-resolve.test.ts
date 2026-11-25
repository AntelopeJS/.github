import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { checkout, commitFiles, fakeNpm, firstCommit, git, head, packageCommit, packagePath, previewSuffix, root, runStep, text } from "./workflows-helpers.ts";

describe("release-npm.yml", () => {
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
});

describe("release-npm.yml", () => {
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
});

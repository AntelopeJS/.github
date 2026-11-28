import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { readText } from "./helpers/read.ts";
import { parseObject } from "./json.ts";
import type { JsonObject } from "./json.ts";
import { afterBump, checkout, commitFiles, evaluate, fakeNpm, git, hermeticGit, packageDirectory, repository, root, runStep, stepOf, text } from "./workflows-helpers.ts";
import type { Evaluated, StepResult } from "./workflows-helpers.ts";

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
  const [directory = "", ...args] = readText(log).trimEnd().split("\n");
  const tarball = args.find((arg) => arg.endsWith(".tgz"));
  const manifest = tarball === undefined ? readText(join(directory, "package.json")) : spawnSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }).stdout;
  return { ...result, publication: { manifest: JSON.parse(manifest), args: args.filter((arg) => arg !== tarball) } };
}

describe("release-npm.yml", () => {
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

  test("the after:bump hooks change and stage nothing in a package without sync or a docs-version script", () => {
    const { directory } = repository("release-bare-hooks", { "package.json": JSON.stringify({ name: "@antelopejs/x", version: "0.4.3" }) });
    for (const hook of afterBump(directory)) {
      const result = spawnSync("bash", ["-c", hook], { cwd: directory, encoding: "utf8", env: { ...process.env, ...hermeticGit } });
      assert.equal(result.status, 0, `${hook}\n${result.stdout}${result.stderr}`);
    }
    assert.equal(git(directory, "status", "--porcelain"), "");
  });

  test("Build the interface packages builds each workspace interface package that has a build script, and only in a stable run", () => {
    const { directory } = repository("release-interface-build", {
      "package.json": JSON.stringify({ name: "workspace", private: true }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/interface-x/package.json": JSON.stringify({ name: "@antelopejs/interface-x", version: "0.11.0", scripts: { build: "node -e \"require('fs').writeFileSync('built', '')\"" } }),
      "packages/interface-y/package.json": JSON.stringify({ name: "@antelopejs/interface-y", version: "0.2.0" }),
      "packages/x/package.json": JSON.stringify({ name: "@antelopejs/x", version: "0.12.1", scripts: { build: "exit 1" } }),
    });
    const built = runStep(text, "Build the interface packages", directory);
    assert.equal(built.status, 0, built.stdout + built.stderr);
    assert.ok(existsSync(join(directory, "packages", "interface-x", "built")));
    const single = packageDirectory("release-interface-build-single", { name: "@antelopejs/x", version: "0.12.1", scripts: { build: "exit 1" } });
    const none = runStep(text, "Build the interface packages", single);
    assert.equal(none.status, 0, none.stdout + none.stderr);
    const condition = /^ {8}if: (.*)$/m.exec(stepOf(text, "Build the interface packages"))?.[1] ?? "";
    const runs = (mode: string): Evaluated => evaluate(condition, { steps: { mode: { outputs: { mode } } } });
    assert.deepEqual(["stable", "repin", "preview", "pull-request"].map(runs), [true, false, false, false]);
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
});

describe("release-npm.yml", () => {
  test("a stable run of a workspace package publishes it packed after release-it's bump, with each sibling's released range, and commits what sync and the docs-version write change", () => {
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
      "package.json": JSON.stringify({ name: "workspace", private: true, scripts: { sync: "node sync.mjs" } }),
      "sync.mjs": 'import { readFileSync, writeFileSync } from "node:fs";\nwriteFileSync("synced.txt", JSON.parse(readFileSync("packages/x/package.json", "utf8")).version);\n',
      "synced.txt": "0.12.1",
      "docs/x.md": "^0.12.1",
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/interface-x/package.json": JSON.stringify({ name: "@antelopejs/interface-x", version: "0.11.0" }),
      "packages/x/package.json": `${JSON.stringify(manifest, null, 2)}\n`,
      "packages/x/scripts/check-docs-module-version.mts": 'import { readFileSync, writeFileSync } from "node:fs";\nif (process.argv.includes("--write")) writeFileSync("../../docs/x.md", `^${JSON.parse(readFileSync("package.json", "utf8")).version}`);\n',
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
    const [directory = "", ...args] = readText(log).trimEnd().split("\n");
    const tarball = args.find((arg) => arg.endsWith(".tgz")) ?? join(directory, "package.json");
    const published = tarball.endsWith(".tgz") ? spawnSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }).stdout : readText(tarball);
    assert.deepEqual(
      { manifest: parseObject(published), args: args.filter((arg) => arg !== tarball) },
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
    assert.deepEqual([git(bare, "show", "v0.13.0:synced.txt"), git(bare, "show", "v0.13.0:docs/x.md")], ["0.13.0", "^0.13.0"]);
    assert.equal(git(runner, "status", "--porcelain"), "");
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
});

describe("release-npm.yml", () => {
  test("a preview pins the preview of a workspace sibling whose packed declarations changed since its latest release, from its commit or its unreleased next, and gives every other sibling its stable range", () => {
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
    const previewed = commitFiles(directory, "fix: y and z", { "packages/interface-y/index.js": "y\n", "packages/interface-z/index.js": "z\n", "packages/interface-z/index.d.ts": "export declare const z: string;\n" });
    const sha = commitFiles(directory, "feat: x", { "packages/interface-x/index.js": "x\n", "packages/interface-x/index.d.ts": "export declare const x: number;\n", "packages/x/index.js": "x\n" });
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
        ["@antelopejs/interface-z@0.2.1-next.2.g1111111 version", "0.2.1-next.2.g1111111"],
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
    const pins = {
      "@antelopejs/interface-x": { preview: `0.10.1-${suffix}`, latest: "0.10.0", directory: "packages/interface-x" },
      "@antelopejs/interface-z": { preview: "0.2.1-next.2.g1111111", latest: "0.2.0", directory: "packages/interface-z" },
    };
    assert.equal(resolved.outputs, `pins=${JSON.stringify(pins)}\nversion=0.12.2-${suffix}\n`);
    const installed = spawnSync("pnpm", ["install", "--offline", "--no-frozen-lockfile", "--silent"], { cwd: directory, encoding: "utf8" });
    assert.equal(installed.status, 0, installed.stderr);
    const stable = join(root, "release-siblings-stable");
    const tarballs = Object.entries({
      "@antelopejs/interface-x@0.10.0": "export declare const x: string;\n",
      "@antelopejs/interface-z@0.2.0": "export declare const z: string;\n",
    }).map(([spec, declaration]) => {
      const [name = "", version = ""] = spec.split(/(?!^)@/);
      const source = join(stable, spec);
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "package.json"), manifest(name, version));
      writeFileSync(join(source, "index.d.ts"), declaration);
      const pack = spawnSync(realNpm, ["pack", "--silent", "--pack-destination", stable], { cwd: source, encoding: "utf8" });
      assert.equal(pack.status, 0, pack.stderr);
      return [spec, join(stable, pack.stdout.trim())];
    });
    writeFileSync(join(stable, "tarballs.tsv"), tarballs.map((row) => row.join("\t")).join("\n") + "\n");
    const packing = join(root, "release-siblings-npm", "bin");
    mkdirSync(packing, { recursive: true });
    symlinkSync(join(dirname(realNpm), "..", "node_modules"), join(packing, "..", "node_modules"));
    writeFileSync(
      join(packing, "npm"),
      `#!/bin/sh\nif [ "$1" = pack ] && [ "$3" = --pack-destination ]; then tarball=$(awk -F '\\t' -v key="$2" '$1 == key { print $2 }' "${join(stable, "tarballs.tsv")}"); [ -n "$tarball" ] || { echo "npm error code E404" >&2; exit 1; }; cp "$tarball" "$4"; exit 0; fi\nif [ "$1" = view ]; then exec '${join(registry, "npm")}' "$@"; fi\nexec '${join(recordingNpm, "npm")}' "$@"\n`,
    );
    chmodSync(join(packing, "npm"), 0o755);
    const publish = (pinned: JsonObject, env: Record<string, string> = {}) =>
      publishPreview(text, join(directory, "packages", "x"), `0.12.2-${suffix}`, { PATH: `${packing}:${recordingNpm}:${process.env.PATH ?? ""}`, PINS: JSON.stringify(pinned), FAKE_VIEWS: views, ...env });
    const missing = publish(pins);
    assert.deepEqual([missing.status, missing.publication], [1, null]);
    assert.match(missing.stderr, new RegExp(`@antelopejs/interface-x@0\\.10\\.1-${suffix} is not on the registry\\. Dispatch the preview of packages/interface-x first`));
    const unreachable = publish(pins, { FAKE_DOWN: `@antelopejs/interface-x@0.10.1-${suffix} version` });
    assert.deepEqual([unreachable.status, unreachable.publication, /Dispatch/.test(unreachable.stderr)], [1, null, false]);
    assert.match(unreachable.stderr, new RegExp(`^npm view @antelopejs/interface-x@0\\.10\\.1-${suffix} version failed: npm error code E500$`, "m"));
    writeFileSync(views, `${readText(views)}@antelopejs/interface-x@0.10.1-${suffix} version\t0.10.1-${suffix}\n`);
    const preview = publish(pins);
    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(preview.publication?.manifest, {
      name: "@antelopejs/x",
      version: `0.12.2-${suffix}`,
      dependencies: { "@antelopejs/interface-x": `0.10.1-${suffix}`, "@antelopejs/interface-y": "^0.4.0", "@antelopejs/interface-z": "^0.2.0" },
      gitHead: sha,
    });
    git(directory, "checkout", "--", "packages/x/package.json");
    const unreleased = publish({ "@antelopejs/interface-z": { ...pins["@antelopejs/interface-z"], latest: "" } });
    assert.equal(unreleased.status, 0, unreleased.stderr);
    assert.deepEqual(unreleased.publication?.manifest, {
      name: "@antelopejs/x",
      version: `0.12.2-${suffix}`,
      dependencies: { "@antelopejs/interface-x": "^0.10.0", "@antelopejs/interface-y": "^0.4.0", "@antelopejs/interface-z": "0.2.1-next.2.g1111111" },
      gitHead: sha,
    });
  });
});

describe("release-npm.yml", () => {
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
    assert.deepEqual(readText(installed).trimEnd().split("\n"), ["install", "--no-save", "--no-audit", "--no-fund", "--prefix", join(root, "pkg-pr-new"), "pkg-pr-new@0.0.94"]);

    const bin = join(root, "pkg-pr-new", "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pkg-pr-new"), '#!/bin/sh\nprintf \'%s\\n\' "$PWD" "$@" > "$PKG_PR_NEW_LOG"\n');
    chmodSync(join(bin, "pkg-pr-new"), 0o755);
    const manifest = { name: "@antelopejs/x", version: "0.4.2", dependencies: { "@antelopejs/interface-x": "workspace:^", "@antelopejs/b": "catalog:" } };
    const { directory } = repository(`release-pkg-pr-new`, { "package.json": `${JSON.stringify(manifest)}\n` });
    const log = join(root, "pkg-pr-new-publish.log");
    const version = "0.0.0-pr.12.3.gabc1234";
    const published = runStep(text, "Publish to pkg.pr.new", directory, { VERSION: version, PKG_PR_NEW_LOG: log });
    assert.equal(published.status, 0, published.stderr);
    const [cwd = "", ...args] = readText(log).trimEnd().split("\n");
    assert.equal(realpathSync(cwd), realpathSync(directory));
    assert.deepEqual(args, ["publish", "--pnpm", "--comment=update", "."]);
    assert.deepEqual(parseObject(readText(join(directory, "package.json"))), { ...manifest, version });
  });

  test("a public pull request preview of a workspace publishes every released package of it to pkg.pr.new in one call, from the job of the first released directory, since pkg.pr.new takes one publish per workflow run", () => {
    const bin = join(root, "pkg-pr-new", "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "pkg-pr-new"), '#!/bin/sh\nprintf \'%s\\n\' "$PWD" "$@" > "$PKG_PR_NEW_LOG"\n');
    chmodSync(join(bin, "pkg-pr-new"), 0o755);
    const manifest = (name: string, dependencies: Record<string, string> = {}) => `${JSON.stringify({ name, version: "0.1.0", dependencies })}\n`;
    const { directory } = repository(`release-pkg-pr-new-workspace`, {
      "package.json": JSON.stringify({ name: "workspace", private: true }),
      "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "packages/dms/package.json": manifest("@antelopejs/dms", { "@antelopejs/interface-dms": "workspace:^" }),
      "packages/a-internal/package.json": JSON.stringify({ name: "@antelopejs/a-internal", version: "0.1.0", private: true }),
      "packages/a-internal/.release-it.json": "{}\n",
      "packages/dms/.release-it.json": "{}\n",
      "packages/dms/playground/package.json": manifest("playground"),
      "packages/interface-dms/package.json": manifest("@antelopejs/interface-dms"),
      "packages/interface-dms/.release-it.json": "{}\n",
      "packages/interface-dms-builder/package.json": manifest("@antelopejs/interface-dms-builder"),
      "packages/interface-dms-builder/.release-it.json": "{}\n",
    });
    const version = "0.0.0-pr.12.3.gabc1234";
    const publish = (member: string) => {
      const log = join(root, `pkg-pr-new-${member.replaceAll("/", "-")}.log`);
      const result = runStep(text, "Publish to pkg.pr.new", join(directory, member), { VERSION: version, PKG_PR_NEW_LOG: log, WORKSPACE_DIRECTORY: "." });
      assert.equal(result.status, 0, result.stderr);
      return { ...result, call: existsSync(log) ? readText(log).trimEnd().split("\n") : null };
    };
    const sibling = publish("packages/interface-dms");
    assert.equal(sibling.call, null);
    assert.match(sibling.stdout, /^::notice::The job of packages\/dms publishes the pkg\.pr\.new previews of every released package of this workspace/m);
    const first = publish("packages/dms");
    assert.deepEqual(first.call?.slice(1), ["publish", "--pnpm", "--comment=update", ".", "../interface-dms", "../interface-dms-builder"]);
    assert.equal(realpathSync(first.call?.[0] ?? ""), realpathSync(join(directory, "packages", "dms")));
    const versions = ["a-internal", "dms", "dms/playground", "interface-dms", "interface-dms-builder"].map((name) => parseObject(readText(join(directory, "packages", name, "package.json")))["version"]);
    assert.deepEqual(versions, ["0.1.0", version, "0.1.0", version, version]);
  });
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parseJson } from "../ci-metrics/json.ts";
import { alignRanges, floorOf, formatMovedRanges, rangesOf } from "./demo-sync-ranges.ts";
import { readText } from "./helpers/read.ts";
import { git, repoFile, repository, root, runStep, write } from "./helpers/workflow.ts";

const workflow = repoFile(".github/workflows/template-demo-sync.yml");
const DESCRIBE = "Describe the sync";
const CHECK = "Check the sync patch";
const PUBLISH = "Open, update or close the pull request, and turn on its auto-merge";
const BRANCH = "antelopejs/demo-sync";
const TARGET = "AntelopeJS/template-dms-adonis";
const SOURCE_SHA = "26f16f3a49051e870fbf6a25df0d68211b08c11d";

const manifest = (dependencies: Record<string, string>, devDependencies: Record<string, string> = {}): string =>
  `${JSON.stringify({ name: "app", dependencies, devDependencies }, null, 2)}\n`;

/** A template-dms-adonis-shaped checkout: its own manifests and a synced demo frontend. */
const template = (): string => repository({
  "package.json": manifest({ vue: "^3.5.46" }, { "@antelopejs/tooling-configs": "^0.10.5" }),
  "demo/package.json": manifest({}, { "@antelopejs/tooling-configs": "^0.10.5" }),
  "demo/frontend-vue/package.json": manifest({ vue: "^3.5.46" }, { "@antelopejs/tooling-configs": "^0.10.5" }),
  "demo/src/index.ts": "export {};\n",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
});

describe("the ranges the sync raises in the template's own manifests", () => {
  test("a range starts at its first version, and a range that names none has no floor", () => {
    assert.deepEqual(floorOf("^0.10.7"), [0, 10, 7]);
    assert.deepEqual(floorOf(">=0.17.1 <0.18.0"), [0, 17, 1]);
    assert.equal(floorOf("workspace:^"), null);
    assert.equal(floorOf("$@antelopejs/interface-dms"), null);
    assert.equal(floorOf("latest"), null);
  });

  test("a range the synced demo declares at a higher version is raised, and one the template holds higher or equal stays", () => {
    const synced = rangesOf(parseJson(manifest({ vue: "^3.5.45", typescript: "^6.0.2" }, { "@antelopejs/tooling-configs": "^0.10.7" })));
    const owned = parseJson(manifest({ vue: "^3.5.46", typescript: "~6.0.2", dotenv: "^17.0.0" }, { "@antelopejs/tooling-configs": "^0.10.5" }));
    const { manifest: raised, moved } = alignRanges(synced, owned, "package.json");
    assert.deepEqual(moved, [{ file: "package.json", name: "@antelopejs/tooling-configs", from: "^0.10.5", to: "^0.10.7" }]);
    assert.deepEqual(raised, parseJson(manifest({ vue: "^3.5.46", typescript: "~6.0.2", dotenv: "^17.0.0" }, { "@antelopejs/tooling-configs": "^0.10.7" })));
    assert.match(formatMovedRanges(moved), /^\| `package\.json` \| `@antelopejs\/tooling-configs` \| `\^0\.10\.5` \| `\^0\.10\.7` \|$/m);
    assert.equal(formatMovedRanges([]), "");
  });

  test("peer ranges and every other field of the manifest stay as they are", () => {
    const synced = rangesOf(parseJson(manifest({ vue: "^3.6.0" })));
    const owned = { name: "app", peerDependencies: { vue: "^3.5.0" }, pnpm: { overrides: { vue: "^3.5.0" } } };
    assert.deepEqual(alignRanges(synced, owned, "package.json"), { manifest: owned, moved: [] });
  });
});

/** What the Describe step left: its `state` output, and the pull request body and patch it wrote. */
interface Described {
  state: string | undefined;
  body: string;
  patch: string;
}

describe("the sync job", () => {
  const describeSync = (dir: string, ranges = ""): Described => {
    const temp = mkdtempSync(join(root, "demo-sync-"));
    write(join(temp, "demo-sync"), { "ranges.md": ranges });
    const step = runStep(workflow, DESCRIBE, dir, { RUNNER_TEMP: temp, SOURCE: "AntelopeJS/template-dms-demo", SOURCE_SHA, BRANCH });
    assert.equal(step.status, 0, step.stderr);
    const read = (file: string): string => (existsSync(join(temp, "demo-sync", file)) ? readText(join(temp, "demo-sync", file)) : "");
    return { state: step.outputs.state, body: read("body.md"), patch: read("sync.patch") };
  };

  test("a demo/ that already matches is current and proposes nothing", () => {
    assert.equal(describeSync(template()).state, "current");
  });

  test("a synced change becomes a patch of demo/, package.json and pnpm-lock.yaml with the source commit in its body", () => {
    const dir = template();
    write(dir, { "demo/src/index.ts": "export const synced = true;\n", "package.json": manifest({ vue: "^3.5.46" }, { "@antelopejs/tooling-configs": "^0.10.7" }), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n# moved\n", "notes.txt": "not synced\n" });
    const result = describeSync(dir, "| `package.json` | `@antelopejs/tooling-configs` | `^0.10.5` | `^0.10.7` |\n");
    assert.equal(result.state, "changed");
    assert.match(result.body, /^Syncs `demo\/` with \[AntelopeJS\/template-dms-demo@26f16f3\]\(https:\/\/github\.com\/AntelopeJS\/template-dms-demo\/commit\/26f16f3a49051e870fbf6a25df0d68211b08c11d\)/);
    assert.match(result.body, /raised them there too/);
    assert.match(result.body, /updated `pnpm-lock\.yaml` too/);
    assert.match(result.patch, /^diff --git a\/demo\/src\/index\.ts/m);
    assert.match(result.patch, /^diff --git a\/package\.json/m);
    assert.doesNotMatch(result.patch, /notes\.txt/);
  });

  test("a branch that already holds the same tree is proposed", () => {
    const dir = template();
    write(dir, { "demo/src/index.ts": "export const synced = true;\n" });
    git(dir, "checkout", "-q", "-b", "sync");
    git(dir, "commit", "-qam", "sync");
    git(dir, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
    git(dir, "checkout", "-q", "main");
    write(dir, { "demo/src/index.ts": "export const synced = true;\n" });
    assert.equal(describeSync(dir).state, "proposed");
  });
});

describe("the sync patch check", () => {
  const checkPatch = (dir: string, change: () => void) => {
    change();
    git(dir, "add", "-A");
    const patch = spawnSync("git", ["diff", "--cached", "--binary"], { cwd: dir, encoding: "utf8" }).stdout;
    git(dir, "reset", "-q", "--hard");
    const temp = mkdtempSync(join(root, "demo-check-"));
    write(join(temp, "demo-sync"), { "sync.patch": patch });
    return runStep(workflow, CHECK, dir, { RUNNER_TEMP: temp });
  };

  test("accepts demo/, package.json and pnpm-lock.yaml", () => {
    const dir = template();
    const check = checkPatch(dir, () => write(dir, { "demo/content/home.md": "# Helio\n", "package.json": manifest({ vue: "^3.6.0" }), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n# moved\n" }));
    assert.equal(check.status, 0, check.stdout);
  });

  test("refuses a path outside them, and a symlink inside demo/", () => {
    const outside = template();
    const workflowChange = checkPatch(outside, () => write(outside, { ".github/workflows/ci.yml": "on: push\n" }));
    assert.notEqual(workflowChange.status, 0);
    assert.match(workflowChange.stdout, /::error::The sync patch changes \.github\/workflows\/ci\.yml, outside demo\/, package\.json and pnpm-lock\.yaml/);
    const linked = template();
    const link = checkPatch(linked, () => {
      mkdirSync(join(linked, "demo", "content"), { recursive: true });
      symlinkSync("/etc/passwd", join(linked, "demo", "content", "link"));
    });
    assert.notEqual(link.status, 0);
    assert.match(link.stdout, /::error::The sync patch makes demo\/content\/link a symlink or a submodule/);
  });
});

describe("the pull request", () => {
  const QUEUED = { mergeQueue: { id: "MQ_1" }, pullRequest: { autoMergeRequest: null, isInMergeQueue: false } };
  const OPEN = JSON.stringify([{ number: 12, isCrossRepository: false }]);

  const publish = (env: { state?: string; open?: string; repo?: object }): string[] => {
    const temp = mkdtempSync(join(root, "demo-publish-"));
    write(join(temp, "demo-sync"), { "body.md": "body\n" });
    const log = join(temp, "gh.log");
    const step = runStep(workflow, PUBLISH, root, {
      RUNNER_TEMP: temp,
      GH_LOG: log,
      GITHUB_REPOSITORY: TARGET,
      TARGET,
      SOURCE: "AntelopeJS/template-dms-demo",
      SOURCE_SHA,
      BRANCH,
      TITLE: "chore(demo): sync demo/ with template-dms-demo",
      RUN_URL: "https://example.com/run",
      STATE: env.state ?? "changed",
      GH_OPEN: env.open ?? "[]",
      GH_GRAPHQL: JSON.stringify({ data: { repository: env.repo ?? QUEUED } }),
    });
    assert.equal(step.status, 0, step.stderr);
    return existsSync(log) ? readText(log).trimEnd().split("\n") : [];
  };

  test("opens it on template-dms-adonis and turns on its squash auto-merge", () => {
    const calls = publish({});
    assert.ok(calls.some((call) => call.startsWith(`gh pr create -R ${TARGET} --base main --head ${BRANCH} --title chore(demo): sync demo/ with template-dms-demo`)), calls.join("\n"));
    assert.deepEqual(calls.filter((call) => call.startsWith("gh pr merge")), [`gh pr merge -R ${TARGET} 7 --squash --auto`]);
  });

  test("updates the open one, and leaves one alone that already has auto-merge", () => {
    const calls = publish({ open: OPEN, state: "proposed", repo: { ...QUEUED, pullRequest: { autoMergeRequest: { enabledAt: "now" }, isInMergeQueue: false } } });
    assert.ok(calls.some((call) => call.startsWith(`gh pr edit -R ${TARGET} 12 --body-file`)), calls.join("\n"));
    assert.ok(!calls.some((call) => call.startsWith("gh pr create") || call.startsWith("gh pr merge")), calls.join("\n"));
  });

  test("closes the open one once demo/ on main matches", () => {
    const calls = publish({ open: OPEN, state: "current" });
    assert.ok(calls.some((call) => call.startsWith(`gh pr close -R ${TARGET} 12 --delete-branch`)), calls.join("\n"));
    assert.ok(!calls.some((call) => call.startsWith("gh pr create") || call.startsWith("gh pr edit") || call.startsWith("gh pr merge")), calls.join("\n"));
  });
});

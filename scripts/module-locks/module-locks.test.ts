import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readText } from "./helpers/read.ts";
import { nextRun, repoFile, repository, root, runStep, runs, git, write, type StepResult } from "./helpers/workflow.ts";
import { SYNC_PATH, syncRepository } from "./helpers/sync.ts";

const refresh = repoFile(".github/workflows/module-locks-refresh.yml");
const renovate = repoFile(".github/workflows/module-locks-renovate.yml");
const committed = repoFile(".github/actions/module-locks-committed/action.yml");
const ciNode = repoFile(".github/workflows/ci-node.yml");

const UPDATE = "Run ajs project modules update --fix in each project, a second time when the first run fails, until a core release carries AntelopeJS/antelopejs#535";
const DESCRIBE = "Describe the refresh";
const FIND = "Find the module locks the job wrote";
const FAIL = "Fail on the module locks the job wrote";
const PRUNE = "Delete the locks of the versions the bump replaces";
const COPY = "Copy the recorded locks into the checkout";
const COMMIT = "Commit the locks";
const LOCK_COMMIT = "build(deps): record the module locks of the bumped modules";
const BRANCH = "antelopejs/module-locks";
const CHECK = "Check the refresh patch";
const PUBLISH = "Open, update or close the pull request, and turn on its auto-merge";
const REFRESH_SYNC = "Run the repository's sync script, so the files antelopejs-sync writes follow the refreshed ranges";

const lock = (folder: string, module: string, content = "lockfileVersion: '9.0'\n") => ({
  [`${folder}/${module}/pnpm-lock.yaml`]: content,
});

function installAjs(dir: string, script: string): string {
  const log = join(dir, "node_modules", "ajs.log");
  write(dir, { "node_modules/.bin/ajs": `#!/usr/bin/env bash\necho "$*" >> "${log}"\n${script}\n` });
  chmodSync(join(dir, "node_modules/.bin/ajs"), 0o755);
  return log;
}

function refreshRun(dir: string, projects: string) {
  const update = runStep(refresh, UPDATE, dir, { PROJECTS: projects });
  const describe = runStep(refresh, DESCRIBE, dir, { GH_TOKEN: "unused", BRANCH });
  const body = join(root, `runner-${runs}`, "module-locks", "body.md");
  return { update, describe, body: existsSync(body) ? readText(body) : "" };
}

function refreshPatchChecks(): void {
  const checkPatch = (dir: string, patch: string): StepResult => {
    const temp = join(root, `patch-${nextRun()}`);
    mkdirSync(join(temp, "module-locks"), { recursive: true });
    writeFileSync(join(temp, "module-locks", "refresh.patch"), patch);
    return runStep(refresh, CHECK, dir, { RUNNER_TEMP: temp });
  };
  const staged = (dir: string, change: () => void): string => {
    change();
    git(dir, "add", "-A");
    const patch = spawnSync("git", ["diff", "--cached", "--binary"], { cwd: dir, encoding: "utf8" }).stdout;
    git(dir, "reset", "-q", "--hard");
    return patch;
  };
  const base = (): string => repository({ ...lock("antelope-lock", "@antelopejs/api@1.0.0"), "package.json": '{"name":"app"}\n', "antelope.config.ts": "export default {};\n" });

  test("passes a refresh that moves locks, ranges and other files, and leaves the checkout alone", () => {
    const dir = base();
    const patch = staged(dir, () => {
      rmSync(join(dir, "antelope-lock"), { recursive: true });
      write(dir, { ...lock("antelope-lock", "@antelopejs/api@1.1.0"), "package.json": '{"name":"app","version":"1"}\n', "antelope.config.ts": "export default { a: 1 };\n", "pnpm-lock.yaml": "x\n" });
    });
    const check = checkPatch(dir, patch);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.equal(git(dir, "status", "--porcelain"), "");
  });

  const refused: [string, (dir: string) => void, RegExp][] = [
    ["a workflow", (dir) => write(dir, { ".github/workflows/x.yml": "on: push\n" }), /\.github\/workflows\/x\.yml, which is under \.github/],
    ["a symlink", (dir) => symlinkSync("/etc/passwd", join(dir, "antelope-lock", "link")), /antelope-lock\/link, which is a symlink/],
    [
      "a submodule",
      (dir) => {
        mkdirSync(join(dir, "vendor", "x"), { recursive: true });
        git(join(dir, "vendor", "x"), "init", "-q");
        git(join(dir, "vendor", "x"), "commit", "-q", "--allow-empty", "-m", "x");
      },
      /vendor\/x, which is a submodule/,
    ],
    ["a .gitmodules", (dir) => write(dir, { ".gitmodules": "[submodule \"x\"]\n" }), /\.gitmodules, which is under \.github or declares submodules/],
  ];
  for (const [name, change, message] of refused) {
    test(`refuses ${name}`, () => {
      const dir = base();
      const check = checkPatch(dir, staged(dir, () => change(dir)));
      assert.notEqual(check.status, 0);
      assert.match(check.stdout, message);
      assert.match(check.stdout, /Nothing was pushed/);
    });
  }

  for (const [name, path] of [["a path outside the checkout", "../outside"], ["a path under .git", ".git/hooks/post-checkout"]]) {
    test(`refuses ${name}`, () => {
      const dir = base();
      const check = checkPatch(dir, `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`);
      assert.notEqual(check.status, 0);
      assert.match(check.stdout, /::error::The refresh patch does not apply/);
      assert.equal(existsSync(join(dir, path)), false);
    });
  }
}

function pullRequestPublishing(): void {
  const QUEUED = { mergeQueue: { id: "MQ_1" }, pullRequest: { autoMergeRequest: null, isInMergeQueue: false } };
  const OPEN = JSON.stringify([{ number: 5, isCrossRepository: false }]);

  function publish(env: { repository?: string; state?: string; open?: string; repo?: object }): string[] {
    const temp = mkdtempSync(join(root, "publish-"));
    write(join(temp, "module-locks"), { "body.md": "body\n" });
    const log = join(temp, "gh.log");
    const step = runStep(refresh, PUBLISH, root, {
      RUNNER_TEMP: temp,
      GH_LOG: log,
      GITHUB_REPOSITORY: env.repository ?? "AntelopeJS/api",
      BASE: "main",
      BRANCH,
      TITLE: "build(deps): update the AntelopeJS module locks",
      RUN_URL: "https://example.com/run",
      STATE: env.state ?? "changed",
      GH_OPEN: env.open ?? "[]",
      GH_GRAPHQL: JSON.stringify({ data: { repository: env.repo ?? QUEUED } }),
    });
    assert.equal(step.status, 0, step.stderr);
    return existsSync(log) ? readText(log).trimEnd().split("\n") : [];
  }
  const merges = (calls: string[]): string[] => calls.filter((call) => call.startsWith("gh pr merge"));

  test("turns on squash auto-merge on a new pull request when the default branch has a merge queue", () => {
    const calls = publish({});
    assert.ok(calls.some((call) => call.startsWith("gh pr create")));
    assert.deepEqual(merges(calls), ["gh pr merge -R AntelopeJS/api 7 --squash --auto"]);
  });

  test("turns on auto-merge on the open pull request it updates", () => {
    assert.deepEqual(merges(publish({ open: OPEN, state: "proposed" })), ["gh pr merge -R AntelopeJS/api 5 --squash --auto"]);
  });

  test("leaves a pull request alone that already has auto-merge or sits in the queue", () => {
    assert.deepEqual(merges(publish({ open: OPEN, repo: { ...QUEUED, pullRequest: { autoMergeRequest: { enabledAt: "now" }, isInMergeQueue: false } } })), []);
    assert.deepEqual(merges(publish({ open: OPEN, repo: { ...QUEUED, pullRequest: { autoMergeRequest: null, isInMergeQueue: true } } })), []);
  });

  test("never turns on auto-merge when the default branch has no merge queue", () => {
    assert.deepEqual(merges(publish({ repo: { ...QUEUED, mergeQueue: null } })), []);
  });

  test("never turns on auto-merge in the repositories the Renovate preset leaves to a person, even with a merge queue", () => {
    const manual = [...repoFile("renovate.json5").matchAll(/'!(AntelopeJS\/[\w.-]+)'/g)].map((match) => match[1]);
    assert.equal(manual.length, 5);
    for (const repository of manual) {
      assert.deepEqual(merges(publish({ repository })), [], repository);
    }
  });

  test("closes the pull request when nothing changed, and turns on no auto-merge", () => {
    const calls = publish({ open: OPEN, state: "current" });
    assert.ok(calls.some((call) => call.startsWith("gh pr close -R AntelopeJS/api 5 --delete-branch")));
    assert.deepEqual(merges(calls), []);
  });
}

describe("module-locks-refresh.yml", () => {
  test("proposes a module whose lock moved to a newer version", () => {
    const dir = repository({ ...lock("antelope-lock", "@antelopejs/api@1.0.0"), ...lock("antelope-lock", "@antelopejs/mongodb@2.0.0") });
    const log = installAjs(dir, "rm -r antelope-lock/@antelopejs/api@1.0.0\nmkdir -p antelope-lock/@antelopejs/api@1.1.0\necho new > antelope-lock/@antelopejs/api@1.1.0/pnpm-lock.yaml");

    const { update, describe, body } = refreshRun(dir, ".");

    assert.equal(update.status, 0, update.stderr);
    assert.equal(readText(log), "project modules update --fix -p .\n");
    assert.equal(describe.status, 0, describe.stderr);
    assert.equal(describe.outputs.state, "changed");
    assert.match(body, /^\| `antelope-lock` \| `@antelopejs\/api` \| `1\.0\.0` \| `1\.1\.0` \|$/m);
    assert.doesNotMatch(body, /mongodb/);
    assert.ok(readText(join(root, `runner-${runs}`, "module-locks", "refresh.patch")).includes("api@1.1.0/pnpm-lock.yaml"));
  });

  test("runs the update a second time when the first run fails, and fails when both do", () => {
    const dir = repository(lock("antelope-lock", "@antelopejs/api@1.0.0"));
    const log = installAjs(dir, `if [ ! -e "${join(dir, "node_modules", "failed")}" ]; then touch "${join(dir, "node_modules", "failed")}"; exit 1; fi`);

    assert.equal(runStep(refresh, UPDATE, dir, { PROJECTS: "." }).status, 0);
    assert.equal(readText(log).split("\n").filter(Boolean).length, 2);

    installAjs(dir, "exit 1");
    assert.notEqual(runStep(refresh, UPDATE, dir, { PROJECTS: "." }).status, 0);
  });

  test("refreshes a project in a subfolder with the ajs of a folder above it, and lists a lock resolved again", () => {
    const dir = repository({ "packages/app/antelope.config.ts": "export default {};\n", ...lock("packages/app/antelope-lock", "@antelopejs/auth-jwt@1.1.0") });
    const log = installAjs(dir, "echo again > packages/app/antelope-lock/@antelopejs/auth-jwt@1.1.0/pnpm-lock.yaml");

    const { update, describe, body } = refreshRun(dir, "packages/app\n");

    assert.equal(update.status, 0, update.stderr);
    assert.equal(readText(log), "project modules update --fix -p packages/app\n");
    assert.equal(describe.outputs.state, "changed");
    assert.match(body, /^- `packages\/app\/antelope-lock\/@antelopejs\/auth-jwt@1\.1\.0`$/m);
    assert.doesNotMatch(body, /\| Lock folder \|/);
  });

  test("shows a range the update moved", () => {
    const dir = repository({ "antelope.config.ts": 'version: "^1.0.0"\n', ...lock("antelope-lock", "@antelopejs/api@1.0.0") });
    installAjs(dir, 'echo \'version: "^2.0.0"\' > antelope.config.ts\nrm -r antelope-lock/@antelopejs/api@1.0.0\nmkdir antelope-lock/@antelopejs/api@2.0.0\necho new > antelope-lock/@antelopejs/api@2.0.0/pnpm-lock.yaml');

    const { body } = refreshRun(dir, ".");

    assert.match(body, /A release outside a range moved these ranges/);
    assert.match(body, /^\+version: "\^2\.0\.0"$/m);
  });

  test("reports current when nothing changed", () => {
    const dir = repository(lock("antelope-lock", "@antelopejs/api@1.0.0"));
    installAjs(dir, "true");

    const { describe, body } = refreshRun(dir, ".");

    assert.equal(describe.status, 0, describe.stderr);
    assert.equal(describe.outputs.state, "current");
    assert.equal(body, "");
  });

  test("reports proposed when the branch already holds the same refresh", () => {
    const dir = repository(lock("antelope-lock", "@antelopejs/api@1.0.0"));
    installAjs(dir, "echo again > antelope-lock/@antelopejs/api@1.0.0/pnpm-lock.yaml");
    assert.equal(refreshRun(dir, ".").describe.outputs.state, "changed");
    git(dir, "commit", "-qm", "refresh");
    git(dir, "push", "-q", "origin", `HEAD:refs/heads/${BRANCH}`);
    git(dir, "reset", "-q", "--hard", "HEAD~1");

    assert.equal(refreshRun(dir, ".").describe.outputs.state, "proposed");
  });

  test("refreshes every project even when ajs reads its standard input", () => {
    const dir = repository({ "a/antelope.config.ts": "", "b/antelope.config.ts": "" });
    const log = installAjs(dir, "cat > /dev/null");

    assert.equal(runStep(refresh, UPDATE, dir, { PROJECTS: "a\nb\n" }).status, 0);
    assert.equal(readText(log), "project modules update --fix -p a\nproject modules update --fix -p b\n");
  });

  test("proposes the files the repository's sync script writes after the refresh", () => {
    const dir = syncRepository("antelopejs-sync", "README.md");

    const sync = runStep(refresh, REFRESH_SYNC, dir, SYNC_PATH);
    const describe = runStep(refresh, DESCRIBE, dir, { GH_TOKEN: "unused", BRANCH });

    assert.equal(sync.status, 0, sync.stderr);
    assert.equal(describe.outputs.state, "changed");
    assert.match(readText(join(root, `runner-${runs}`, "module-locks", "refresh.patch")), /^\+synced $/m);
  });

  describe("checks the refresh patch before it pushes", refreshPatchChecks);
  describe("opens the pull request and turns on its auto-merge", pullRequestPublishing);

  test("fails with the fix when no folder holds node_modules/.bin/ajs", () => {
    const dir = repository({ "playground/antelope.config.ts": "export default {};\n" });

    const update = runStep(refresh, UPDATE, dir, { PROJECTS: "playground" });

    assert.notEqual(update.status, 0);
    assert.match(update.stdout, /::error::No node_modules\/\.bin\/ajs in playground or a folder above it/);
  });
});

describe("module-locks-committed action", () => {
  test("passes when the job wrote no lock", () => {
    const dir = repository({ ...lock("antelope-lock", "@antelopejs/api@1.0.0"), "src/index.ts": "" });
    write(dir, { "src/index.ts": "changed\n" });

    const find = runStep(committed, FIND, dir);

    assert.equal(find.status, 0, find.stderr);
    assert.equal(find.outputs.recorded, undefined);
  });

  test("fails on a lock the job wrote, and keeps a copy at its path in the repository", () => {
    const dir = repository(lock("packages/m/antelope-lock", "@antelopejs/api@1.0.0"));
    write(dir, lock("packages/m/antelope-lock", "@antelopejs/api@1.1.0", "recorded\n"));

    const find = runStep(committed, FIND, dir);
    const fail = runStep(committed, FAIL, dir, { RUNNER_TEMP: join(root, `runner-${runs}`) });

    assert.equal(find.status, 0, find.stderr);
    assert.equal(find.outputs.recorded, "true");
    assert.equal(readText(join(find.outputs.copy, "packages/m/antelope-lock/@antelopejs/api@1.1.0/pnpm-lock.yaml")), "recorded\n");
    assert.match(find.outputs.name, /^module-locks-/);
    assert.equal(fail.status, 1);
    assert.match(fail.stdout, /packages\/m\/antelope-lock\/@antelopejs\/api@1\.1\.0\//);
    assert.match(fail.stdout, /::error::This job wrote module locks that are not committed/);
  });

  test("ci-node.yml runs it only for a caller that asks, so existing callers keep their checks", () => {
    const input = ciNode.slice(ciNode.indexOf("      module-locks:\n"));
    assert.match(input, /^ {6}module-locks:\n(?: {8}.*\n)*? {8}default: false\n/);
    assert.match(ciNode, /- name: Check that the module locks are committed\n\s+if: \$\{\{ !cancelled\(\) && steps\.leg\.outputs\.work == 'true' && inputs\.module-locks \}\}\n\s+uses: AntelopeJS\/\.github\/\.github\/actions\/module-locks-committed@v2\n/);
  });
});

describe("module-locks-renovate.yml", () => {
  function bump(files: Record<string, string>, bumped: Record<string, string>, recorded: Record<string, string>) {
    const dir = repository(files);
    git(dir, "checkout", "-qb", "renovate/antelopejs-modules");
    write(dir, bumped);
    git(dir, "commit", "-qam", "bump");
    write(dir, recorded);
    return { dir, prune: runStep(renovate, PRUNE, dir, { BASE_REF: "main" }) };
  }

  test("deletes the lock of the version a pin replaced, in the folder of the new lock only", () => {
    const stack = (api: string): string => `package: "@antelopejs/api",\n  version: "${api}",\npackage: "@antelopejs/mongodb",\n  version: "2.0.0",\n`;
    const { dir, prune } = bump(
      {
        "packages/m/src/test/antelope-modules.ts": stack("1.0.0"),
        ...lock("packages/m/antelope-lock", "@antelopejs/api@1.0.0"),
        ...lock("packages/m/antelope-lock", "@antelopejs/mongodb@2.0.0"),
        ...lock("antelope-lock", "@antelopejs/api@1.0.0"),
      },
      { "packages/m/src/test/antelope-modules.ts": stack("1.1.0") },
      lock("packages/m/antelope-lock", "@antelopejs/api@1.1.0"),
    );

    assert.equal(prune.status, 0, prune.stderr);
    assert.match(prune.stdout, /Deleted packages\/m\/antelope-lock\/@antelopejs\/api@1\.0\.0: the bump replaces 1\.0\.0\./);
    assert.equal(
      git(dir, "status", "--porcelain", "--untracked-files=all"),
      ["D  packages/m/antelope-lock/@antelopejs/api@1.0.0/pnpm-lock.yaml", "?? packages/m/antelope-lock/@antelopejs/api@1.1.0/pnpm-lock.yaml"].join("\n"),
    );
  });

  test("keeps a lock whose version the diff only mentions inside a longer version", () => {
    const { dir, prune } = bump(
      { "antelope.test.ts": 'package: "@antelopejs/api",\n  version: "11.0.0",\n', ...lock("antelope-lock", "@antelopejs/api@1.0.0") },
      { "antelope.test.ts": 'package: "@antelopejs/api",\n  version: "11.1.0",\n' },
      lock("antelope-lock", "@antelopejs/api@11.1.0"),
    );

    assert.equal(prune.status, 0, prune.stderr);
    assert.equal(git(dir, "status", "--porcelain", "--untracked-files=all"), "?? antelope-lock/@antelopejs/api@11.1.0/pnpm-lock.yaml");
  });

  test("copies only module lock files from the artifacts, and refuses anything else", () => {
    const dir = repository(lock("antelope-lock", "@antelopejs/api@1.0.0"));
    const artifacts = (files: Record<string, string>) => {
      const temp = mkdtempSync(join(root, "artifacts-"));
      write(join(temp, "module-locks-artifacts"), files);
      return { RUNNER_TEMP: temp };
    };

    const copied = runStep(renovate, COPY, dir, artifacts(lock("packages/m/antelope-lock", "@antelopejs/api@1.1.0", "recorded\n")));
    assert.equal(copied.status, 0, copied.stderr);
    assert.equal(readText(join(dir, "packages/m/antelope-lock/@antelopejs/api@1.1.0/pnpm-lock.yaml")), "recorded\n");

    for (const path of [".git/hooks/post-commit", "antelope-lock/.git/hooks/x@1/post-commit", "src/index.ts", "antelope-lock/@antelopejs/api@1.1.0/nested/pnpm-lock.yaml", "antelope-lock/@antelopejs/api@1.1.0/.gitattributes"]) {
      const refused = runStep(renovate, COPY, dir, artifacts({ [path]: "#!/bin/sh\n" }));
      assert.equal(refused.status, 1, path);
      assert.match(refused.stdout, /::error::The module-locks artifacts hold .*, which is not a module lock file/, path);
    }
  });

  test("commits the locks without running git hooks, and stops after two lock commits on the branch", () => {
    const { dir } = bump({ "README.md": "base\n", ...lock("antelope-lock", "@antelopejs/api@1.0.0") }, { "README.md": "bump\n" }, {});
    const author = { AUTHOR: "41898282+github-actions[bot]@users.noreply.github.com", MESSAGE: LOCK_COMMIT, BASE_REF: "main" };
    const record = (version: string): StepResult => {
      write(dir, lock("antelope-lock", `@antelopejs/api@${version}`));
      return runStep(renovate, COMMIT, dir, author);
    };

    write(dir, { ".git/hooks/post-commit": `#!/bin/sh\ntouch "${join(dir, "hook-ran")}"\n` });
    chmodSync(join(dir, ".git/hooks/post-commit"), 0o755);

    for (const version of ["1.1.0", "1.2.0"]) {
      const commit = record(version);
      assert.equal(commit.status, 0, commit.stderr);
      assert.equal(commit.outputs.committed, "true");
    }
    assert.equal(git(dir, "log", "-1", "--format=%an <%ae> %s"), `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com> ${LOCK_COMMIT}`);

    assert.equal(existsSync(join(dir, "hook-ran")), false);
    const head = git(dir, "rev-parse", "HEAD");

    const third = record("1.3.0");
    assert.equal(third.status, 1);
    assert.equal(third.outputs.committed, undefined);
    assert.equal(git(dir, "rev-parse", "HEAD"), head);
    assert.match(third.stdout, /::error::The checks recorded module locks again after 2 lock commits on this branch/);
  });

  test("leaves a lock no removed line names, such as the version a range resolved to", () => {
    const { dir, prune } = bump(
      { "antelope.config.ts": 'package: "@antelopejs/api",\n  version: "^1.0.0",\n', ...lock("antelope-lock", "@antelopejs/api@1.0.3") },
      { "antelope.config.ts": 'package: "@antelopejs/api",\n  version: "^1.1.0",\n' },
      lock("antelope-lock", "@antelopejs/api@1.1.2"),
    );

    assert.equal(prune.status, 0, prune.stderr);
    assert.equal(git(dir, "status", "--porcelain", "--untracked-files=all"), "?? antelope-lock/@antelopejs/api@1.1.2/pnpm-lock.yaml");
  });
});

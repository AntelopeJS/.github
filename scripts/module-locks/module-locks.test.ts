import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";

const repoFile = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
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

const root = mkdtempSync(join(tmpdir(), "module-locks-"));
after(() => rmSync(root, { recursive: true, force: true }));

const GIT_ENV = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const stubs = join(root, "bin");
mkdirSync(stubs);
writeFileSync(join(stubs, "pnpm"), '#!/usr/bin/env bash\necho "pnpm $*" >> "${PNPM_LOG:-/dev/null}"\n');
chmodSync(join(stubs, "pnpm"), 0o755);

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

interface StepResult {
  status: number;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
}

let runs = 0;
function runStep(text: string, step: string, cwd: string, env: Record<string, string> = {}): StepResult {
  runs += 1;
  const temp = join(root, `runner-${runs}`);
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
    readFileSync(output, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, outputs };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

let repos = 0;
function repository(files: Record<string, string>): string {
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

const lock = (folder: string, module: string, content = "lockfileVersion: '9.0'\n"): Record<string, string> => ({
  [`${folder}/${module}/pnpm-lock.yaml`]: content,
});

function installAjs(dir: string, script: string): string {
  const log = join(dir, "node_modules", "ajs.log");
  write(dir, { "node_modules/.bin/ajs": `#!/usr/bin/env bash\necho "$*" >> "${log}"\n${script}\n` });
  chmodSync(join(dir, "node_modules/.bin/ajs"), 0o755);
  return log;
}

function refreshRun(dir: string, projects: string): { update: StepResult; describe: StepResult; body: string } {
  const update = runStep(refresh, UPDATE, dir, { PROJECTS: projects });
  const describe = runStep(refresh, DESCRIBE, dir, { GH_TOKEN: "unused", BRANCH });
  const body = join(root, `runner-${runs}`, "module-locks", "body.md");
  return { update, describe, body: existsSync(body) ? readFileSync(body, "utf8") : "" };
}

describe("module-locks-refresh.yml", () => {
  test("proposes a module whose lock moved to a newer version", () => {
    const dir = repository({ ...lock("antelope-lock", "@antelopejs/api@1.0.0"), ...lock("antelope-lock", "@antelopejs/mongodb@2.0.0") });
    const log = installAjs(dir, "rm -r antelope-lock/@antelopejs/api@1.0.0\nmkdir -p antelope-lock/@antelopejs/api@1.1.0\necho new > antelope-lock/@antelopejs/api@1.1.0/pnpm-lock.yaml");

    const { update, describe, body } = refreshRun(dir, ".");

    assert.equal(update.status, 0, update.stderr);
    assert.equal(readFileSync(log, "utf8"), "project modules update --fix -p .\n");
    assert.equal(describe.status, 0, describe.stderr);
    assert.equal(describe.outputs.state, "changed");
    assert.match(body, /^\| `antelope-lock` \| `@antelopejs\/api` \| `1\.0\.0` \| `1\.1\.0` \|$/m);
    assert.doesNotMatch(body, /mongodb/);
    assert.ok(readFileSync(join(root, `runner-${runs}`, "module-locks", "refresh.patch"), "utf8").includes("api@1.1.0/pnpm-lock.yaml"));
  });

  test("runs the update a second time when the first run fails, and fails when both do", () => {
    const dir = repository(lock("antelope-lock", "@antelopejs/api@1.0.0"));
    const log = installAjs(dir, `if [ ! -e "${join(dir, "node_modules", "failed")}" ]; then touch "${join(dir, "node_modules", "failed")}"; exit 1; fi`);

    assert.equal(runStep(refresh, UPDATE, dir, { PROJECTS: "." }).status, 0);
    assert.equal(readFileSync(log, "utf8").split("\n").filter(Boolean).length, 2);

    installAjs(dir, "exit 1");
    assert.notEqual(runStep(refresh, UPDATE, dir, { PROJECTS: "." }).status, 0);
  });

  test("refreshes a project in a subfolder with the ajs of a folder above it, and lists a lock resolved again", () => {
    const dir = repository({ "packages/app/antelope.config.ts": "export default {};\n", ...lock("packages/app/antelope-lock", "@antelopejs/auth-jwt@1.1.0") });
    const log = installAjs(dir, "echo again > packages/app/antelope-lock/@antelopejs/auth-jwt@1.1.0/pnpm-lock.yaml");

    const { update, describe, body } = refreshRun(dir, "packages/app\n");

    assert.equal(update.status, 0, update.stderr);
    assert.equal(readFileSync(log, "utf8"), "project modules update --fix -p packages/app\n");
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
    assert.equal(readFileSync(log, "utf8"), "project modules update --fix -p a\nproject modules update --fix -p b\n");
  });

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
    assert.equal(readFileSync(join(find.outputs.copy, "packages/m/antelope-lock/@antelopejs/api@1.1.0/pnpm-lock.yaml"), "utf8"), "recorded\n");
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
  function bump(files: Record<string, string>, bumped: Record<string, string>, recorded: Record<string, string>): { dir: string; prune: StepResult } {
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
    const artifacts = (files: Record<string, string>): Record<string, string> => {
      const temp = mkdtempSync(join(root, "artifacts-"));
      write(join(temp, "module-locks-artifacts"), files);
      return { RUNNER_TEMP: temp };
    };

    const copied = runStep(renovate, COPY, dir, artifacts(lock("packages/m/antelope-lock", "@antelopejs/api@1.1.0", "recorded\n")));
    assert.equal(copied.status, 0, copied.stderr);
    assert.equal(readFileSync(join(dir, "packages/m/antelope-lock/@antelopejs/api@1.1.0/pnpm-lock.yaml"), "utf8"), "recorded\n");

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

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";
import type { RunResult, System } from "./system.ts";

const root = mkdtempSync(join(tmpdir(), "release-train-"));
const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

let clock = Date.parse("2026-01-01T00:00:00Z") / 1000;

export function git(repository: string, ...args: string[]): string {
  clock += 1;
  const date = `${clock} +0000`;
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const result = spawnSync("git", ["-C", repository, ...identity, ...args], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function commit(repository: string, message: string, files: Record<string, unknown>, author = "Test"): string {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repository, file)), { recursive: true });
    writeFileSync(join(repository, file), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  git(repository, "add", "--all");
  git(repository, "commit", "--quiet", "--allow-empty", `--author=${author} <test@example.com>`, "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

export function repository(name: string, build: (path: string) => void): string {
  const path = join(root, name);
  mkdirSync(path);
  git(path, "init", "--quiet", "--initial-branch=main");
  git(path, "remote", "add", "origin", `https://github.com/AntelopeJS/${name}.git`);
  build(path);
  git(path, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return path;
}

export function manifest(name: string, version: string, fields: Record<string, Record<string, string>> = {}) {
  return { name: `@antelopejs/${name}`, version, ...fields };
}

export const pulls: Record<string, unknown[]> = {};
export const commits = { cursor: "", feed: "", later: "" };

export const interfaceDatabase = repository("interface-database", (path) => {
  commit(path, "feat: first", { "package.json": manifest("interface-database", "0.4.2", { devDependencies: { "@antelopejs/mongodb": "~1.8.6" } }) });
  git(path, "tag", "v0.4.2");
  commits.cursor = commit(path, "feat(query)!: drop the legacy cursor", { "src/index.ts": "export {};\n" });
  commit(path, "ci: cache the store", { "ci.txt": "x\n" });
  git(path, "branch", "next");
});
export const mongodb = repository("mongodb", (path) => {
  commit(path, "feat: first", { "package.json": manifest("mongodb", "1.8.5") });
  commit(path, "chore(release): v1.8.6", { "package.json": manifest("mongodb", "1.8.6") });
  git(path, "tag", "v1.8.6");
  git(path, "checkout", "--quiet", "-b", "next");
  commits.feed = commit(path, "fix(database): close the change feed", { "src/feed.ts": "export {};\n" });
  commits.later = commit(path, "fix(database): retry the change feed", { "src/retry.ts": "export {};\n" });
  git(path, "checkout", "--quiet", "main");
  const squash = commit(path, "fix(database): close the change feed (#7)", {
    "src/feed.ts": "export {};\n",
    "package.json": manifest("mongodb", "1.8.6", { dependencies: { "@antelopejs/interface-database": `0.4.3-next.12.g${commits.cursor.slice(0, 7)}` } }),
  });
  commit(path, "release: v1.8.7-next.0", { "notes.txt": "x\n" });
  pulls["AntelopeJS/mongodb"] = [{ number: 7, mergeCommit: { oid: squash }, headRefOid: commits.feed }];
});
export const dmsDatabase = repository("dms-database", (path) => {
  commit(path, "feat: first", { "package.json": manifest("dms-database", "0.5.3"), ".release-it.json": { git: { tagName: "release-${version}" } } });
  git(path, "tag", "release-0.5.3");
  git(path, "tag", "v9.9.9");
  commit(path, "chore: pin the mongodb preview", {
    "package.json": manifest("dms-database", "0.5.3", { devDependencies: { "@antelopejs/mongodb": `1.8.7-next.40.g${commits.feed.slice(0, 7)}` } }),
  });
});
export const dms = repository("dms", (path) => {
  commit(path, "feat: first", { "package.json": manifest("dms-root", "1.0.0"), "packages/automation/package.json": manifest("dms-automation", "0.11.1") });
  git(path, "tag", "v0.11.1");
  commit(path, "feat: root only", { "root.txt": "x\n" });
  commit(path, "perf(automation): faster", { "packages/automation/index.ts": "export {};\n" });
});

after(() => rmSync(root, { recursive: true, force: true }));

interface Run {
  id: number;
  repo: string;
  branch: string;
  views: number;
}

function compare(range: string): string {
  const [, owner = "", repo = "", base = "", head = ""] = /^repos\/([^/]+)\/([^/]+)\/compare\/(\w+)\.\.\.(\w+)$/.exec(range) ?? [];
  const ancestor = spawnSync("git", ["-C", join(root, repo), "merge-base", "--is-ancestor", base, head]);
  assert.equal(owner, "AntelopeJS");
  return base === head ? "identical" : ancestor.status === 0 ? "ahead" : "diverged";
}

type View = "fail" | "running";

interface Fakes {
  down?: boolean;
  views?: Record<string, View[]>;
  npm?: Record<string, string>;
  dispatched?: (repo: string, fields: Record<string, string>) => void;
}

export function fakeSystem(conclusions: Record<string, string> = {}, gh: Fakes = {}) {
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const runs: Run[] = [];
  let out = "";
  let err = "";
  const answer = (stdout: string, status = 0): RunResult => ({ status, stdout, stderr: status === 0 ? "" : "failed" });
  const flag = (args: readonly string[], name: string): string => args[args.indexOf(name) + 1] ?? "";
  const system: System = {
    run: (command, args) => {
      if (command === "git") {
        const result = spawnSync("git", args, { encoding: "utf8" });
        return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      }
      calls.push([...args]);
      if (command === "npm") {
        const held = gh.npm?.[args[1] ?? ""];
        if (held === undefined) return { status: 1, stdout: "", stderr: "npm error code E404" };
        return held === "error" ? answer("", 1) : answer(`${held}\n`);
      }
      if (gh.down) return answer("", 1);
      if (args[0] === "pr") return answer(JSON.stringify(pulls[flag(args, "--repo")] ?? []));
      if (args[0] === "api") return answer(`${compare(args[1] ?? "")}\n`);
      const repo = flag(args, "--repo");
      if (args[0] === "workflow") {
        if (conclusions[repo] === "rejected") return answer("", 1);
        if (conclusions[repo] !== "lost") runs.push({ id: 100 + runs.length, repo, branch: flag(args, "--ref"), views: 0 });
        const fields = Object.fromEntries(
          args.filter((_, index) => args[index - 1] === "-f").map((field) => [field.slice(0, field.indexOf("=")), field.slice(field.indexOf("=") + 1)]),
        );
        gh.dispatched?.(repo, fields);
        return answer("");
      }
      if (args[0] === "run" && args[1] === "list") {
        const listed = runs.filter((run) => run.repo === repo).map((run) => ({ databaseId: run.id, headBranch: run.branch }));
        return answer(JSON.stringify(listed));
      }
      const run = runs.find((candidate) => String(candidate.id) === args[2]);
      assert.ok(run, `no run ${args[2]}`);
      const view = gh.views?.[repo]?.shift() ?? (run.views === 0 ? "running" : "done");
      run.views += 1;
      if (view === "fail") return answer("", 1);
      const status = view === "running" ? "in_progress" : "completed";
      const conclusion = status === "completed" ? (conclusions[repo] ?? "success") : "";
      return answer(JSON.stringify({ status, conclusion, url: `https://github.com/${repo}/actions/runs/${run.id}` }));
    },
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
    },
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += `${text}\n`;
    },
    cacheDirectory: join(root, "cache"),
  };
  return { system, calls, sleeps, output: () => out, errors: () => err };
}

function fields(calls: string[][]): string[][] {
  return calls
    .filter((args) => args[0] === "workflow")
    .map((args) => [args[4] ?? "", ...args.filter((_, index) => args[index - 1] === "-f")]);
}

export function dispatches(calls: string[][]): string[][] {
  return fields(calls).map((values) => values.filter((value) => !value.startsWith("release-notes=")));
}

export function releaseNotes(calls: string[][]): Record<string, string> {
  return Object.fromEntries(
    fields(calls).map(([repo = "", ...values]) => [repo, values.find((value) => value.startsWith("release-notes="))?.slice(14) ?? ""]),
  );
}

export function tip(repository: string, branch = "main"): string {
  return git(repository, "rev-parse", branch);
}

export function short(sha: string): string {
  return sha.slice(0, 7);
}

export const expectedPlan = (): string => [
  "Release plan from main, 4 packages: 4 to release",
  "",
  `1. @antelopejs/interface-database 0.4.2 -> 0.5.0 (minor)  AntelopeJS/interface-database@${short(tip(interfaceDatabase))}`,
  "     feat(query)!: drop the legacy cursor",
  `2. @antelopejs/mongodb 1.8.6 -> 1.8.7 (patch)  AntelopeJS/mongodb@${short(tip(mongodb))}`,
  "     fix(database): close the change feed",
  `     @antelopejs/interface-database 0.4.3-next.12.g${short(commits.cursor)} -> >=0.5.0 <0.6.0`,
  `3. @antelopejs/dms-database 0.5.3 -> 0.5.4 (patch)  AntelopeJS/dms-database@${short(tip(dmsDatabase))}`,
  "     replaces preview pins",
  `     @antelopejs/mongodb 1.8.7-next.40.g${short(commits.feed)} -> >=1.8.7 <1.9.0`,
  `4. @antelopejs/dms-automation 0.11.1 -> 0.11.2 (patch)  AntelopeJS/dms:packages/automation@${short(tip(dms))}`,
  "     perf(automation): faster",
  "",
].join("\n");

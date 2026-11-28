import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, repoFile, repository, root, runStep, write } from "./workflow.ts";

const renovateSync = repoFile(".github/workflows/ci-renovate-sync.yml");
const APPLY = "Apply the sync output";
const WORKFLOW = { ".github/workflows/ci.yml": "name: ci\n" };

/** The fields of a package.json these tests write. */
export interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependenciesMeta?: Record<string, { injected: boolean }>;
  packageManager?: string;
  pnpm?: { overrides?: Record<string, string>; packageExtensions?: Record<string, { dependencies: Record<string, string> }>; onlyBuiltDependencies?: string[] };
  scripts?: Record<string, string>;
  workspaces?: string[];
}

export const manifest = (fields: Manifest): string => `${JSON.stringify({ name: "app", ...fields }, undefined, 2)}\n`;
export const lockfile = (packages: readonly string[]): string =>
  `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies: {}\n\npackages:\n\n${packages.map((key) => `  '${key}':\n    resolution: {integrity: sha512-x}\n`).join("\n")}\nsnapshots:\n\n${packages.map((key) => `  '${key}': {}\n`).join("\n")}`;
export const devDependencies = (tooling: string, oxlint = "1.0.0"): Manifest => ({ devDependencies: { "@antelopejs/tooling-configs": tooling, oxlint } });
export const BASE = { "package.json": manifest(devDependencies("0.10.13")), "pnpm-lock.yaml": lockfile(["@antelopejs/tooling-configs@0.10.13", "oxlint@1.0.0"]) };
export const BUMP = { "package.json": manifest(devDependencies("0.10.14")), "pnpm-lock.yaml": lockfile(["@antelopejs/tooling-configs@0.10.14", "oxlint@1.0.0"]) };

let patches = 0;

/** A checkout of a Renovate head whose commit changes `head` over `base`, and the patch of a sync that writes `synced`. */
function pullRequest(head: Record<string, string>, synced: Record<string, string>, base: Record<string, string>) {
  const dir = repository(base);
  git(dir, "checkout", "-qb", "renovate/bump");
  write(dir, head);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "chore(deps): bump");
  write(dir, synced);
  git(dir, "add", "-A");
  patches += 1;
  const patch = join(root, `sync-${patches}.patch`);
  writeFileSync(patch, `${git(dir, "diff", "--cached", "--binary")}\n`);
  git(dir, "reset", "-q", "--hard");
  return { dir, patch };
}

/** Runs the push job's apply step on the Renovate head `head` over `base`, with the sync patch `synced`. */
export function apply(head: Record<string, string>, token = "true", synced: Record<string, string> = WORKFLOW, base: Record<string, string> = BASE) {
  const { dir, patch } = pullRequest(head, synced, base);
  return { dir, result: runStep(renovateSync, APPLY, dir, { APP_TOKEN: token, PATCH: patch, BASE_REF: "main" }) };
}

/** The log of a push job that refused the workflow change of `head`. */
export const refusal = (head: Record<string, string>, base: Record<string, string> = BASE): string => {
  const { result } = apply(head, "true", WORKFLOW, base);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout, /::error::The sync output changes workflow paths; nothing pushed, this pull request stays One-tap\./);
  return result.stdout;
};


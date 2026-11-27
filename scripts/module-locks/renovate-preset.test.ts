import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { readText } from "./helpers/read.ts";

const modules = process.env.RENOVATE_MODULES ?? "";
assert.ok(existsSync(join(modules, "renovate", "package.json")), "RENOVATE_MODULES names the node_modules folder that holds renovate 44 and json5");

/** The options of a renovate 44 config these tests read. Renovate defaults `groupName` and `minimumReleaseAge` to `null`. */
interface Config {
  schedule?: string[];
  timezone?: string;
  rebaseWhen?: string;
  enabled?: boolean;
  automerge?: boolean;
  groupName?: string | null;
  minimumReleaseAge?: string | null;
  packageName?: string;
}
interface CustomManager {
  managerFilePatterns: string[];
  matchStrings: string[];
}
interface Preset extends Config {
  customManagers: CustomManager[];
}
interface Upgrade {
  repository: string;
  manager: string;
  depName: string;
  currentVersion: string;
  updateType: string;
  packageFile: string;
}

const url = (path: string): string => pathToFileURL(join(modules, path)).href;

/** Imports a module of the renovate checkout under the exports type `T` declares. */
async function load<T>(path: string): Promise<T> {
  const imported: unknown = await import(url(path));
  // SAFETY: each call site names the exports of the renovate 44 or json5 module at that path.
  return imported as T;
}

const { default: JSON5 } = await load<{ default: { parse: (text: string) => Preset } }>("json5/lib/index.js");
const { resolveConfigPresets } = await load<{ resolveConfigPresets: (config: Config) => Promise<{ config: Config }> }>("renovate/dist/config/presets/index.js");
const { massageConfig } = await load<{ massageConfig: (config: Config) => Config }>("renovate/dist/config/massage.js");
const { mergeChildConfig } = await load<{ mergeChildConfig: (parent: Config, child: Config) => Config }>("renovate/dist/config/utils.js");
const { getConfig } = await load<{ getConfig: () => Config }>("renovate/dist/config/defaults.js");
const { applyPackageRules } = await load<{ applyPackageRules: (config: Config, stage: string) => Promise<Config> }>("renovate/dist/util/package-rules/index.js");

const preset = JSON5.parse(readText(new URL("../../renovate.json5", import.meta.url)));
const config: Config = massageConfig(mergeChildConfig(getConfig(), (await resolveConfigPresets(preset)).config));

async function lookup(upgrade: Upgrade & { datasource: string }): Promise<string | undefined> {
  const result = await applyPackageRules({ ...config, ...upgrade, packageName: upgrade.depName }, "pre-lookup");
  return result.packageName;
}

async function rules(upgrade: Upgrade): Promise<{ enabled: boolean; groupName?: string; automerge: boolean; minimumReleaseAge?: string }> {
  const result = await applyPackageRules({ ...config, ...upgrade, packageName: upgrade.depName }, "pre-lookup");
  return {
    enabled: result.enabled !== false,
    groupName: result.groupName ?? undefined,
    automerge: result.automerge === true,
    minimumReleaseAge: result.minimumReleaseAge ?? undefined,
  };
}

const testStack = { repository: "AntelopeJS/dms-mailing", manager: "custom.regex", depName: "@antelopejs/dms", currentVersion: "1.2.0", packageFile: "packages/dms-mailing/src/test/antelope-modules.ts" };

test("Renovate runs daily in the Brussels night and rebases a branch only on a conflict", () => {
  assert.deepEqual(config.schedule, ["* 0-3 * * *"]);
  assert.equal(config.timezone, "Europe/Brussels");
  assert.equal(config.rebaseWhen, "conflicted");
});

test("a patch or minor bump of a test stack module merges through the queue in one AntelopeJS modules pull request", async () => {
  assert.deepEqual(await rules({ ...testStack, updateType: "minor" }), { enabled: true, groupName: "AntelopeJS modules", automerge: true, minimumReleaseAge: undefined });
  assert.deepEqual(await rules({ ...testStack, updateType: "patch", repository: "AntelopeJS/template-dms-demo", packageFile: "antelope.config.ts" }), {
    enabled: true,
    groupName: "AntelopeJS modules",
    automerge: true,
    minimumReleaseAge: undefined,
  });
});

test("a major bump stays manual", async () => {
  assert.equal((await rules({ ...testStack, updateType: "major" })).automerge, false);
  assert.equal((await rules({ repository: "AntelopeJS/dms-media", manager: "npm", depName: "vue", currentVersion: "3.4.0", updateType: "major", packageFile: "package.json" })).automerge, false);
});

test("a third-party 0.x minor stays manual, while a 0.x patch and a minor from 1.x on merge on their own", async () => {
  const action = { repository: "AntelopeJS/dms-media", manager: "github-actions", depName: "pnpm/action-setup", packageFile: ".github/workflows/ci.yml" };
  const vue = { repository: "AntelopeJS/dms-media", manager: "npm", depName: "vue", packageFile: "package.json" };
  for (const currentVersion of ["0.4.0", "0.0.3"]) {
    assert.equal((await rules({ ...vue, currentVersion, updateType: "minor" })).automerge, false, currentVersion);
    assert.equal((await rules({ ...vue, currentVersion, updateType: "patch" })).automerge, true, currentVersion);
  }
  assert.equal((await rules({ ...action, currentVersion: "v0.4.0", updateType: "minor" })).automerge, false);
  for (const currentVersion of ["1.0.0", "10.2.0"]) assert.equal((await rules({ ...vue, currentVersion, updateType: "minor" })).automerge, true, currentVersion);
  assert.equal((await rules({ ...action, currentVersion: "v4.1.0", updateType: "minor" })).automerge, true);
});

test("a 0.x minor of an AntelopeJS package or of the tooling configs group merges on its own", async () => {
  assert.equal((await rules({ ...testStack, currentVersion: "0.4.0", updateType: "minor" })).automerge, true);
  const npm = { repository: "AntelopeJS/interface-core", manager: "npm", currentVersion: "0.10.6", updateType: "minor", packageFile: "package.json" };
  assert.deepEqual(await rules({ ...npm, depName: "@antelopejs/interface-dms" }), { enabled: true, groupName: undefined, automerge: true, minimumReleaseAge: undefined });
  for (const depName of ["@antelopejs/tooling-configs", "oxfmt", "oxlint", "@oxlint/plugins"]) {
    assert.equal((await rules({ ...npm, depName })).groupName, "AntelopeJS tooling configs", depName);
    assert.equal((await rules({ ...npm, depName })).automerge, true, depName);
  }
  const docsAction = { repository: "AntelopeJS/interface-core", manager: "github-actions", depName: "AntelopeJS/tooling-configs", currentVersion: "v0.10.6", updateType: "minor", packageFile: ".github/workflows/ci.yml" };
  assert.deepEqual(await rules(docsAction), { enabled: true, groupName: "AntelopeJS tooling configs", automerge: true, minimumReleaseAge: undefined });
});

test("a repository without a merge queue never merges on its own", async () => {
  for (const repository of ["AntelopeJS/cloud", "AntelopeJS/k8s-gitops-infra", "AntelopeJS/antelope-hardening", "AntelopeJS/antelope-compliance"]) {
    assert.equal((await rules({ ...testStack, repository, updateType: "patch", packageFile: "antelope.config.ts" })).automerge, false, repository);
    assert.equal((await rules({ repository, manager: "npm", depName: "vue", currentVersion: "3.4.0", updateType: "minor", packageFile: "package.json" })).automerge, false, repository);
  }
});

test("a third-party release waits three days before it can merge on its own", async () => {
  const vue = { repository: "AntelopeJS/dms-media", manager: "npm", depName: "vue", currentVersion: "3.4.0", packageFile: "package.json" };
  assert.deepEqual(await rules({ ...vue, updateType: "minor" }), { enabled: true, groupName: undefined, automerge: true, minimumReleaseAge: "3 days" });
  assert.equal((await rules({ ...vue, updateType: "major" })).minimumReleaseAge, undefined);
  assert.equal((await rules({ ...vue, updateType: "pin" })).minimumReleaseAge, undefined);
  assert.equal((await rules({ ...vue, depName: "@antelopejs/interface-dms", updateType: "patch" })).minimumReleaseAge, undefined);
});

test("only the module managers read **/test/**", async () => {
  assert.equal((await rules({ ...testStack, updateType: "patch" })).enabled, true);
  assert.equal((await rules({ repository: "AntelopeJS/dms-media", manager: "npm", depName: "vue", currentVersion: "3.4.0", updateType: "minor", packageFile: "packages/dms-media/src/test/fixture/package.json" })).enabled, false);
});

test("the custom managers read every shape a project or a test stack pins a module in", () => {
  const managers = preset.customManagers.map((manager) => ({
    files: manager.managerFilePatterns.map((pattern) => new RegExp(pattern.slice(1, -1))),
    match: new RegExp(manager.matchStrings[0], "g"),
  }));
  const pins = (file: string, text: string): string[] =>
    managers.filter(({ files }) => files.some((pattern) => pattern.test(file))).flatMap(({ match }) => Array.from(text.matchAll(match), (found) => `${found.groups?.depName}@${found.groups?.currentValue}`));

  assert.deepEqual(pins("antelope.config.ts", 'source: {\n  type: "package",\n  package: "@antelopejs/dms",\n  version: ">=0.21.3 <0.22.0",\n}'), ["@antelopejs/dms@>=0.21.3 <0.22.0"]);
  assert.deepEqual(pins("e2e/playground/antelope.config.ts", "package: '@antelopejs/api', version: '^1.7.5'"), ["@antelopejs/api@^1.7.5"]);
  assert.deepEqual(pins("src/test/antelope.test.ts", 'package: "@antelopejs/api",\n        version: "1.7.3",'), ["@antelopejs/api@1.7.3"]);
  assert.deepEqual(pins("packages/dms-mailing/src/test/antelope-modules.ts", 'package: "@antelopejs/nodemailer",\n    version: "0.0.12",'), ["@antelopejs/nodemailer@0.0.12"]);
  assert.deepEqual(pins("packages/dms-media/src/test/stack-modules.json", '{\n  "@antelopejs/mongodb": "1.8.4",\n  "@antelopejs/api": "1.7.5"\n}'), ["@antelopejs/mongodb@1.8.4", "@antelopejs/api@1.7.5"]);
  assert.deepEqual(pins("package.json", '{ "@antelopejs/api": "1.7.5" }'), []);
  assert.deepEqual(pins("src/index.ts", 'package: "@antelopejs/api", version: "1.7.5"'), []);
});

test("an image behind the Harbor Docker Hub proxy is looked up on Docker Hub", async () => {
  const image = { repository: "AntelopeJS/antelope-web", manager: "dockerfile", datasource: "docker", currentVersion: "24", updateType: "minor", packageFile: "Dockerfile.cloud" };
  assert.equal(await lookup({ ...image, depName: "harbor.antelopejs.cloud/dockerhub-proxy/library/node" }), "library/node");
  assert.equal(await lookup({ ...image, depName: "harbor.antelopejs.cloud/dockerhub-proxy/bitnami/redis" }), "bitnami/redis");
  assert.equal(await lookup({ ...image, depName: "harbor.antelopejs.cloud/other/library/node" }), "harbor.antelopejs.cloud/other/library/node");
  assert.equal(await lookup({ ...image, depName: "node" }), "node");
});

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const modules = process.env.RENOVATE_MODULES ?? "";
assert.ok(existsSync(join(modules, "renovate", "package.json")), "RENOVATE_MODULES names the node_modules folder that holds renovate 44 and json5");

type Config = Record<string, unknown>;
interface CustomManager {
  managerFilePatterns: string[];
  matchStrings: string[];
}
type Preset = Config & { customManagers: CustomManager[] };
interface Upgrade {
  repository: string;
  manager: string;
  depName: string;
  updateType: string;
  packageFile: string;
}

const url = (path: string): string => pathToFileURL(join(modules, path)).href;
const { default: JSON5 }: { default: { parse(text: string): Preset } } = await import(url("json5/lib/index.js"));
const { resolveConfigPresets }: { resolveConfigPresets(config: Config): Promise<{ config: Config }> } = await import(url("renovate/dist/config/presets/index.js"));
const { massageConfig }: { massageConfig(config: Config): Config } = await import(url("renovate/dist/config/massage.js"));
const { mergeChildConfig }: { mergeChildConfig(parent: Config, child: Config): Config } = await import(url("renovate/dist/config/utils.js"));
const { getConfig }: { getConfig(): Config } = await import(url("renovate/dist/config/defaults.js"));
const { applyPackageRules }: { applyPackageRules(config: Config, stage: string): Promise<Config> } = await import(url("renovate/dist/util/package-rules/index.js"));

const preset = JSON5.parse(readFileSync(new URL("../../renovate.json5", import.meta.url), "utf8"));
const config: Config = massageConfig(mergeChildConfig(getConfig(), (await resolveConfigPresets(preset)).config));

async function rules(upgrade: Upgrade): Promise<{ enabled: boolean; groupName?: string; automerge: boolean }> {
  const result = await applyPackageRules({ ...config, ...upgrade, packageName: upgrade.depName }, "pre-lookup");
  return { enabled: result.enabled !== false, groupName: typeof result.groupName === "string" ? result.groupName : undefined, automerge: result.automerge === true };
}

const testStack = { repository: "AntelopeJS/dms-mailing", manager: "custom.regex", depName: "@antelopejs/dms", packageFile: "packages/dms-mailing/src/test/antelope-modules.ts" };

test("Renovate runs daily in the Brussels night and rebases a branch only on a conflict", () => {
  assert.deepEqual(config.schedule, ["* 0-3 * * *"]);
  assert.equal(config.timezone, "Europe/Brussels");
  assert.equal(config.rebaseWhen, "conflicted");
});

test("a patch or minor bump of a test stack module merges through the queue in one AntelopeJS modules pull request", async () => {
  assert.deepEqual(await rules({ ...testStack, updateType: "minor" }), { enabled: true, groupName: "AntelopeJS modules", automerge: true });
  assert.deepEqual(await rules({ ...testStack, updateType: "patch", repository: "AntelopeJS/template-dms-demo", packageFile: "antelope.config.ts" }), {
    enabled: true,
    groupName: "AntelopeJS modules",
    automerge: true,
  });
});

test("a major bump stays manual", async () => {
  assert.equal((await rules({ ...testStack, updateType: "major" })).automerge, false);
  assert.equal((await rules({ repository: "AntelopeJS/dms-media", manager: "npm", depName: "vue", updateType: "major", packageFile: "package.json" })).automerge, false);
});

test("a repository without a merge queue never merges on its own", async () => {
  for (const repository of ["AntelopeJS/cloud", "AntelopeJS/antelope-web"]) {
    assert.equal((await rules({ ...testStack, repository, updateType: "patch", packageFile: "antelope.config.ts" })).automerge, false, repository);
    assert.equal((await rules({ repository, manager: "npm", depName: "vue", updateType: "minor", packageFile: "package.json" })).automerge, false, repository);
  }
});

test("only the module managers read **/test/**", async () => {
  assert.equal((await rules({ ...testStack, updateType: "patch" })).enabled, true);
  assert.equal((await rules({ repository: "AntelopeJS/dms-media", manager: "npm", depName: "vue", updateType: "minor", packageFile: "packages/dms-media/src/test/fixture/package.json" })).enabled, false);
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

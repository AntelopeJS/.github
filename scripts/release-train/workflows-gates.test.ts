import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Json, JsonObject } from "./json.ts";
import { evaluate, fakeNpm, interpolate, packageDirectory, root, runStep, stepOf, text, workflowText } from "./workflows-helpers.ts";

const NO_CREDENTIALS = "RELEASE_APP_ID and RELEASE_APP_PRIVATE_KEY are not configured.";
const manifests = {
  public: { name: "@antelopejs/x", license: "Apache-2.0", publishConfig: { access: "public", provenance: true } },
  private: { name: "@antelopejs-private/x", license: "Apache-2.0", publishConfig: { registry: "https://npm.antelopejs.cloud/" } },
};
const validateMetadata = (registry: string, manifest: JsonObject, repository: Json | undefined, published = "") =>
  runStep(text, "Validate package publication metadata", packageDirectory(`release-${registry}-metadata`, repository === undefined ? manifest : { ...manifest, repository }), {
    PATH: `${fakeNpm}:${process.env.PATH ?? ""}`,
    GITHUB_REPOSITORY: "AntelopeJS/x",
    FAKE_REPOSITORY: published,
    REGISTRY: registry,
  });
const condition = (step: string): string | undefined => /^ {8}if: (.*)$/m.exec(stepOf(text, step))?.[1];
const runs = (step: string, mode: string, registry = "public", version = "1.0.0"): boolean => {
  const expression = condition(step);
  return expression === undefined || evaluate(expression, { steps: { mode: { outputs: { mode } }, version: { outputs: { version } } }, inputs: { registry } }) === true;
};

describe("release-npm.yml", () => {
  for (const [registry, valid] of Object.entries(manifests)) {
    test(`Validate package publication metadata refuses a ${registry} package of another repository`, () => {
      const validate = (repository: Json | undefined, published = "") => validateMetadata(registry, valid, repository, published);
      assert.equal(validate({ type: "git", url: "git+https://github.com/AntelopeJS/x.git" }).status, 0);
      assert.equal(validate("https://github.com/antelopejs/x", "git+https://github.com/AntelopeJS/x.git").status, 0);
      const other = validate({ type: "git", url: "git+https://github.com/AntelopeJS/y.git" });
      assert.deepEqual([other.status, other.stderr], [1, "repository.url must name AntelopeJS/x, got git+https://github.com/AntelopeJS/y.git\n"]);
      const missing = validate(undefined);
      assert.deepEqual([missing.status, missing.stderr], [1, "repository.url must name AntelopeJS/x, got nothing\n"]);
      const taken = validate({ url: "git+https://github.com/AntelopeJS/x.git" }, "git+https://github.com/AntelopeJS/y.git");
      assert.deepEqual([taken.status, taken.stderr], [1, `${valid.name} on npm comes from git+https://github.com/AntelopeJS/y.git, not from AntelopeJS/x\n`]);
    });
  }

  test("Validate package publication metadata holds each registry to its own scope and publishConfig", () => {
    const repository = "https://github.com/AntelopeJS/x";
    const publicOnPrivate = validateMetadata("private", manifests.public, repository);
    assert.deepEqual([publicOnPrivate.status, publicOnPrivate.stderr], [1, "name must use the @antelopejs-private scope\npublishConfig.registry must be https://npm.antelopejs.cloud/\n"]);
    const privateOnPublic = validateMetadata("public", manifests.private, repository);
    assert.deepEqual(
      [privateOnPublic.status, privateOnPublic.stderr],
      [1, "name must use the @antelopejs scope\npublishConfig.access must be public\npublishConfig.provenance must be true\n"],
    );
  });

  test("Validate release credentials asks the private registry's token and refuses another registry", () => {
    const check = (env: Record<string, string>) => {
      const result = runStep(text, "Validate release credentials", root, { MODE: "preview", RELEASE_APP_ID: "", RELEASE_APP_PRIVATE_KEY: "", NPM_ANTELOPE_TOKEN: "", ...env });
      return [result.status, result.stderr];
    };
    assert.deepEqual(check({ REGISTRY: "public" }), [0, ""]);
    assert.deepEqual(check({ REGISTRY: "private" }), [1, "NPM_ANTELOPE_TOKEN is not configured.\n"]);
    assert.deepEqual(check({ REGISTRY: "private", NPM_ANTELOPE_TOKEN: "token" }), [0, ""]);
    assert.deepEqual(check({ REGISTRY: "public", MODE: "stable" }), [1, `${NO_CREDENTIALS}\n`]);
    assert.deepEqual(check({ REGISTRY: "public", MODE: "stable", RELEASE_APP_ID: "1" }), [1, `${NO_CREDENTIALS}\n`]);
    assert.deepEqual(check({ REGISTRY: "public", MODE: "pull-request" }), [0, ""]);
    assert.deepEqual(check({ REGISTRY: "private", MODE: "pull-request" }), [1, "NPM_ANTELOPE_TOKEN is not configured.\n"]);
    assert.deepEqual(check({ REGISTRY: "public", MODE: "repin" }), [1, `${NO_CREDENTIALS}\n`]);
    assert.deepEqual(check({ REGISTRY: "public", MODE: "repin", RELEASE_APP_ID: "1", RELEASE_APP_PRIVATE_KEY: "key" }), [0, ""]);
    assert.deepEqual(check({ REGISTRY: "npmjs" }), [1, "registry must be public or private, got 'npmjs'.\n"]);
  });

  for (const mode of ["stable", "repin"]) {
    test(`a ${mode} run writes with the app token when both app secrets are set, and fails otherwise`, () => {
      const mint = /^ {8}if: (.*)$/m.exec(stepOf(text, "Create the release token"))?.[1] ?? "";
      const writers = ["Push the stable ranges", "Write release notes", "Publish stable release"].map((name) => /^ {10}\w+: (\$\{\{ steps\.token\.outputs\.token.*\}\})$/m.exec(stepOf(text, name))?.[1] ?? "");
      const run = (secrets: Record<string, string>) => {
        const result = runStep(text, "Validate release credentials", root, { MODE: mode, REGISTRY: "public", RELEASE_APP_ID: "", RELEASE_APP_PRIVATE_KEY: "", NPM_ANTELOPE_TOKEN: "", ...secrets });
        const app = /^app=(.*)$/m.exec(result.outputs)?.[1] ?? "";
        const minted = evaluate(mint, { steps: { credentials: { outputs: { app } } } }) === true;
        const steps = { token: { outputs: { token: minted ? "app-token" : "" } } };
        return { status: result.status, stdout: result.stdout, stderr: result.stderr, tokens: [...new Set(writers.map((expression) => interpolate(expression, { steps })))] };
      };
      const app = run({ RELEASE_APP_ID: "1", RELEASE_APP_PRIVATE_KEY: "key" });
      assert.deepEqual([app.status, app.tokens, app.stdout], [0, ["app-token"], ""]);
      const idOnly = run({ RELEASE_APP_ID: "1" });
      assert.deepEqual([idOnly.status, idOnly.stderr], [1, `${NO_CREDENTIALS}\n`]);
      const keyOnly = run({ RELEASE_APP_PRIVATE_KEY: "key" });
      assert.deepEqual([keyOnly.status, keyOnly.stderr], [1, `${NO_CREDENTIALS}\n`]);
      const neither = run({});
      assert.deepEqual([neither.status, neither.stderr], [1, `${NO_CREDENTIALS}\n`]);
    });
  }
});

describe("release-npm.yml", () => {
  test("each publishing step runs for the modes and registries it serves, and no other", () => {
    const publishers = ["Publish preview", "Install pkg.pr.new", "Publish to pkg.pr.new", "Publish stable release"];
    const published = (mode: string, registry: string, version = "1.0.0") => publishers.filter((step) => runs(step, mode, registry, version));
    for (const registry of ["public", "private"]) {
      assert.deepEqual(published("preview", registry), ["Publish preview"], `preview ${registry}`);
      assert.deepEqual(published("stable", registry), ["Publish stable release"], `stable ${registry}`);
      assert.deepEqual(published("repin", registry), [], `repin ${registry}`);
      for (const mode of ["preview", "pull-request"]) assert.deepEqual(published(mode, registry, ""), [], `${mode} ${registry} without a version`);
    }
    assert.deepEqual(published("pull-request", "private"), ["Publish preview"]);
    assert.deepEqual(published("pull-request", "public"), ["Install pkg.pr.new", "Publish to pkg.pr.new"]);
  });

  test("only a stable or repin run checks the plan, applies ranges and configures the release identity", () => {
    for (const step of ["Check the planned commit", "Apply dependency ranges", "Configure release identity"]) {
      for (const mode of ["preview", "pull-request", "stable", "repin"]) assert.equal(runs(step, mode), mode === "stable" || mode === "repin", `${step} in ${mode}`);
    }
    assert.equal(runs("Push the stable ranges", "repin"), true);
    for (const mode of ["preview", "pull-request", "stable"]) assert.equal(runs("Push the stable ranges", mode), false, mode);
  });

  test("the job runs on the caller's RUNNER_CI runner for a private or internal repository when it is set, and on ubuntu-latest otherwise, and always for a public one", () => {
    const runsOn = /^ {4}runs-on: (.*)$/m.exec(text)?.[1] ?? "";
    const runner = (visibility: string, vars: JsonObject) => evaluate(runsOn, { github: { event: { repository: { visibility } } }, vars });
    assert.equal(runner("private", { RUNNER_CI: "antelope-ci" }), "antelope-ci");
    assert.equal(runner("internal", { RUNNER_CI: "antelope-ci" }), "antelope-ci");
    assert.equal(runner("private", {}), "ubuntu-latest");
    assert.equal(runner("private", { RUNNER_CI: "" }), "ubuntu-latest");
    assert.equal(runner("public", { RUNNER_CI: "antelope-ci" }), "ubuntu-latest");
    assert.equal(runner("public", {}), "ubuntu-latest");
  });

  test("the job skips every push, so a caller that still triggers on one publishes nothing, runs every dispatch, and a pull request only when it carries the preview label, a labeled event only for that label", () => {
    const job = /^ {4}if: (.*)$/m.exec(text)?.[1] ?? "";
    const gate = (event: string, action: string, labels: string[], label = "", branch = "main") =>
      evaluate(job, { github: { event_name: event, ref_name: branch, event: { action, label: { name: label }, pull_request: { labels }, repository: { default_branch: "main" } } } });
    assert.equal(gate("push", "", []), false);
    assert.equal(gate("push", "", [], "", "next"), false);
    assert.equal(gate("workflow_dispatch", "", []), true);
    assert.equal(gate("workflow_dispatch", "", [], "", "work/x"), true);
    assert.equal(gate("pull_request", "opened", []), false);
    assert.equal(gate("pull_request", "opened", ["ci:full"]), false);
    assert.equal(gate("pull_request", "opened", ["preview"]), true);
    assert.equal(gate("pull_request", "synchronize", ["ci:full", "preview"]), true);
    assert.equal(gate("pull_request", "labeled", ["preview"], "preview"), true);
    assert.equal(gate("pull_request", "labeled", ["preview", "ci:full"], "ci:full"), false);
    assert.equal(gate("pull_request", "labeled", ["ci:full"], "ci:full"), false);
  });

  test("a pull request run uses no environment, has a group of its own per pull request, and cancels the run it replaces", () => {
    const attribute = (indent: number, name: string): string => {
      const prefix = `${" ".repeat(indent)}${name}: `;
      const line = text.split("\n").find((candidate) => candidate.startsWith(prefix));
      assert.notEqual(line, undefined, name);
      return line?.slice(prefix.length) ?? "";
    };
    const scope = (event: string, number?: number, preview = false) => ({ github: { repository: "AntelopeJS/x", event_name: event, event: { pull_request: number === undefined ? {} : { number } } }, inputs: { "package-directory": ".", preview } });
    const environment = attribute(4, "environment");
    assert.equal(evaluate(environment, scope("push")), "npm-publish");
    assert.equal(evaluate(environment, scope("workflow_dispatch")), "npm-publish");
    assert.equal(evaluate(environment, scope("pull_request", 12)), "");
    const group = (event: string, number?: number, preview = false): string => interpolate(attribute(6, "group"), scope(event, number, preview));
    assert.notEqual(group("pull_request", 12), group("pull_request", 13));
    assert.equal(group("pull_request", 12), group("pull_request", 12));
    assert.notEqual(group("pull_request", 12), group("push"));
    assert.notEqual(group("push"), group("workflow_dispatch"));
    assert.notEqual(group("workflow_dispatch", undefined, true), group("workflow_dispatch"));
    const cancel = attribute(6, "cancel-in-progress");
    assert.deepEqual([evaluate(cancel, scope("pull_request", 12)), evaluate(cancel, scope("push")), evaluate(cancel, scope("workflow_dispatch"))], [true, false, false]);
  });
});

describe("release-npm.yml", () => {
  test("a pull request run builds the head commit of the pull request, and any other run the commit of its event", () => {
    const ref = /^ {10}ref: (.*)$/m.exec(text)?.[1] ?? "";
    const head = "a".repeat(40);
    assert.equal(evaluate(ref, { github: { event: { pull_request: { head: { sha: head } } } } }), head);
    assert.equal(evaluate(ref, { github: { event: { pull_request: { head: {} } } } }), "");
  });

  test("only a job that installs restores and saves the pnpm cache", () => {
    const steps = text.split("\n      - ").slice(1);
    const condition = (step: string) => /^ {8}if: (.*)$/m.exec(step)?.[1];
    const install = steps.findIndex((step) => step.startsWith("name: Install dependencies\n"));
    const cached = steps.flatMap((step, index) => (/^ {10}cache: pnpm$/m.test(step) ? [index] : []));
    assert.equal(cached.length, 1);
    assert.ok(cached[0] < install);
    assert.equal(condition(steps[cached[0]]), condition(steps[install]));
    assert.equal(condition(steps[install]), "steps.version.outputs.version != '' || steps.mode.outputs.mode == 'repin'");
  });

  test("a preview run cannot write to the repository", () => {
    assert.doesNotMatch(text, /permissions:|id-token/, "the job inherits the grant of the entry that calls it, and a private caller grants no id-token");
    for (const entry of ["release-npm-public.yml", "release-npm-private.yml"]) {
      const caller = workflowText(entry);
      const permissions = caller.slice(caller.indexOf("    permissions:\n"), caller.indexOf("    uses: ./.github/workflows/release-npm.yml\n"));
      assert.match(permissions, /^ {6}contents: read$/m, entry);
      assert.doesNotMatch(caller, /contents: write/, entry);
    }
  });

  test("only the public entry point grants id-token: write, which npm trusted publishing and provenance need", () => {
    const grant = (entry: string): string => {
      const caller = workflowText(entry);
      return caller.slice(caller.indexOf("    permissions:\n"), caller.indexOf("    uses: ./.github/workflows/release-npm.yml\n"));
    };
    assert.match(grant("release-npm-public.yml"), /^ {6}id-token: write$/m);
    assert.doesNotMatch(grant("release-npm-private.yml"), /id-token/);
  });
});

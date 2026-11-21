import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { dispatches, dms, fakeSystem, interfaceDatabase } from "./fixtures.ts";
import { main } from "./train.ts";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const caller = read("./frozen-caller.yml");
const release = read("../../.github/workflows/release-npm.yml");
const scratch = mkdtempSync(join(tmpdir(), "release-caller-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function block(text: string, path: readonly string[]): string[] {
  let lines = text.split("\n");
  for (const key of path) {
    const start = lines.findIndex((line) => line.trimStart() === `${key}:` || line.trimStart().startsWith(`${key}: `));
    assert.notEqual(start, -1, `no ${path.join(".")}`);
    const indent = (lines[start] ?? "").length - (lines[start] ?? "").trimStart().length;
    const end = lines.findIndex((line, index) => index > start && line.trim() !== "" && line.length - line.trimStart().length <= indent);
    lines = lines.slice(start + 1, end === -1 ? undefined : end);
  }
  return lines;
}

function entries(text: string, path: readonly string[]): Map<string, string[]> {
  const lines = block(text, path).filter((line) => line.trim() !== "");
  const indent = Math.min(...lines.map((line) => line.length - line.trimStart().length));
  const found = new Map<string, string[]>();
  let current = "";
  for (const line of lines) {
    if (line.length - line.trimStart().length === indent) {
      current = line.trim().replace(/:.*$/, "");
      found.set(current, line.trim().includes(": ") ? [line.trim().slice(current.length + 2)] : []);
    } else found.get(current)?.push(line.trim());
  }
  return found;
}

const declared = [...entries(caller, ["workflow_dispatch", "inputs"]).keys()];

describe("the frozen caller", () => {
  test("declares every input the release train dispatches for a package at the root", () => {
    const { system, calls } = fakeSystem();
    assert.equal(main(["go", interfaceDatabase], system), 0);
    const sent = dispatches(calls).flatMap(([, ...fields]) => fields.map((field) => field.slice(0, field.indexOf("="))));
    assert.ok(sent.length > 0);
    assert.deepEqual(sent.filter((name) => !declared.includes(name)), []);
  });

  test("a nested package adds only package-directory, which antelopejs-sync declares for it", () => {
    const { system, calls } = fakeSystem();
    assert.equal(main(["go", `${dms}:packages/automation`], system), 0);
    const sent = dispatches(calls).flatMap(([, ...fields]) => fields.map((field) => field.slice(0, field.indexOf("="))));
    assert.deepEqual(sent.filter((name) => !declared.includes(name)), ["package-directory"]);
  });

  test("release-npm.yml takes a registry beside inputs that default as the wrappers' do, so a caller passes only what it needs", () => {
    const accepted = entries(release, ["workflow_call", "inputs"]);
    assert.deepEqual([...accepted].filter(([, lines]) => lines.includes("required: true")).map(([name]) => name), ["registry"]);
    assert.equal(accepted.has("integration-branch"), false);
    const shape = (lines: string[] | undefined) => lines?.filter((line) => line.startsWith("default: ") || line.startsWith("type: "));
    for (const file of ["release-npm-public.yml", "release-npm-private.yml"]) {
      const wrapper = entries(read(`../../.github/workflows/${file}`), ["workflow_call", "inputs"]);
      for (const name of accepted.keys()) {
        if (name === "registry" || (name === "install-core" && file.includes("private"))) continue;
        assert.deepEqual(shape(accepted.get(name)), shape(wrapper.get(name)), `${file} ${name}`);
      }
    }
    const direct = caller.replace("release-npm-public.yml", "release-npm.yml").replace("    with:\n", "    with:\n      registry: public\n");
    const passed = [...entries(direct, ["jobs", "release", "with"]).keys()];
    assert.deepEqual(passed.filter((name) => !accepted.has(name)), []);
    assert.deepEqual([...accepted].filter(([, lines]) => lines.includes("required: true")).map(([name]) => name).filter((name) => !passed.includes(name)), []);
  });

  for (const registry of ["public", "private"]) {
    const file = `release-npm-${registry}.yml`;
    const entry = read(`../../.github/workflows/${file}`);
    const job =
      registry === "public"
        ? caller
        : caller
            .replace("release-npm-public.yml", file)
            .replace("  id-token: write\n", "")
            .replace(/(\n {6}RELEASE_APP_PRIVATE_KEY: .*\n)/, "$1      NPM_ANTELOPE_TOKEN: ${{ secrets.NPM_ANTELOPE_TOKEN }}\n");

    test(`calls ${file} with inputs, secrets and permissions it accepts`, () => {
      assert.match(job, new RegExp(`uses: AntelopeJS/\\.github/\\.github/workflows/${file.replace(".", "\\.")}@v2\\n`));
      const accepted = entries(entry, ["workflow_call", "inputs"]);
      const passed = [...entries(job, ["jobs", "release", "with"]).keys()];
      assert.deepEqual(passed.filter((name) => !accepted.has(name)), []);
      const required = [...accepted].filter(([, lines]) => lines.includes("required: true")).map(([name]) => name);
      assert.deepEqual(required.filter((name) => !passed.includes(name)), []);
      const declaredSecrets = entries(entry, ["workflow_call", "secrets"]);
      assert.deepEqual([...declaredSecrets].filter(([, lines]) => lines.includes("required: true")), []);
      const passedSecrets = entries(job, ["jobs", "release", "secrets"]);
      assert.deepEqual([...passedSecrets.keys()].sort(), [...declaredSecrets.keys()].sort(), `the caller forwards every secret ${file} declares`);
      for (const [name, value] of passedSecrets) assert.deepEqual(value, [`\${{ secrets.${name} }}`]);
      const granted = entries(job, ["permissions"]);
      for (const [scope, [level = ""]] of entries(entry, ["jobs", "release", "permissions"])) {
        const grant = granted.get(scope)?.[0];
        assert.ok(level === "read" ? grant === "read" || grant === "write" : grant === level, `${file} asks ${scope}: ${level}, the caller grants ${grant}`);
      }
    });

    test(`${file} forwards every input but integration-branch and every secret to release-npm.yml, and names its registry`, () => {
      const forwarded = entries(entry, ["jobs", "release", "with"]);
      assert.deepEqual([...forwarded.keys()].sort(), [...entries(release, ["workflow_call", "inputs"]).keys()].sort());
      assert.deepEqual(forwarded.get("registry"), [registry]);
      const declaredInputs = entries(entry, ["workflow_call", "inputs"]);
      assert.deepEqual(
        [...declaredInputs.keys()].filter((name) => !forwarded.has(name)),
        ["integration-branch"],
      );
      assert.equal(declaredInputs.get("integration-branch")?.some((line) => line.startsWith("default:")), false);
      for (const name of declaredInputs.keys()) if (forwarded.has(name)) assert.deepEqual(forwarded.get(name), [`\${{ inputs.${name} }}`]);
      const secrets = entries(entry, ["jobs", "release", "secrets"]);
      assert.deepEqual([...secrets.keys()], [...entries(entry, ["workflow_call", "secrets"]).keys()]);
      for (const [name, value] of secrets) assert.deepEqual(value, [`\${{ secrets.${name} }}`]);
    });

    test(`${file} resolves the caller's push and dispatch without any other input`, () => {
      const step = (() => {
        const lines = release.split("\n");
        const start = lines.indexOf("      - name: Resolve release mode");
        const run = lines.indexOf("        run: |", start);
        const body: string[] = [];
        for (const line of lines.slice(run + 1)) {
          if (line !== "" && !line.startsWith("          ")) break;
          body.push(line.slice(10));
        }
        return body.join("\n");
      })();
      writeFileSync(join(scratch, "mode.sh"), step);
      const accepted = entries(entry, ["workflow_call", "inputs"]);
      const wired = entries(job, ["jobs", "release", "with"]);
      const forwarded = entries(entry, ["jobs", "release", "with"]);
      const stepEnv = entries(release.slice(release.indexOf("      - name: Resolve release mode")), ["env"]);
      const resolve = (event: string, ref: string, dispatched: Record<string, string>, pullRequest = "") => {
        const input = (name: string): string => {
          const passed = /^\$\{\{ inputs\.([\w-]+) \}\}$/.exec(wired.get(name)?.[0] ?? "")?.[1];
          if (passed !== undefined) return dispatched[passed] ?? "";
          const fallback = accepted.get(name)?.find((line) => line.startsWith("default: "))?.slice(9) ?? "";
          return fallback.replace(/^"(.*)"$/, "$1");
        };
        const expression = (value: string): string => {
          if (value === "${{ github.event.repository.default_branch }}") return "main";
          if (value === "${{ github.event.pull_request.number }}") return pullRequest;
          const name = /^\$\{\{ inputs\.([\w-]+) \}\}$/.exec(value)?.[1];
          assert.ok(name !== undefined, `the test cannot evaluate ${value}`);
          const passed = /^\$\{\{ inputs\.([\w-]+) \}\}$/.exec(forwarded.get(name)?.[0] ?? "")?.[1];
          assert.ok(passed !== undefined, `${file} does not forward ${name}`);
          return input(passed);
        };
        const env = Object.fromEntries([...stepEnv].map(([name, [value = ""]]) => [name, expression(value)]));
        const output = join(scratch, `output-${event}`);
        writeFileSync(output, "");
        const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", join(scratch, "mode.sh")], {
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_OUTPUT: output,
            GITHUB_EVENT_NAME: event,
            GITHUB_REF: ref,
            ...env,
          },
        });
        return [result.status, readFileSync(output, "utf8"), result.stderr];
      };
      const pushed = /^ {4}branches: \[(\w+)\]$/m.exec(caller)?.[1];
      assert.equal(pushed, "main", "the frozen caller previews on a push to the default branch");
      assert.deepEqual(resolve("push", `refs/heads/${pushed}`, {}), [0, "mode=preview\ntag=next\n", ""]);
      const dispatched = { "release-version": "0.5.0", "release-commit": "a".repeat(40), "dependency-ranges": "{}" };
      assert.deepEqual(Object.keys(dispatched), declared);
      assert.deepEqual(resolve("workflow_dispatch", "refs/heads/main", dispatched), [0, "mode=stable\n", ""]);
    });
  }
});

test("RELEASE_GITHUB_TOKEN only stands in for the release app token, and each workflow that writes to the repository mints one", () => {
  const directory = new URL("../../.github/workflows/", import.meta.url);
  const workflows = readdirSync(directory).filter((name) => name.endsWith(".yml"));
  const reading = workflows.filter((name) => read(`../../.github/workflows/${name}`).includes("secrets.RELEASE_GITHUB_TOKEN"));
  assert.deepEqual(reading, ["next-sync.yml", "release-npm-private.yml", "release-npm-public.yml", "release-npm.yml"]);
  for (const name of reading) {
    const text = read(`../../.github/workflows/${name}`);
    const uses = text.split("\n").filter((line) => line.includes("RELEASE_GITHUB_TOKEN }}") || line.includes("steps.token.outputs.token"));
    for (const line of uses) assert.match(line.trim(), /^(RELEASE_GITHUB_TOKEN: \$\{\{ secrets\.RELEASE_GITHUB_TOKEN \}\}|\w+: \$\{\{ steps\.token\.outputs\.token \|\| secrets\.RELEASE_GITHUB_TOKEN \}\})$/, `${name}: ${line}`);
  }
  const minting = workflows.filter((name) => /uses: actions\/create-github-app-token@[0-9a-f]{40} /.test(read(`../../.github/workflows/${name}`)));
  assert.deepEqual(minting, ["module-locks-refresh.yml", "module-locks-renovate.yml", "next-sync.yml", "release-npm.yml"]);
});

test("each release app token asks only the permissions its job uses", () => {
  const asked = (name: string): string[] => {
    const text = read(`../../.github/workflows/${name}`);
    const steps = text.split(/\n {6}- /).filter((step) => /uses: actions\/create-github-app-token@/.test(step));
    assert.equal(steps.length, 1, name);
    return [...(steps[0] ?? "").matchAll(/^ {10}(permission-[\w-]+: \w+)$/gm)].map(([, line]) => line ?? "");
  };
  assert.deepEqual(asked("release-npm.yml"), ["permission-contents: write", "permission-pull-requests: read"]);
  assert.deepEqual(asked("next-sync.yml"), ["permission-contents: write"]);
  assert.deepEqual(asked("module-locks-renovate.yml"), ["permission-contents: write"]);
  assert.deepEqual(asked("module-locks-refresh.yml"), ["permission-contents: write", "permission-pull-requests: write"]);
});

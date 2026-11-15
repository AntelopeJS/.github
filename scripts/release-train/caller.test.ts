import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { dispatches, dms, fakeSystem, interfaceDatabase } from "./fixtures.ts";
import { main } from "./train.ts";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const caller = read("./frozen-caller.yml");
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

  for (const registry of ["public", "private"]) {
    const file = `release-npm-${registry}.yml`;
    const shared = read(`../../.github/workflows/${file}`);
    const job = registry === "public" ? caller : caller.replace("release-npm-public.yml", file).replace("  id-token: write\n", "");

    test(`calls ${file} with inputs, secrets and permissions it accepts`, () => {
      assert.match(job, new RegExp(`uses: AntelopeJS/\\.github/\\.github/workflows/${file.replace(".", "\\.")}@v2\\n`));
      const accepted = entries(shared, ["workflow_call", "inputs"]);
      const passed = [...entries(job, ["jobs", "release", "with"]).keys()];
      assert.deepEqual(passed.filter((name) => !accepted.has(name)), []);
      const required = [...accepted].filter(([, lines]) => lines.includes("required: true")).map(([name]) => name);
      assert.deepEqual(required.filter((name) => !passed.includes(name)), []);
      const secrets = [...entries(shared, ["workflow_call", "secrets"])].filter(([, lines]) => lines.includes("required: true"));
      assert.deepEqual(secrets, []);
      const granted = entries(job, ["permissions"]);
      for (const [scope, [level = ""]] of entries(shared, ["jobs", "release", "permissions"])) {
        const grant = granted.get(scope)?.[0];
        assert.ok(level === "read" ? grant === "read" || grant === "write" : grant === level, `${file} asks ${scope}: ${level}, the caller grants ${grant}`);
      }
    });

    test(`${file} resolves the caller's push and dispatch without any other input`, () => {
      const step = (() => {
        const lines = shared.split("\n");
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
      const accepted = entries(shared, ["workflow_call", "inputs"]);
      const wired = entries(job, ["jobs", "release", "with"]);
      const stepEnv = entries(shared.slice(shared.indexOf("      - name: Resolve release mode")), ["env"]);
      const resolve = (event: string, ref: string, dispatched: Record<string, string>) => {
        const input = (name: string): string => {
          const passed = /^\$\{\{ inputs\.([\w-]+) \}\}$/.exec(wired.get(name)?.[0] ?? "")?.[1];
          if (passed !== undefined) return dispatched[passed] ?? "";
          const fallback = accepted.get(name)?.find((line) => line.startsWith("default: "))?.slice(9) ?? "";
          return fallback.replace(/^"(.*)"$/, "$1");
        };
        const expression = (value: string): string => {
          if (value === "${{ github.event.repository.default_branch }}") return "main";
          const name = /^\$\{\{ inputs\.([\w-]+) \}\}$/.exec(value)?.[1];
          assert.ok(name !== undefined, `the test cannot evaluate ${value}`);
          return input(name);
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
      assert.deepEqual(resolve("push", "refs/heads/next", {}), [0, "mode=preview\n", ""]);
      const dispatched = { "release-version": "0.5.0", "release-commit": "a".repeat(40), "dependency-ranges": "{}" };
      assert.deepEqual(Object.keys(dispatched), declared);
      assert.deepEqual(resolve("workflow_dispatch", "refs/heads/main", dispatched), [0, "mode=stable\n", ""]);
    });
  }
});

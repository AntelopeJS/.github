import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type Run, ciNode, event, fakeEnv, nodeJob, root, runStep, succeeded } from "./helpers/harness.ts";
import { readText } from "./helpers/read.ts";
import { type Context, evaluate, field, interpolateAll, keyed, step, stepOutputs } from "./helpers/workflow.ts";

const annotate = step(nodeJob, "Annotate the flaky tests");
const github = event("merge_group", "gh-readonly-queue/main/pr-1-abc");
const fixture = (name: string): string => readText(new URL(`./fixtures/${name}.log`, import.meta.url));

interface Annotated {
  run: Run;
  warnings: string[];
  summary: string[];
}

interface Logs {
  tests?: string;
  extra?: string;
}

const flakySteps = (logs: Logs): Context => {
  const flaky = (name: string, log: string | undefined): Context => stepOutputs(step(nodeJob, name), log === undefined ? {} : { flaky: "true" });
  return { ...flaky("Run tests", logs.tests), ...flaky("Run extra commands", logs.extra) };
};

function annotates(steps: Context): boolean {
  const condition = /^\$\{\{ !cancelled\(\) && \((.+)\) \}\}$/.exec(annotate.if ?? "");
  assert.ok(condition, `not a condition this test evaluates: ${annotate.if}`);
  return condition[1].split(" || ").some((operand) => {
    const flaky = /^([\w.-]+) == 'true'$/.exec(operand);
    assert.ok(flaky, `not an operand this test evaluates: ${operand}`);
    return evaluate(flaky[1], steps) === "true";
  });
}

function annotateLogs({ tests, extra }: Logs): Annotated {
  const dir = realpathSync(mkdtempSync(join(root, "flaky-")));
  const steps = flakySteps({ tests, extra });
  assert.ok(annotates(steps), "the annotate step runs when a retry passed");
  for (const [file, log] of Object.entries({ "test-attempt-1.log": tests, "extra-attempt-1.log": extra })) {
    if (log !== undefined) writeFileSync(join(dir, file), log.replaceAll("/home/runner/work/example/example", dir));
  }
  const run = succeeded(runStep(annotate, dir, { ...interpolateAll(annotate.env, { ...github, ...steps }), ...fakeEnv(dir, {}) }));
  return { run, warnings: run.stdout.split("\n").filter((line) => line !== ""), summary: run.summary.split("\n").filter((line) => line !== "") };
}

const annotateLog = (log: string): Annotated => annotateLogs({ tests: log });

const warning = (message: string): string => `::warning title=Flaky test::AntelopeJS/example: ${message} passed only on its merge-queue retry.`;
const summaryLine = (message: string): string => `- Flaky test: \`\` AntelopeJS/example: ${message} passed only on its merge-queue retry. \`\``;

function expectLogs(logs: Logs, messages: string[]): void {
  const { warnings, summary } = annotateLogs(logs);
  assert.deepEqual(warnings, messages.map(warning));
  assert.deepEqual(summary, messages.map(summaryLine));
}

const expectAnnotations = (log: string, messages: string[]): void => expectLogs({ tests: log }, messages);

const math = "test/math.test.js";
const runners = [
  { name: "vitest", fixture: "vitest", messages: ["test/broken.test.js", `${math} > math > add > adds 1 and 2`, `${math} > math > top level fails`] },
  { name: "vitest with colors", fixture: "vitest-color", messages: ["test/broken.test.js", `${math} > math > add > adds 1 and 2`, `${math} > math > top level fails`] },
  { name: "jest", fixture: "jest", messages: [`${math} > math > add > adds 1 and 2`, `${math} > math > top level fails`, "test/broken.test.js"] },
  { name: "mocha", fixture: "mocha", messages: [`${math} > math > top level fails`, `${math} > math > add > adds 1 and 2`] },
  { name: "mocha with ES modules", fixture: "mocha-esm", messages: ["test/math.test.mjs > math > add > adds 1 and 2"] },
  { name: "mocha with a timeout, a multi-line message and a suite title ending in a colon", fixture: "mocha-timeout", messages: ["test/timeout.test.js > slow suite > times out", "test/timeout.test.js > slow suite > multi-line message", "test/timeout.test.js > slow suite > ends with colon: > inner"] },
  { name: "two mocha runs in one log", fixture: "mocha-two", messages: ["m1/a.test.js > first > flakes", "m2/b.test.js > root level bad", "m2/b.test.js > second > bad"] },
  { name: "node:test", fixture: "node-test", messages: ["test/broken.test.js", `${math} > math > add > adds 1 and 2`, `${math} > math > top level fails`] },
];

const vitestLog = (failures: { file: string; name: string }[]): string => failures.map(({ file, name }) => ` FAIL  ${file} > ${name}\n`).join("");

const vitestFiles = (prefix: string, files: number, perFile: number): string =>
  vitestLog(Array.from({ length: files * perFile }, (_, index) => ({ file: `test/${prefix}-${index % files}.test.js`, name: `case ${index}` })));

const mochaNotFound = ["  1 failing", "", "  1) math", "       adds:", "", "      Error: boom", "      at Context.<anonymous> (src/helper.js:1:1)", ""].join("\n");

describe("the flaky test annotations", () => {
  test("the annotate step runs when either retry passed, and not when neither step flaked", () => {
    assert.equal(annotates(flakySteps({ tests: "" })), true);
    assert.equal(annotates(flakySteps({ extra: "" })), true);
    assert.equal(annotates(flakySteps({})), false);
  });

  test("the annotations come after the two steps whose retry they read, and before the services stop", () => {
    const position = (name: string): number => nodeJob.findIndex((line) => line.trim() === `- name: ${name}`);
    assert.ok(position("Run tests") < position("Run extra commands"));
    assert.ok(position("Run extra commands") < position("Annotate the flaky tests"));
    assert.ok(position("Annotate the flaky tests") < position("Stop services"));
  });

  for (const { name, fixture: file, messages } of runners) {
    test(`${name}: one annotation and one summary line per failed test of the first attempt`, () => {
      expectAnnotations(fixture(file), messages);
    });
  }

  test("a failure whose test file is not found is named after the command", () => {
    const log = ["  1 failing", "", "  1) math", "       adds:", "", "      Error: boom", "      at Context.<anonymous> (src/helper.js:1:1)", ""].join("\n");
    expectAnnotations(log, ["pnpm run test > math > adds"]);
  });

  test("jest: a test file slower than its slow threshold keeps its name", () => {
    const log = ["FAIL test/slow.test.js (6.12 s)", "  ● slow › waits", "", "    expect(received).toBe(expected)", ""].join("\n");
    expectAnnotations(log, ["test/slow.test.js > slow > waits"]);
  });

  test("jest: only the failure bullets of a FAIL block name tests", () => {
    const log = ["FAIL test/a.test.js", "  ● list › fails", "", "    Error: list:", "      ● item one", "", "  ●  Cannot log after tests are done. Did you forget to wait for something async in your test?", ""].join("\n");
    expectAnnotations(log, ["test/a.test.js > list > fails"]);
  });

  test("a parser that throws falls back to one annotation naming the command", () => {
    const log = ["  1 failing", "", "  1) math", "       adds:", "     Error: boom", "      at Context.<anonymous> (file:///home/runner/work/x/x/test/a%2Fb.test.js:5:20)", ""].join("\n");
    expectAnnotations(log, ["pnpm run test"]);
  });

  test("an unparseable log gives one annotation naming the command", () => {
    expectAnnotations("something went wrong\nbut no runner says what\n", ["pnpm run test"]);
  });

  test("more than ten failed tests collapse to one annotation per test file", () => {
    const failures = Array.from({ length: 12 }, (_, index) => ({ file: `test/file-${index % 3}.test.js`, name: `case ${index}` }));
    expectAnnotations(vitestLog(failures), ["test/file-0.test.js", "test/file-1.test.js", "test/file-2.test.js"]);
  });

  test("more than ten failed test files collapse to one annotation naming the command", () => {
    const failures = Array.from({ length: 11 }, (_, index) => ({ file: `test/file-${index}.test.js`, name: "case" }));
    expectAnnotations(vitestLog(failures), ["pnpm run test"]);
  });

  test("ten failed tests keep their names", () => {
    const failures = Array.from({ length: 10 }, (_, index) => ({ file: "test/many.test.js", name: `case ${index}` }));
    expectAnnotations(vitestLog(failures), failures.map(({ name }) => `test/many.test.js > ${name}`));
  });

  test("extra commands: a mocha integration timeout is named after its test", () => {
    expectLogs({ extra: fixture("extra-mocha-timeout") }, ["test/integration/media.test.ts > media integration > uploads > generates the thumbnails"]);
  });

  test("extra commands: an unparseable log gives one annotation naming extra-commands", () => {
    expectLogs({ extra: "building\nsomething went wrong\n" }, ["extra-commands"]);
  });

  test("extra commands: a failure whose test file is not found is named after extra-commands", () => {
    expectLogs({ extra: mochaNotFound }, ["extra-commands > math > adds"]);
  });

  test("tests and extra commands that both flaked give the annotations of the tests, then those of the extra commands", () => {
    expectLogs({ tests: fixture("vitest"), extra: fixture("extra-mocha-timeout") }, [
      "test/broken.test.js",
      `${math} > math > add > adds 1 and 2`,
      `${math} > math > top level fails`,
      "test/integration/media.test.ts > media integration > uploads > generates the thumbnails",
    ]);
  });

  test("each log keeps its own command name when the other log has the failure", () => {
    expectLogs({ tests: mochaNotFound, extra: mochaNotFound }, ["pnpm run test > math > adds", "extra-commands > math > adds"]);
  });

  test("ten failed tests across both logs keep their names", () => {
    expectLogs({ tests: vitestFiles("a", 1, 5), extra: vitestFiles("b", 1, 5) }, [
      ...Array.from({ length: 5 }, (_, index) => `test/a-0.test.js > case ${index}`),
      ...Array.from({ length: 5 }, (_, index) => `test/b-0.test.js > case ${index}`),
    ]);
  });

  test("more than ten failed tests across both logs collapse both to one annotation per test file", () => {
    expectLogs({ tests: vitestFiles("a", 2, 3), extra: vitestFiles("b", 2, 3) }, ["test/a-0.test.js", "test/a-1.test.js", "test/b-0.test.js", "test/b-1.test.js"]);
  });

  test("more than ten failed test files across both logs collapse to one annotation naming each command", () => {
    expectLogs({ tests: vitestFiles("a", 6, 1), extra: vitestFiles("b", 6, 1) }, ["pnpm run test", "extra-commands"]);
  });

  test("a log that parses nothing keeps its command name beside a log that collapses", () => {
    expectLogs({ tests: vitestFiles("a", 11, 1), extra: "no runner output\n" }, ["pnpm run test", "extra-commands"]);
  });

  test("the message of an annotation escapes percent signs, and the summary keeps them", () => {
    const { warnings, summary } = annotateLog(" FAIL  test/escape.test.js > 100% sure, %0A stays text\n");
    assert.deepEqual(warnings, ["::warning title=Flaky test::AntelopeJS/example: test/escape.test.js > 100%25 sure, %250A stays text passed only on its merge-queue retry."]);
    assert.deepEqual(summary, [summaryLine("test/escape.test.js > 100% sure, %0A stays text")]);
  });

  test("the workflow files nothing in Notion and still declares the deprecated secret", () => {
    assert.ok(!ciNode.join("\n").includes("api.notion.com"));
    const secret = keyed(keyed(keyed(ciNode, "on"), "workflow_call"), "secrets");
    assert.equal(field(keyed(secret, "NOTION_TOKEN"), "required"), "false");
  });
});

import assert from "node:assert/strict";

const indent = (line: string): number => line.length - line.trimStart().length;

/** The lines nested under `lines[start]`. */
export function block(lines: string[], start: number): string[] {
  const own = indent(lines[start]);
  const end = lines.findIndex((line, index) => index > start && line.trim() !== "" && indent(line) <= own);
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** The lines nested under the first `key:` line. */
export function keyed(lines: string[], key: string): string[] {
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  assert.notEqual(start, -1, `no ${key}`);
  return block(lines, start);
}

/** The value of `key: value` at the outermost indent of `lines`. */
export function field(lines: string[], key: string): string | undefined {
  const own = Math.min(...lines.filter((line) => line.trim() !== "").map(indent));
  const line = lines.find((candidate) => indent(candidate) === own && candidate.trim().startsWith(`${key}: `));
  return line?.trim().slice(key.length + 2);
}

function ownLines(lines: string[]): string[] {
  const own = Math.min(...lines.filter((line) => line.trim() !== "").map(indent));
  return lines.filter((line) => line.trim() !== "" && indent(line) === own);
}

/** The keys at the outermost indent of `lines`. */
export const keys = (lines: string[]): string[] => ownLines(lines).map((line) => line.trim().split(":")[0]);

/** The `key: value` pairs at the outermost indent of `lines`. */
export const mapping = (lines: string[]): Record<string, string> =>
  Object.fromEntries(
    ownLines(lines).map((line) => {
      const [key, ...value] = line.trim().split(": ");
      return [key, value.join(": ")];
    }),
  );

/** An expression context, keyed by the path an expression names, such as `github.event_name` or `github.event.pull_request.labels.*.name`. */
export interface Context {
  readonly [path: string]: string | string[];
}

/** `values` under the path `prefix`, so `scope("inputs", { a: "1" })` holds `inputs.a`. */
export const scope = (prefix: string, values: Context): Context => Object.fromEntries(Object.entries(values).map(([key, value]) => [`${prefix}.${key}`, value]));

const at = (context: Context, path: string): string | string[] | undefined => (Object.hasOwn(context, path) ? context[path] : undefined);

/** The value of a GitHub expression this test supports in `context`, as GitHub interpolates it. */
export function evaluate(expression: string, context: Context): string {
  if (expression.includes(" || ")) return expression.split(" || ").map((operand) => evaluate(operand, context)).find((value) => value !== "") ?? "";
  const contains = /^contains\(([\w.-]+\.\*\.[\w-]+), '([^']*)'\)$/.exec(expression);
  if (contains) {
    const [, path, wanted] = contains;
    const items = at(context, path) ?? [];
    return String(Array.isArray(items) && items.includes(wanted));
  }
  assert.match(expression, /^[\w.-]+$/, `not an expression this test evaluates: ${expression}`);
  const value = at(context, expression) ?? "";
  assert.ok(!Array.isArray(value), `${expression} is not a value`);
  return value;
}

/** `value` with its quotes dropped and each `${{ }}` expression evaluated in `context`. */
export const interpolate = (value: string, context: Context): string =>
  value.replace(/^"(.*)"$/, "$1").replace(/\$\{\{ (.+?) \}\}/g, (_, expression: string) => evaluate(expression, context));

/** {@link interpolate} over every value of `values`. */
export const interpolateAll = (values: Record<string, string>, context: Context): Record<string, string> =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, interpolate(value, context)]));

/** A step of a workflow job or composite action. */
export interface Step {
  id?: string;
  if?: string;
  uses?: string;
  shell?: string;
  env: Record<string, string>;
  with: Record<string, string>;
  run: string;
}

/** The step of `lines` named `name`. */
export function step(lines: string[], name: string): Step {
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `no step ${name}`);
  const body = [lines[start].replace("- name:", "  name:"), ...block(lines, start)];
  const section = (key: string): Record<string, string> => (body.some((line) => line.trim() === `${key}:`) ? mapping(keyed(body, key)) : {});
  const runLine = body.findIndex((line) => line.trim() === "run: |");
  const script = runLine === -1 ? [] : block(body, runLine);
  const run = script.map((line) => line.slice(indent(script[0]))).join("\n");
  return { id: field(body, "id"), if: field(body, "if"), uses: field(body, "uses"), shell: field(body, "shell"), env: section("env"), with: section("with"), run };
}

/** The `steps.<id>.outputs` context of `outputs`, the outputs of `step`. */
export function stepOutputs({ id }: Step, outputs: Context): Context {
  assert.ok(id, "the step has no id");
  return scope(`steps.${id}.outputs`, outputs);
}

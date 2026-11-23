import assert from "node:assert/strict";

/** A JSON object parsed from text; fails on any other JSON value. */
export function parseObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), "not a JSON object");
  return Object.fromEntries(Object.entries(value));
}

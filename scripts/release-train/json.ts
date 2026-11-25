import assert from "node:assert/strict";

/** A value JSON text can hold. */
export type Json = string | number | boolean | null | Json[] | JsonObject;

/** A JSON object. */
export interface JsonObject {
  [key: string]: Json;
}

/** Whether a JSON value is an object. */
export function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a value is a string. */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Whether a value is a number. */
export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJson);
  return typeof value === "object" && Object.values(value).every(isJson);
}

/** Parses JSON text; throws when the text is not JSON. */
export function readJson(text: string): Json {
  const value: unknown = JSON.parse(text);
  assert.ok(isJson(value), "not JSON");
  return value;
}

/** Parses JSON text, or gives null when the text is not JSON. */
export function parseJson(text: string): Json | null {
  try {
    return readJson(text);
  } catch {
    return null;
  }
}

/** A JSON object parsed from text; fails on any other JSON value. */
export function parseObject(text: string): JsonObject {
  const value = readJson(text);
  assert.ok(isJsonObject(value), "not a JSON object");
  return value;
}

/** A value of a JSON text. */
export type Json = string | number | boolean | null | Json[] | JsonObject;

/** A JSON object. A key it lacks reads `undefined`. */
export interface JsonObject {
  [key: string]: Json | undefined;
}

/** The value of a JSON text. */
export function parseJson(text: string): Json {
  // SAFETY: `JSON.parse` returns only strings, numbers, booleans, null, arrays and objects of them.
  return JSON.parse(text) as Json;
}

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isList(value: Json | undefined): value is Json[] {
  return Array.isArray(value);
}

export function isText(value: Json | undefined): value is string {
  return typeof value === "string";
}

export function isNumber(value: Json | undefined): value is number {
  return typeof value === "number";
}

export function isBoolean(value: Json | undefined): value is boolean {
  return typeof value === "boolean";
}

export function isTextOrNull(value: Json | undefined): value is string | null {
  return value === null || isText(value);
}

export function isTexts(value: Json | undefined): value is string[] {
  return isList(value) && value.every(isText);
}

/** The value when it is a string, otherwise `null`. */
export const textOf = (value: Json | undefined): string | null => (isText(value) ? value : null);

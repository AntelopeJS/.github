import { readdirSync, readFileSync } from "node:fs";

/** The UTF-8 text of a file. */
export const readText = (path: string | URL): string => readFileSync(path, "utf8");

export const listDirectory = (path: string | URL): string[] => readdirSync(path);

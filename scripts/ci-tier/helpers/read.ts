import { readFileSync } from "node:fs";

/** The UTF-8 text of a file. */
export const readText = (path: string | URL): string => readFileSync(path, "utf8");

import { readFileSync } from "node:fs";

/** The UTF-8 text of a file of this repository, given its path from the root. */
export const read = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

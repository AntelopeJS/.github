import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { rangeFloor } from "./version.ts";

describe("rangeFloor", () => {
  test("gives the lowest version a registry range admits", () => {
    const floors = {
      ">=0.11.8 <0.12.0": "0.11.8",
      ">= 0.11.11 <0.12.0": "0.11.11",
      "^1.2.3": "1.2.3",
      "~1.8": "1.8.0",
      "~>2.1.0": "2.1.0",
      "=v3.0.1": "3.0.1",
      "1.x": "1.0.0",
      ">1.2.3": "1.2.3",
      "1.2.3 - 2.0.0": "1.2.3",
      "^2.0.0 || ^1.4.0": "1.4.0",
      "0.5.0-next.12.g3f9a2c1": "0.5.0",
      "npm:@antelopejs/x@^1.0.0": "1.0.0",
      "*": "0.0.0",
      "<2.0.0": "0.0.0",
      "": "0.0.0",
    };
    assert.deepEqual(
      Object.fromEntries(Object.keys(floors).map((spec) => [spec, rangeFloor(spec)])),
      floors,
    );
  });

  test("gives null for a spec that does not resolve from the registry", () => {
    assert.deepEqual(["workspace:^", "file:../x", "latest", "npm:@antelopejs/x"].map(rangeFloor), [null, null, null, null]);
  });
});

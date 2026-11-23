import { defineConfig } from "oxlint";
import { antelopePreset } from "@antelopejs/tooling-configs/oxc/lint";

export default defineConfig({
  extends: [antelopePreset({ antiSlop: false, complexity: false })],
  jsPlugins: [{ name: "anti-slop", specifier: "@antelopejs/tooling-configs/oxc/anti-slop" }],
  rules: {
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    "typescript/no-floating-promises": [
      "error",
      { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "describe", "it", "suite"] }] },
    ],
  },
  options: { typeAware: true },
});

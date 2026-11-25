import { defineConfig } from "oxlint";
import { antelopePreset, antiSlopRules, DEFAULT_COMPLEXITY_THRESHOLDS } from "@antelopejs/tooling-configs/oxc/lint";

const { maxParams, maxLinesPerFunction, maxLines, maxDepth, complexity } = DEFAULT_COMPLEXITY_THRESHOLDS;

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
  overrides: [
    {
      files: ["scripts/release-train/**"],
      rules: {
        ...antiSlopRules(),
        "eslint/max-params": ["error", { max: maxParams }],
        "eslint/max-lines-per-function": ["error", { max: maxLinesPerFunction, skipBlankLines: true, skipComments: true }],
        "eslint/max-lines": ["error", { max: maxLines, skipBlankLines: true, skipComments: true }],
        "eslint/max-depth": ["error", { max: maxDepth }],
        "eslint/complexity": ["error", { max: complexity }],
      },
    },
  ],
  options: { typeAware: true },
});

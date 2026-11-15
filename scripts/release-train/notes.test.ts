import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { commitLevel, renderReleaseNotes, type Commit, type PackageSource, type Release } from "./plan.ts";

let count = 0;
function commit(subject: string, author = "Antony Rizzitelli", body = ""): Commit {
  count += 1;
  return { sha: count.toString(16).padStart(40, "a"), subject, author, level: commitLevel(subject, body) };
}

function release(notes: Commit[], fields: Partial<Release> = {}, source: Partial<PackageSource> = {}): Release {
  return {
    status: "release",
    source: {
      slug: "AntelopeJS/interface-database",
      directory: ".",
      branch: "main",
      head: "0".repeat(40),
      tagName: "v${version}",
      manifest: { name: "@antelopejs/interface-database", version: "0.4.1" },
      stable: "0.4.1",
      commits: [],
      notes,
      ...source,
    },
    from: "0.4.1",
    to: "0.5.0",
    level: "minor",
    reasons: [],
    ranges: {},
    kept: [],
    ...fields,
  };
}

const pull = (number: number): string => `[#${number}](https://github.com/AntelopeJS/interface-database/pull/${number})`;

describe("renderReleaseNotes", () => {
  test("renders the cycle as a changelogen section, oldest first, with breaking changes and contributors", () => {
    const guard = commit("fix: guard the empty batch", "Carol");
    const notes = [
      commit("feat(query)!: rename ReadCursor.next to ReadCursor.read (#101)"),
      commit("wip: half done"),
      commit("Update the README", "Bob"),
      commit("ci: run the checks on Windows (#94)", "renovate[bot]"),
      commit("fix(cursor): close on error", "Carol", "BREAKING CHANGE: the cursor throws"),
      guard,
      commit("feat(query): ReadCursor hands over rows in batches (#97)"),
    ];
    const ranges = { "@antelopejs/mongodb": ">=1.8.7 <1.9.0", "@antelopejs/core": ">=1.24.0 <1.25.0" };
    const closeOnError = `- **cursor:** Close on error ([${notes[4]?.sha.slice(0, 7)}](https://github.com/AntelopeJS/interface-database/commit/${notes[4]?.sha}))`;
    assert.equal(
      renderReleaseNotes(release(notes, { ranges })),
      [
        "[compare changes](https://github.com/AntelopeJS/interface-database/compare/v0.4.1...v0.5.0)",
        "",
        "### 🚀 Enhancements",
        "",
        `- **query:** ReadCursor hands over rows in batches (${pull(97)})`,
        `- **query:** Rename ReadCursor.next to ReadCursor.read (${pull(101)})`,
        "",
        "### 🩹 Fixes",
        "",
        `- Guard the empty batch ([${guard.sha.slice(0, 7)}](https://github.com/AntelopeJS/interface-database/commit/${guard.sha}))`,
        closeOnError,
        "- **deps:** Depend on the stable @antelopejs/mongodb and @antelopejs/core",
        "",
        "### 🤖 CI",
        "",
        `- Run the checks on Windows (${pull(94)})`,
        "",
        "#### ⚠️ Breaking Changes",
        "",
        closeOnError,
        `- **query:** Rename ReadCursor.next to ReadCursor.read (${pull(101)})`,
        "",
        "### ❤️ Contributors",
        "",
        "- Antony Rizzitelli",
        "- Carol",
      ].join("\n"),
    );
  });

  test("a first release has no compare line, and the tag names follow git.tagName", () => {
    const notes = [commit("docs: say how to read a feed (#3) (#4)"), commit("perf: batch the writes", "dependabot[bot]")];
    const first = renderReleaseNotes(release(notes, { from: null, to: "0.1.0" }));
    assert.equal(
      first,
      [
        "### 🔥 Performance",
        "",
        `- Batch the writes ([${notes[1]?.sha.slice(0, 7)}](https://github.com/AntelopeJS/interface-database/commit/${notes[1]?.sha}))`,
        "",
        "### 📖 Documentation",
        "",
        `- Say how to read a feed (${pull(3)}, ${pull(4)})`,
        "",
        "### ❤️ Contributors",
        "",
        "- Antony Rizzitelli",
      ].join("\n"),
    );
    const tagged = renderReleaseNotes(release([], { ranges: { "@antelopejs/x": "~0.2.0" } }, { tagName: "inner-v${version}" }));
    assert.equal(
      tagged,
      [
        "[compare changes](https://github.com/AntelopeJS/interface-database/compare/inner-v0.4.1...inner-v0.5.0)",
        "",
        "### 🩹 Fixes",
        "",
        "- **deps:** Depend on the stable @antelopejs/x",
      ].join("\n"),
    );
  });

  test("each type has its section, in changelogen's order", () => {
    const types = ["ci", "style", "test", "examples", "chore", "revert", "types", "build", "docs", "refactor", "fix", "perf", "feat"];
    const titles = renderReleaseNotes(release(types.map((type) => commit(`${type}: x (#1)`))))
      .split("\n")
      .filter((line) => line.startsWith("### "));
    assert.deepEqual(titles, [
      "### 🚀 Enhancements",
      "### 🔥 Performance",
      "### 🩹 Fixes",
      "### 💅 Refactors",
      "### 📖 Documentation",
      "### 📦 Build",
      "### 🌊 Types",
      "### ⏪ Reverts",
      "### 🏡 Chore",
      "### 🏀 Examples",
      "### ✅ Tests",
      "### 🎨 Styles",
      "### 🤖 CI",
      "### ❤️ Contributors",
    ]);
  });
});

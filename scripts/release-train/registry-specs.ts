/** Dependency specs that resolve from the registry, which a stable release may depend on. */
export const registrySpecs: readonly string[] = [
  ">=0.4.1 <0.5.0",
  "~1.8.6",
  "^2.0.0",
  "1.x",
  "*",
  "1.2.3 - 2.0.0",
  "^1.0.0 || ^2.0.0",
  ">= 1.2.3",
  "0.5.0-next.12.g3f9a2c1",
  "npm:@antelopejs/x@^1.0.0",
];

/** Dependency specs that do not resolve from the registry, which a stable release refuses. */
export const nonRegistrySpecs: readonly string[] = [
  "file:../interface-database",
  "link:../interface-database",
  "workspace:*",
  "github:AntelopeJS/interface-database#main",
  "git+https://github.com/AntelopeJS/interface-database.git",
  "https://github.com/AntelopeJS/interface-database/releases/download/v0.5.0/x.tgz",
  "AntelopeJS/interface-database",
  "../interface-database",
  "latest",
  "npm:@antelopejs/x",
];

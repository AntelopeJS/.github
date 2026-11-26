import { repositoriesOf } from "./github.ts";
import { problemsOf } from "./verdict.ts";

const org = process.argv[2] ?? "AntelopeJS";
const token = process.env.GH_TOKEN ?? "";
if (token === "") throw new Error("GH_TOKEN must hold a token that reads the repositories and their rulesets");

const report = (await repositoriesOf(org, token)).flatMap((repository) => {
  const problems = problemsOf(repository);
  return problems.length === 0 ? [] : [`- ${repository.name}`, ...problems.map((problem) => `  - ${problem}`)];
});
if (report.length > 0) {
  console.log(report.join("\n"));
  process.exitCode = 1;
}

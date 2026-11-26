import { isList, isNumber, isObject, isText, parseJson, type Json } from "../ci-metrics/json.ts";
import type { Repository, RequiredCheck } from "./verdict.ts";

const QUERY = `query($org: String!, $after: String) {
  organization(login: $org) {
    repositories(first: 50, after: $after, isArchived: false, orderBy: { field: NAME, direction: ASC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        defaultBranchRef {
          rules(first: 100) {
            nodes {
              type
              repositoryRuleset { name databaseId }
              parameters { ... on RequiredStatusChecksParameters { requiredStatusChecks { context } } }
            }
          }
        }
        workflow: object(expression: "HEAD:.github/workflows/ci.yml") { ... on Blob { text } }
      }
    }
  }
}`;

/** One page of the organization's repositories. */
export interface Page {
  readonly repositories: Repository[];
  readonly next: string | undefined;
}

const listOf = (value: Json | undefined): Json[] => (isList(value) ? value : []);
const field = (value: Json | undefined, key: string): Json | undefined => (isObject(value) ? value[key] : undefined);

function rulesetOf(rule: Json): string {
  const ruleset = field(rule, "repositoryRuleset");
  const name = field(ruleset, "name");
  const id = field(ruleset, "databaseId");
  return isText(name) && isNumber(id) ? `the ruleset "${name}" (${id})` : "a ruleset";
}

function requiredOf(rule: Json): RequiredCheck[] {
  if (field(rule, "type") !== "REQUIRED_STATUS_CHECKS") return [];
  const ruleset = rulesetOf(rule);
  return listOf(field(field(rule, "parameters"), "requiredStatusChecks")).flatMap((check) => {
    const context = field(check, "context");
    return isText(context) ? [{ context, ruleset }] : [];
  });
}

/** The repositories with a `ci.yml` on one page of the GraphQL answer, and the cursor of the next page. */
export function pageOf(answer: Json): Page {
  const errors = field(answer, "errors");
  if (errors !== undefined) throw new Error(`GraphQL answered ${JSON.stringify(errors)}`);
  const connection = field(field(field(answer, "data"), "organization"), "repositories");
  const repositories = listOf(field(connection, "nodes")).flatMap((node) => {
    const name = field(node, "name");
    const workflow = field(field(node, "workflow"), "text");
    if (!isText(name) || !isText(workflow)) return [];
    const required = listOf(field(field(field(node, "defaultBranchRef"), "rules"), "nodes")).flatMap(requiredOf);
    return [{ name, workflow, required }];
  });
  const info = field(connection, "pageInfo");
  const cursor = field(info, "endCursor");
  return { repositories, next: field(info, "hasNextPage") === true && isText(cursor) ? cursor : undefined };
}

/** Every unarchived repository of `org` with a `ci.yml`, read with `token`. */
export async function repositoriesOf(org: string, token: string): Promise<Repository[]> {
  const repositories: Repository[] = [];
  let after: string | undefined;
  do {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { org, after } }),
    });
    if (!response.ok) throw new Error(`GraphQL answered ${response.status} ${await response.text()}`);
    const page = pageOf(parseJson(await response.text()));
    repositories.push(...page.repositories);
    after = page.next;
  } while (after !== undefined);
  return repositories;
}

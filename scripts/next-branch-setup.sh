#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: scripts/next-branch-setup.sh [--apply] [--branch <name>] <owner>/<repo>

Gives a repository its rolling integration branch (default: next):
  - creates the branch from the default branch when it does not exist,
  - allows auto-merge in the repository,
  - creates or updates two repository rulesets on the branch:
    "<branch>": pull requests only, no approval, squash merges, the default
    branch's required status checks without the up-to-date requirement;
    repository admins may push.
    "<branch> history": no deletion and no force push, for everyone.

Without --apply it prints the changes it would make and changes nothing.
With --apply it makes them and prints only failures. Run it again at any time.
EOF
  exit 2
}

fail() {
  echo "$*" >&2
  exit 1
}

apply=false
branch=next
repo=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=true ;;
    --branch)
      [ $# -ge 2 ] || usage
      branch=$2
      shift
      ;;
    -h | --help) usage ;;
    -*) usage ;;
    *)
      [ -z "$repo" ] || usage
      repo=$1
      ;;
  esac
  shift
done
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || usage
[[ "$branch" =~ ^[A-Za-z0-9_][A-Za-z0-9_./-]*$ ]] || fail "Invalid branch name: ${branch}"

repo_json=$(gh api "repos/${repo}")
repo=$(jq -r '.full_name' <<< "$repo_json")
default_branch=$(jq -r '.default_branch' <<< "$repo_json")
auto_merge=$(jq -r '.allow_auto_merge' <<< "$repo_json")
case "$(jq -r '.name | ascii_downcase' <<< "$repo_json")" in
  k8s-gitops-infra | antelope-hardening | antelope-compliance)
    fail "${repo} has no ${branch} branch: each of its pull requests goes to the default branch."
    ;;
esac
[ "$branch" != "$default_branch" ] || fail "${repo}: ${branch} is the default branch."

checks=$(gh api "repos/${repo}/rules/branches/${default_branch}" --jq '
  [.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[]
    | {context, integration_id} | with_entries(select(.value != null))]
  | unique_by(.context)')
[ "$checks" != "[]" ] || fail "${repo}: ${default_branch} requires no status check, so ${branch} would merge untested pull requests."

rulesets=$(jq -n --arg branch "$branch" --argjson checks "$checks" '
  {target: "branch", enforcement: "active",
   conditions: {ref_name: {include: ["refs/heads/\($branch)"], exclude: []}}} as $base
  | [
    $base + {
      name: $branch,
      bypass_actors: [{actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always"}],
      rules: [
        {type: "pull_request", parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ["squash"]
        }},
        {type: "required_status_checks", parameters: {
          strict_required_status_checks_policy: false,
          do_not_enforce_on_create: true,
          required_status_checks: $checks
        }}
      ]
    },
    $base + {
      name: "\($branch) history",
      bypass_actors: [],
      rules: [{type: "deletion"}, {type: "non_fast_forward"}]
    }
  ]')

existing=$(gh api "repos/${repo}/rulesets?includes_parents=false&per_page=100" \
  | jq '[.[] | select(.source_type == "Repository") | {key: .name, value: .id}] | from_entries')

plan=()
actions=()

if branch_out=$(gh api "repos/${repo}/branches/${branch}" --silent 2>&1); then
  :
elif [[ "$branch_out" == *"HTTP 404"* ]]; then
  head_sha=$(gh api "repos/${repo}/git/ref/heads/${default_branch}" --jq '.object.sha')
  plan+=("create branch ${branch} at ${default_branch} (${head_sha:0:7})")
  actions+=("create-branch")
else
  fail "${repo}: ${branch_out}"
fi

if [ "$auto_merge" != true ]; then
  plan+=("allow auto-merge")
  actions+=("auto-merge")
fi

for i in $(seq $(($(jq length <<< "$rulesets") - 1)) -1 0); do
  want=$(jq ".[$i]" <<< "$rulesets")
  name=$(jq -r '.name' <<< "$want")
  id=$(jq -r --arg name "$name" '.[$name] // empty' <<< "$existing")
  if [ -z "$id" ]; then
    plan+=("create ruleset \"${name}\": $(jq -c '[.rules[].type]' <<< "$want")")
    actions+=("create-ruleset:${i}")
    continue
  fi
  matches=$(gh api "repos/${repo}/rulesets/${id}" | jq --argjson want "$want" '
    def norm: .rules |= (sort_by(.type) | map(
      if .type == "required_status_checks"
      then .parameters.required_status_checks |= sort_by(.context)
      else . end));
    def shape($w):
      if ($w | type) == "object" then
        . as $a | reduce ($w | keys[]) as $k ({}; .[$k] = ($a[$k] | shape($w[$k])))
      elif ($w | type) == "array" and ($w | length) > 0 and ($w[0] | type) == "object"
        and type == "array" and length == ($w | length) then
        . as $a | [range(0; $w | length) as $i | $a[$i] | shape($w[$i])]
      else . end;
    ($want | norm) as $w | (norm | shape($w)) == $w')
  if [ "$matches" != true ]; then
    plan+=("update ruleset \"${name}\" (${id}) to the expected rules")
    actions+=("update-ruleset:${i}:${id}")
  fi
done

if [ "$apply" = false ]; then
  if [ ${#plan[@]} -eq 0 ]; then
    echo "${repo}: up to date"
  else
    echo "${repo}: ${branch} will require $(jq -c '[.[].context]' <<< "$checks"), without the up-to-date rule"
    for step in "${plan[@]}"; do
      echo "${repo}: ${step}"
    done
  fi
  exit 0
fi

for action in ${actions[@]+"${actions[@]}"}; do
  case "$action" in
    create-branch)
      gh api -X POST "repos/${repo}/git/refs" -f "ref=refs/heads/${branch}" -f "sha=${head_sha}" --silent
      ;;
    auto-merge)
      gh api -X PATCH "repos/${repo}" -F allow_auto_merge=true --silent
      ;;
    create-ruleset:*)
      jq ".[${action#*:}]" <<< "$rulesets" | gh api -X POST "repos/${repo}/rulesets" --input - --silent
      ;;
    update-ruleset:*)
      IFS=: read -r _ i id <<< "$action"
      jq ".[${i}]" <<< "$rulesets" | gh api -X PUT "repos/${repo}/rulesets/${id}" --input - --silent
      ;;
  esac
done

#!/usr/bin/env bash

set -euo pipefail

organization="${ORGANIZATION:-AntelopeJS}"
repository="${REPOSITORY:-}"
npm_package="${NPM_PACKAGE:-false}"

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "GH_TOKEN is required" >&2
  exit 1
fi

if [[ -n "$repository" ]]; then
  repository="${repository#${organization}/}"
  if [[ ! "$repository" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "Invalid repository name: $repository" >&2
    exit 1
  fi
  repositories=("$repository")
else
  mapfile -t repositories < <(
    gh api --paginate "/orgs/${organization}/repos?type=all&per_page=100" \
      --jq '.[] | select(.archived == false) | .name'
  )
fi

apply_merge_settings() {
  local name="$1"

  gh api --method PATCH "/repos/${organization}/${name}" \
    -F allow_squash_merge=true \
    -F allow_merge_commit=false \
    -F allow_rebase_merge=false \
    -F delete_branch_on_merge=true \
    -F allow_auto_merge=true \
    --silent

  echo "Applied merge settings to ${organization}/${name}"
}

has_required_checks_rule() {
  local name="$1"
  local id
  local rule

  while read -r id; do
    rule=$(gh api "/repos/${organization}/${name}/rulesets/${id}" 2>/dev/null) || continue
    if jq -e 'any(.rules[]?; .type == "required_status_checks" and any(.parameters.required_status_checks[]?; .context == "checks"))' <<<"$rule" >/dev/null; then
      return 0
    fi
  done < <(gh api "/repos/${organization}/${name}/rulesets" --jq '.[].id')

  return 1
}

ensure_npm_ruleset() {
  local name="$1"
  local payload

  if ! gh api "/repos/${organization}/${name}/contents/.github/workflows/release.yml" --silent 2>/dev/null; then
    echo "${organization}/${name} has no release.yml workflow" >&2
    exit 1
  fi

  if has_required_checks_rule "$name"; then
    echo "${organization}/${name} already requires the checks job"
    return
  fi

  payload=$(jq -cn '{
    name: "npm release protection",
    target: "branch",
    enforcement: "active",
    bypass_actors: [{
      actor_id: 2,
      actor_type: "RepositoryRole",
      bypass_mode: "always"
    }],
    conditions: {
      ref_name: {
        exclude: [],
        include: ["~DEFAULT_BRANCH"]
      }
    },
    rules: [{
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: [{
          context: "checks",
          integration_id: 15368
        }]
      }
    }]
  }')

  gh api --method POST "/repos/${organization}/${name}/rulesets" \
    --input - --silent <<<"$payload"
  echo "Applied npm ruleset to ${organization}/${name}"
}

for name in "${repositories[@]}"; do
  apply_merge_settings "$name"
done

if [[ "$npm_package" == "true" ]]; then
  if [[ -z "$repository" ]]; then
    echo "REPOSITORY is required when NPM_PACKAGE is true" >&2
    exit 1
  fi
  ensure_npm_ruleset "$repository"
fi

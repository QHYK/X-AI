#!/usr/bin/env bash
set -Eeuo pipefail

target_commit=${1:?Expected target commit}
stage=${2:?Expected uploaded staging directory}
project=${DEPLOY_PROJECT_DIR:-/home/ubuntu/X-AI}
service=x-ai-field
health_url=http://127.0.0.1:5260/ai

[[ $target_commit =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid target commit.' >&2; exit 1; }
[[ -d $project/.git && -d $stage ]] || { echo 'Project or staging directory is missing.' >&2; exit 1; }
command -v flock >/dev/null || { echo 'flock is required for deployment locking.' >&2; exit 1; }

# This lock serializes deployments; it does not replace the separate Pipeline process check.
exec 9>"$project/.git/x-ai-deploy.lock"
flock -n 9 || { echo 'Another deployment is in progress.' >&2; exit 1; }

old_commit=
old_branch=
old_build_id=
old_build_usable=0
activation_started=0
code_changed=0
next_changed=0
needs_install=0
had_old_deps=0

check_pipeline_idle() {
  local pattern='(run-daily-workflow|run-discovery-workflow|run-discovery-worker|collect-rss|dedupe-stage1|complete-content|process-stage[1-4]|run-model-evaluation|test-discovery-provider|test-discovery-d3)\.(ts|js)|npm run (daily|discovery|collect:rss|dedupe:stage1|complete:content|process:stage[1-4]|eval:stage[1-3])'
  local status
  if pgrep -f "$pattern" >/dev/null; then
    echo 'A Daily, Discovery, Evaluation, or processing CLI is running; deployment stopped.' >&2
    return 1
  else
    status=$?
    if (( status != 1 )); then
      echo 'Cannot verify Pipeline processes with pgrep; deployment stopped.' >&2
      return 1
    fi
  fi
}

check_health() {
  local attempt
  local http_status
  for attempt in {1..12}; do
    if sudo -n systemctl is-active --quiet "$service" &&
       http_status=$(curl --silent --show-error --output /dev/null \
         --write-out '%{http_code}' --max-time 8 "$health_url") &&
       [[ $http_status =~ ^2[0-9][0-9]$ ]]; then
      return 0
    fi
    sleep 5
  done
  return 1
}

rollback() {
  local original_status=$?
  local restore_ok=1
  (( original_status != 0 )) || original_status=1
  trap - ERR INT TERM
  if (( activation_started )); then
    if (( ! old_build_usable )); then
      echo "DEPLOYMENT FAILED WITHOUT AUTOMATIC ROLLBACK: the previous build was incomplete or absent. Current source, .next, node_modules, and staging files are preserved; inspect $project and $stage for manual recovery." >&2
      exit "$original_status"
    fi
    echo "Activation failed; attempting to restore commit $old_commit and previous files." >&2
    sudo -n systemctl stop "$service" || true
    if [[ -d $stage/old-node-modules ]]; then
      if [[ -e $project/node_modules ]]; then
        mv "$project/node_modules" "$stage/failed-node-modules" || restore_ok=0
      fi
      mv "$stage/old-node-modules" "$project/node_modules" || restore_ok=0
    elif (( needs_install )) && (( ! had_old_deps )) && [[ -d $project/node_modules ]]; then
      mv "$project/node_modules" "$stage/failed-node-modules" || restore_ok=0
    fi
    if (( next_changed )); then
      if [[ -e $project/.next ]]; then
        mv "$project/.next" "$stage/failed-next" || restore_ok=0
      fi
      if [[ -d $stage/old-next ]]; then
        mv "$stage/old-next" "$project/.next" || restore_ok=0
      fi
    fi
    if (( code_changed )); then
      if ! git -C "$project" switch -C "$old_branch" "$old_commit"; then
        echo "Cannot safely restore branch $old_branch to $old_commit." >&2
        restore_ok=0
      fi
    fi
    [[ $(git -C "$project" rev-parse HEAD) == "$old_commit" &&
       $(git -C "$project" symbolic-ref -q --short HEAD) == "$old_branch" &&
       -f $project/.next/BUILD_ID &&
       $(<"$project/.next/BUILD_ID") == "$old_build_id" ]] || restore_ok=0
    if (( had_old_deps )) && [[ ! -d $project/node_modules ]]; then restore_ok=0; fi
    if (( restore_ok )) && sudo -n systemctl restart "$service" && check_health; then
      echo "Previous service restored on branch $old_branch at $old_commit." >&2
    else
      echo "AUTOMATIC ROLLBACK FAILED. Inspect $project and $stage before manual recovery." >&2
    fi
  fi
  exit "$original_status"
}
trap rollback ERR INT TERM

cd "$project"
[[ -f $project/.env.local ]] || { echo 'Server .env.local is missing; deployment stopped.' >&2; exit 1; }
[[ -z $(git status --porcelain --untracked-files=normal) ]] || {
  echo 'Server worktree has local changes or untracked files. Reconcile them manually.' >&2
  exit 1
}
old_commit=$(git rev-parse HEAD)
old_branch=$(git symbolic-ref -q --short HEAD) || {
  echo 'Server checkout is detached; reconcile the branch first.' >&2
  exit 1
}
if [[ -s $project/.next/BUILD_ID && -d $project/.next/server &&
      -d $project/.next/static && -d $project/node_modules ]]; then
  old_build_id=$(<"$project/.next/BUILD_ID")
  old_build_usable=1
else
  echo 'Previous build or dependencies are incomplete or absent; deployment may proceed, but automatic rollback will not be available.' >&2
fi
if [[ -d $project/node_modules ]]; then had_old_deps=1; fi

node "$stage/artifact.mjs" verify "$stage" "$target_commit" > "$stage/verified.json"
if [[ ${DEPLOY_TEST_MODE:-0} != 1 ]]; then
node - "$stage/verified.json" <<'NODE'
const fs = require('node:fs');
const m = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const report = process.report.getReport().header;
const tuple = (value) => String(value).split('.').map(Number);
const [hostMajor, hostMinor] = tuple(report.glibcVersionRuntime ?? '0.0');
const [buildMajor, buildMinor] = tuple(m.glibcVersion ?? '999.999');
if (process.platform !== 'linux' || m.platform !== 'linux' || process.arch !== m.arch ||
    process.versions.modules !== m.nodeAbi || hostMajor < buildMajor ||
    (hostMajor === buildMajor && hostMinor < buildMinor)) {
  throw new Error('Build host and server architecture, Node ABI, or glibc are incompatible.');
}
NODE
fi

# Fetch the fixed SHA, never a moving branch tip. A diverged or dirty checkout is not overwritten.
git fetch --no-tags origin "$target_commit"
git cat-file -e "$target_commit^{commit}"
git merge-base --is-ancestor "$old_commit" "$target_commit" || {
  echo 'Target is not a fast-forward descendant of the deployed commit.' >&2
  exit 1
}
target_lock_sha=$(git show "$target_commit:package-lock.json" | sha256sum | awk '{print $1}')
target_package_sha=$(git show "$target_commit:package.json" | sha256sum | awk '{print $1}')
read -r artifact_lock_sha artifact_package_sha < <(node - "$stage/verified.json" <<'NODE'
const m = require(process.argv[2]);
console.log(m.lockSha256, m.packageSha256);
NODE
)
[[ $target_lock_sha == "$artifact_lock_sha" && $target_package_sha == "$artifact_package_sha" ]] || {
  echo 'Uploaded package files do not match the target Git commit.' >&2
  exit 1
}

check_pipeline_idle
mkdir "$stage/extracted"
tar -xzf "$stage/next.tar.gz" -C "$stage/extracted"
[[ -f $stage/extracted/.next/BUILD_ID && -d $stage/extracted/.next/server &&
   -d $stage/extracted/.next/static ]] || { echo 'Extracted build is incomplete.' >&2; exit 1; }
[[ $(<"$stage/extracted/.next/deploy-commit") == "$target_commit" ]] || {
  echo 'Extracted build has the wrong commit marker.' >&2
  exit 1
}
expected_build_id=$(node -p 'require(process.argv[1]).buildId' "$stage/verified.json")
[[ $(<"$stage/extracted/.next/BUILD_ID") == "$expected_build_id" ]] || {
  echo 'Extracted BUILD_ID differs from the manifest.' >&2
  exit 1
}

old_lock_sha=$(git show "$old_commit:package-lock.json" | sha256sum | awk '{print $1}')
if [[ $old_lock_sha != "$target_lock_sha" || ! -d $project/node_modules ]]; then
  needs_install=1
elif [[ ${DEPLOY_TEST_MODE:-0} != 1 ]] &&
     [[ ! -f $project/node_modules/next/package.json || ! -f $project/node_modules/tsx/package.json ]]; then
  needs_install=1
else
  npm ls --include=dev --depth=0 --silent >/dev/null || {
    echo 'Existing node_modules state is uncertain; deployment stopped.' >&2
    exit 1
  }
fi
if (( needs_install )); then
  mkdir "$stage/deps"
  cp "$stage/package.json" "$stage/package-lock.json" "$stage/deps/"
  # Pipeline CLI uses tsx from devDependencies even on the production server.
  (cd "$stage/deps" && npm ci --include=dev --no-audit --no-fund)
  (cd "$stage/deps" && npm ls --include=dev --depth=0 --silent >/dev/null)
  mkdir -p "$stage/deps/node_modules"
fi

# The old application remains untouched until all validation and any dependency install finish.
check_pipeline_idle
activation_started=1
sudo -n systemctl stop "$service"
git merge --ff-only "$target_commit"
code_changed=1
[[ $(git rev-parse HEAD) == "$target_commit" ]] || { echo 'Source commit did not advance to target.' >&2; exit 1; }
next_changed=1
if [[ -d $project/.next ]]; then mv "$project/.next" "$stage/old-next"; fi
mv "$stage/extracted/.next" "$project/.next"
if (( needs_install )); then
  if [[ -d $project/node_modules ]]; then mv "$project/node_modules" "$stage/old-node-modules"; fi
  mv "$stage/deps/node_modules" "$project/node_modules"
fi
[[ $(git rev-parse HEAD) == "$target_commit" &&
   $(<"$project/.next/deploy-commit") == "$target_commit" &&
   $(<"$project/.next/BUILD_ID") == "$expected_build_id" ]] || {
  echo 'Activated source, build commit marker, or BUILD_ID does not match the target.' >&2
  exit 1
}
sudo -n systemctl restart "$service"
check_health
echo "Deployed $target_commit (BUILD_ID $expected_build_id); previous version retained in $stage."

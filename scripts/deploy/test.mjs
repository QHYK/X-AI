import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const scripts = resolve('scripts/deploy');
const root = mkdtempSync(join(tmpdir(), 'x-ai-deploy-test-'));
const remote = join(root, 'remote.git');
const source = join(root, 'source');
const project = join(root, 'project');
const stage = join(root, 'stage');
const fakeBin = join(root, 'bin');

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options }).trim();
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function commit(directory, message) {
  run('git', ['-C', directory, 'add', '.']);
  run('git', ['-C', directory, 'commit', '-m', message]);
  return run('git', ['-C', directory, 'rev-parse', 'HEAD']);
}

run('git', ['init', '--bare', remote]);
run('git', ['init', source]);
run('git', ['-C', source, 'config', 'user.email', 'deploy-test@example.invalid']);
run('git', ['-C', source, 'config', 'user.name', 'Deploy test']);
write(join(source, '.gitignore'), '.env.local\n.next/\nnode_modules/\nruntime/\nlogs/\n');
write(join(source, 'next-env.d.ts'), 'import "./.next/dev/types/routes.d.ts";\n');
write(
  join(source, 'package.json'),
  JSON.stringify({ name: 'deploy-fixture', version: '1.0.0', private: true }),
);
run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: source,
});
write(join(source, 'source.txt'), 'old\n');
const oldCommit = commit(source, 'old');
const oldBranch = run('git', ['-C', source, 'symbolic-ref', '--short', 'HEAD']);
run('git', ['-C', source, 'remote', 'add', 'origin', remote]);
run('git', ['-C', source, 'push', '-u', 'origin', 'HEAD']);
run('git', ['clone', remote, project]);
write(join(project, '.env.local'), 'FIXTURE_ONLY=true\n');
write(join(project, '.next', 'BUILD_ID'), 'old-build\n');
write(join(project, '.next', 'server', 'index.js'), 'old server\n');
write(join(project, '.next', 'static', 'index.js'), 'old static\n');
run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: project });
write(join(project, 'node_modules', 'fixture-marker'), 'old dependencies\n');

write(
  join(source, 'package.json'),
  JSON.stringify({ name: 'deploy-fixture', version: '2.0.0', private: true }),
);
run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: source,
});
write(join(source, 'source.txt'), 'new\n');
const targetCommit = commit(source, 'new');
run('git', ['-C', source, 'push', 'origin', 'HEAD']);
write(join(source, 'next-env.d.ts'), 'import "./.next/types/routes.d.ts";\n');
write(join(source, '.env.local'), 'PRIVATE_FIXTURE_VALUE=never-upload\n');
write(join(source, '.next', 'BUILD_ID'), 'new-build\n');
write(join(source, '.next', 'server', 'index.js'), 'new server\n');
write(join(source, '.next', 'static', 'index.js'), 'new static\n');
run('node', [join(scripts, 'artifact.mjs'), 'create', stage, targetCommit], { cwd: source });
run('node', [join(scripts, 'artifact.mjs'), 'verify', stage, targetCommit]);
assert.ok(
  !run('tar', ['-tzf', join(stage, 'next.tar.gz')]).includes('.env.local'),
  'server-only configuration must not enter the artifact',
);
assert.notEqual(
  spawnSync('node', [join(scripts, 'artifact.mjs'), 'verify', stage, oldCommit]).status,
  0,
  'artifact must reject a different requested commit',
);
cpSync(join(scripts, 'artifact.mjs'), join(stage, 'artifact.mjs'));
cpSync(join(scripts, 'server.sh'), join(stage, 'server.sh'));

mkdirSync(fakeBin);
write(join(fakeBin, 'flock'), '#!/bin/sh\nexit 0\n');
write(join(fakeBin, 'pgrep'), '#!/bin/sh\nexit ${DEPLOY_TEST_PIPELINE_RUNNING:-1}\n');
write(join(fakeBin, 'sleep'), '#!/bin/sh\nexit 0\n');
write(
  join(fakeBin, 'sudo'),
  `#!/bin/sh
[ "$1" = '-n' ] && shift
if [ "$1" = systemctl ]; then
  shift
  case "$1" in
    stop) printf 'stopped\\n' > "$DEPLOY_TEST_SERVICE_STATE" ;;
    restart) printf 'active\\n' > "$DEPLOY_TEST_SERVICE_STATE" ;;
    is-active) [ "$(cat "$DEPLOY_TEST_SERVICE_STATE")" = active ] || exit 1 ;;
  esac
  exit 0
fi
exit 2
`,
);
write(
  join(fakeBin, 'curl'),
  `#!/bin/sh
if [ "${'$'}{DEPLOY_TEST_FAIL_NEW_HEALTH:-0}" = 1 ] &&
   [ "$(cat "$DEPLOY_PROJECT_DIR/.next/BUILD_ID")" = "${'$'}{DEPLOY_TEST_FAIL_BUILD_ID:-new-build}" ]; then
  exit 22
fi
printf '200'
exit 0
`,
);
for (const name of ['flock', 'pgrep', 'sleep', 'sudo', 'curl']) {
  run('chmod', ['+x', join(fakeBin, name)]);
}

const environment = {
  ...process.env,
  PATH: `${fakeBin}:${process.env.PATH}`,
  DEPLOY_TEST_MODE: '1',
  DEPLOY_PROJECT_DIR: project,
  DEPLOY_TEST_SERVICE_STATE: join(root, 'service-state'),
};
write(environment.DEPLOY_TEST_SERVICE_STATE, 'active\n');

function deploy(extra = {}, commitSha = targetCommit, stagingDir = stage, projectDir = project) {
  return spawnSync('bash', [join(stagingDir, 'server.sh'), commitSha, stagingDir], {
    encoding: 'utf8',
    env: { ...environment, DEPLOY_PROJECT_DIR: projectDir, ...extra },
  });
}

const blocked = deploy({ DEPLOY_TEST_PIPELINE_RUNNING: '0' });
assert.notEqual(blocked.status, 0, 'running Pipeline must block deployment');
assert.equal(run('git', ['-C', project, 'rev-parse', 'HEAD']), oldCommit);
assert.equal(readFileSync(join(project, '.next', 'BUILD_ID'), 'utf8').trim(), 'old-build');
console.log('PASS running Pipeline prevents activation');

write(join(project, 'source.txt'), 'dirty\n');
const dirty = deploy();
assert.notEqual(dirty.status, 0, 'dirty server worktree must block deployment');
assert.equal(run('git', ['-C', project, 'rev-parse', 'HEAD']), oldCommit);
run('git', ['-C', project, 'restore', 'source.txt']);
console.log('PASS dirty worktree prevents activation');

write(join(stage, 'next.tar.gz'), 'corrupt archive');
const corrupt = deploy();
assert.notEqual(corrupt.status, 0, 'checksum mismatch must block deployment');
assert.equal(run('git', ['-C', project, 'rev-parse', 'HEAD']), oldCommit);
run('node', [join(scripts, 'artifact.mjs'), 'create', stage, targetCommit], { cwd: source });
console.log('PASS upload checksum mismatch leaves the old service untouched');

const failed = deploy({ DEPLOY_TEST_FAIL_NEW_HEALTH: '1' });
assert.notEqual(failed.status, 0, 'failed new health check must fail deployment');
assert.equal(run('git', ['-C', project, 'rev-parse', 'HEAD']), oldCommit);
assert.equal(run('git', ['-C', project, 'symbolic-ref', '--short', 'HEAD']), oldBranch);
assert.equal(readFileSync(join(project, '.next', 'BUILD_ID'), 'utf8').trim(), 'old-build');
assert.equal(
  readFileSync(join(project, 'node_modules', 'fixture-marker'), 'utf8').trim(),
  'old dependencies',
);
assert.equal(readFileSync(environment.DEPLOY_TEST_SERVICE_STATE, 'utf8').trim(), 'active');
assert.match(failed.stderr, /Previous service restored on branch/);
console.log(
  'PASS failed health check restores old branch, source, build, dependencies, and service',
);

const successStage = join(root, 'success-stage');
run('node', [join(scripts, 'artifact.mjs'), 'create', successStage, targetCommit], { cwd: source });
cpSync(join(scripts, 'artifact.mjs'), join(successStage, 'artifact.mjs'));
cpSync(join(scripts, 'server.sh'), join(successStage, 'server.sh'));
const success = deploy({}, targetCommit, successStage);
assert.equal(success.status, 0, success.stderr);
assert.equal(run('git', ['-C', project, 'rev-parse', 'HEAD']), targetCommit);
assert.equal(run('git', ['-C', project, 'symbolic-ref', '--short', 'HEAD']), oldBranch);
assert.equal(readFileSync(join(project, '.next', 'BUILD_ID'), 'utf8').trim(), 'new-build');
assert.ok(
  existsSync(join(successStage, 'old-node-modules')),
  'changed lock must preserve old dependencies',
);
console.log(
  'PASS next deployment after rollback installs dependencies and activates matching source/build',
);

write(join(source, 'source.txt'), 'newer, same dependencies\n');
const nextCommit = commit(source, 'same lock');
run('git', ['-C', source, 'push', 'origin', 'HEAD']);
write(join(source, '.next', 'BUILD_ID'), 'newer-build\n');
const sameLockStage = join(root, 'same-lock-stage');
run('node', [join(scripts, 'artifact.mjs'), 'create', sameLockStage, nextCommit], { cwd: source });
cpSync(join(scripts, 'artifact.mjs'), join(sameLockStage, 'artifact.mjs'));
cpSync(join(scripts, 'server.sh'), join(sameLockStage, 'server.sh'));
run('git', ['-C', project, 'config', 'user.email', 'deploy-test@example.invalid']);
run('git', ['-C', project, 'config', 'user.name', 'Deploy test']);
run('git', ['-C', project, 'switch', '-c', 'local-commit-test']);
write(join(project, 'source.txt'), 'independent local commit\n');
const localCommit = commit(project, 'local change');
const diverged = deploy({}, nextCommit, sameLockStage);
assert.notEqual(diverged.status, 0, 'diverged server history must block deployment');
assert.equal(run('git', ['-C', project, 'rev-parse', 'HEAD']), localCommit);
run('git', ['-C', project, 'switch', '-c', 'back-to-target', targetCommit]);
console.log('PASS commit mismatch and non-fast-forward history are rejected');
const sameLock = deploy({}, nextCommit, sameLockStage);
assert.equal(sameLock.status, 0, sameLock.stderr);
assert.equal(run('git', ['-C', project, 'rev-parse', 'HEAD']), nextCommit);
assert.equal(readFileSync(join(project, '.next', 'BUILD_ID'), 'utf8').trim(), 'newer-build');
assert.ok(!existsSync(join(sameLockStage, 'deps')), 'same lock must not run npm ci');
console.log('PASS matching lock reuses server dependencies without npm ci');

function incompleteBuildFixture(name, withOldNext = true) {
  const directory = join(root, name);
  const stagingDir = join(root, `${name}-stage`);
  run('git', ['clone', remote, directory]);
  run('git', ['-C', directory, 'switch', '-c', name, oldCommit]);
  write(join(directory, '.env.local'), 'FIXTURE_ONLY=true\n');
  if (withOldNext) {
    write(join(directory, '.next', 'server', 'index.js'), 'incomplete old server\n');
    write(join(directory, '.next', 'static', 'index.js'), 'incomplete old static\n');
  }
  write(join(directory, 'runtime', 'keep'), 'runtime remains\n');
  write(join(directory, 'logs', 'keep'), 'logs remain\n');
  run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: directory });
  write(join(directory, 'node_modules', 'fixture-marker'), 'old dependencies\n');
  run('node', [join(scripts, 'artifact.mjs'), 'create', stagingDir, nextCommit], {
    cwd: source,
  });
  cpSync(join(scripts, 'artifact.mjs'), join(stagingDir, 'artifact.mjs'));
  cpSync(join(scripts, 'server.sh'), join(stagingDir, 'server.sh'));
  return { directory, stagingDir };
}

const incompleteSuccess = incompleteBuildFixture('incomplete-success');
write(environment.DEPLOY_TEST_SERVICE_STATE, 'stopped\n');
const deployedWithoutOldBuild = deploy(
  {},
  nextCommit,
  incompleteSuccess.stagingDir,
  incompleteSuccess.directory,
);
assert.equal(deployedWithoutOldBuild.status, 0, deployedWithoutOldBuild.stderr);
assert.equal(run('git', ['-C', incompleteSuccess.directory, 'rev-parse', 'HEAD']), nextCommit);
assert.equal(
  readFileSync(join(incompleteSuccess.directory, '.next', 'deploy-commit'), 'utf8').trim(),
  nextCommit,
);
assert.equal(
  readFileSync(join(incompleteSuccess.directory, '.next', 'BUILD_ID'), 'utf8').trim(),
  'newer-build',
);
assert.equal(readFileSync(environment.DEPLOY_TEST_SERVICE_STATE, 'utf8').trim(), 'active');
assert.ok(existsSync(join(incompleteSuccess.stagingDir, 'old-next')));
for (const path of ['.env.local', 'runtime/keep', 'logs/keep']) {
  assert.ok(existsSync(join(incompleteSuccess.directory, path)), `${path} must remain`);
}
assert.match(deployedWithoutOldBuild.stderr, /automatic rollback will not be available/);
console.log(
  'PASS missing old BUILD_ID still deploys verified source/build and preserves local data',
);

const absentBuild = incompleteBuildFixture('absent-build', false);
write(environment.DEPLOY_TEST_SERVICE_STATE, 'stopped\n');
const deployedWithoutNext = deploy({}, nextCommit, absentBuild.stagingDir, absentBuild.directory);
assert.equal(deployedWithoutNext.status, 0, deployedWithoutNext.stderr);
assert.equal(
  readFileSync(join(absentBuild.directory, '.next', 'BUILD_ID'), 'utf8').trim(),
  'newer-build',
);
assert.ok(!existsSync(join(absentBuild.stagingDir, 'old-next')));
console.log('PASS absent old .next directory does not block deployment');

const incompleteFailure = incompleteBuildFixture('incomplete-failure');
write(environment.DEPLOY_TEST_SERVICE_STATE, 'stopped\n');
const failedWithoutOldBuild = deploy(
  {
    DEPLOY_TEST_FAIL_NEW_HEALTH: '1',
    DEPLOY_TEST_FAIL_BUILD_ID: 'newer-build',
  },
  nextCommit,
  incompleteFailure.stagingDir,
  incompleteFailure.directory,
);
assert.notEqual(failedWithoutOldBuild.status, 0, 'failed health check must fail deployment');
assert.equal(run('git', ['-C', incompleteFailure.directory, 'rev-parse', 'HEAD']), nextCommit);
assert.equal(
  run('git', ['-C', incompleteFailure.directory, 'symbolic-ref', '--short', 'HEAD']),
  'incomplete-failure',
);
assert.equal(
  readFileSync(join(incompleteFailure.directory, '.next', 'BUILD_ID'), 'utf8').trim(),
  'newer-build',
);
assert.ok(!existsSync(join(incompleteFailure.directory, 'node_modules', 'fixture-marker')));
assert.ok(existsSync(join(incompleteFailure.stagingDir, 'old-next')));
assert.ok(existsSync(join(incompleteFailure.stagingDir, 'old-node-modules')));
assert.equal(readFileSync(environment.DEPLOY_TEST_SERVICE_STATE, 'utf8').trim(), 'active');
assert.match(failedWithoutOldBuild.stderr, /DEPLOYMENT FAILED WITHOUT AUTOMATIC ROLLBACK/);
assert.match(failedWithoutOldBuild.stderr, /manual recovery/);
assert.doesNotMatch(failedWithoutOldBuild.stderr, /Previous service restored/);
console.log('PASS failed deploy without old BUILD_ID preserves scene and requires manual recovery');

console.log('Deployment fixture tests passed.');

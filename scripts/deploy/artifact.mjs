#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [command, directoryArgument, expectedCommit] = process.argv.slice(2);
const directory = resolve(directoryArgument ?? '');
const archive = join(directory, 'next.tar.gz');
const manifestPath = join(directory, 'manifest.json');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function requireBuildFiles(root) {
  for (const path of ['BUILD_ID', 'server', 'static']) {
    if (!existsSync(join(root, '.next', path))) {
      throw new Error(`Missing required build output: .next/${path}`);
    }
  }
}

function assertCommit(value) {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) {
    throw new Error('Expected a full 40-character Git commit SHA.');
  }
}

try {
  if (command === 'create') {
    assertCommit(expectedCommit);
    const root = process.cwd();
    const actualCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (actualCommit !== expectedCommit)
      throw new Error('Checkout does not match the requested commit.');
    const changedFiles = execFileSync('git', ['diff', '--name-only', 'HEAD'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    if (changedFiles.length > 0) {
      // Next rewrites this generated reference when switching from dev to production build.
      const committedNextEnv = execFileSync('git', ['show', 'HEAD:next-env.d.ts'], {
        encoding: 'utf8',
      });
      const generatedNextEnv = readFileSync(join(root, 'next-env.d.ts'), 'utf8');
      const expectedNextEnv = committedNextEnv.replaceAll('./.next/dev/types/', './.next/types/');
      if (
        changedFiles.length !== 1 ||
        changedFiles[0] !== 'next-env.d.ts' ||
        generatedNextEnv !== expectedNextEnv
      ) {
        throw new Error('Tracked source files changed during the build.');
      }
    }
    requireBuildFiles(root);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(root, '.next', 'deploy-commit'), `${actualCommit}\n`);
    execFileSync('tar', [
      '-czf',
      archive,
      '--exclude=.next/cache',
      '--exclude=.next/dev',
      '--exclude=.next/types',
      '--exclude=.next/diagnostics',
      '-C',
      root,
      '.next',
    ]);
    for (const name of ['package.json', 'package-lock.json']) {
      copyFileSync(join(root, name), join(directory, name));
    }
    const manifest = {
      commit: actualCommit,
      buildId: readFileSync(join(root, '.next', 'BUILD_ID'), 'utf8').trim(),
      archiveSha256: sha256(archive),
      packageSha256: sha256(join(directory, 'package.json')),
      lockSha256: sha256(join(directory, 'package-lock.json')),
      platform: process.platform,
      arch: process.arch,
      nodeAbi: process.versions.modules,
      glibcVersion: process.report?.getReport().header.glibcVersionRuntime ?? null,
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Packaged ${actualCommit} (BUILD_ID ${manifest.buildId}).`);
  } else if (command === 'verify') {
    assertCommit(expectedCommit);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.commit !== expectedCommit)
      throw new Error('Artifact commit does not match the requested commit.');
    if (sha256(archive) !== manifest.archiveSha256)
      throw new Error('Build archive checksum mismatch.');
    if (sha256(join(directory, 'package.json')) !== manifest.packageSha256)
      throw new Error('package.json checksum mismatch.');
    if (sha256(join(directory, 'package-lock.json')) !== manifest.lockSha256)
      throw new Error('package-lock.json checksum mismatch.');
    const names = execFileSync('tar', ['-tzf', archive], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    })
      .trim()
      .split('\n');
    for (const name of names) {
      const parts = name.split('/');
      if (
        parts[0] !== '.next' ||
        parts.includes('..') ||
        parts.some((part) => /^(?:\.env(?:\..*)?|runtime|logs)$/.test(part))
      ) {
        throw new Error(`Unexpected entry in build archive: ${name}`);
      }
    }
    for (const required of ['.next/BUILD_ID', '.next/deploy-commit']) {
      if (!names.includes(required)) throw new Error(`Build archive lacks ${required}.`);
    }
    console.log(JSON.stringify(manifest));
  } else {
    throw new Error('Usage: node artifact.mjs create|verify DIRECTORY COMMIT_SHA');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

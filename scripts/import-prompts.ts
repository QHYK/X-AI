import { execFileSync } from 'node:child_process';
import { getDatabasePool } from '../src/db/index.js';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';
import { buildProductionPromptSeeds } from '../src/lib/prompts/production-seeds.js';
import {
  importPromptSeeds,
  promptContentHash,
  initialPromptVersion,
} from '../src/lib/prompts/registry.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--dry-run'))
    throw new Error('Usage: npm run prompts:import -- [--dry-run]');
  // A commit label must describe the actual source text being imported.
  const changed = execFileSync(
    'git',
    [
      'status',
      '--porcelain',
      '--',
      'src/lib/prompts/production-seeds.ts',
      'src/lib/prompts/seed-baseline.json',
    ],
    { encoding: 'utf8' },
  );
  if (changed.trim()) {
    if (!args.includes('--dry-run'))
      throw new Error('Commit Prompt Seed changes before importing their baseline.');
    console.error(
      'Preview only: Seed changes are uncommitted; formal import requires a clean committed Seed.',
    );
  }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const seeds = await buildProductionPromptSeeds(commit);
  if (args.includes('--dry-run')) {
    console.log(
      JSON.stringify(
        seeds.map((seed) => ({
          key: seed.key,
          kind: seed.kind,
          sourceCommit: commit,
          version: `v${initialPromptVersion(seed.source.legacyVersion)}`,
          legacyVersion: seed.source.legacyVersion ?? null,
          contentHash: promptContentHash(seed.body),
        })),
        null,
        2,
      ),
    );
    return;
  }
  loadPipelineEnvironment();
  const pool = getDatabasePool();
  try {
    console.log(JSON.stringify(await importPromptSeeds(pool, seeds), null, 2));
  } finally {
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

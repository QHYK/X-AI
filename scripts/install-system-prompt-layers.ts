import { execFileSync } from 'node:child_process';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';
import { getDatabasePool } from '../src/db/index.js';
import { installSystemPromptLayers } from '../src/lib/prompts/registry.js';
const args = process.argv.slice(2);
if (args.length !== 1 || !['--dry-run', '--execute'].includes(args[0]))
  throw new Error('Usage: npm run prompts:system-layers -- --dry-run | --execute');
loadPipelineEnvironment();
const pool = getDatabasePool();
try {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const changes = await installSystemPromptLayers(pool, commit, args[0] === '--dry-run');
  console.log(JSON.stringify({ dryRun: args[0] === '--dry-run', changes }, null, 2));
} finally {
  await pool.end();
}

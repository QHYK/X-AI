import { Pool } from 'pg';
import {
  formatDiscoveryWorkflowReport,
  runDiscoveryWorkflow,
} from '../src/discovery/workflow-orchestrator.js';
import type { DiscoveryDailyDatePair } from '../src/discovery/daily-read-adapter.js';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';

loadPipelineEnvironment();

type Options = {
  confirmPaid: boolean;
  runId?: string;
  dailyDates?: DiscoveryDailyDatePair;
  openParentRunId?: string;
  openContext?: string;
};

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options.confirmPaid) {
    throw new Error('This command can call paid Discovery providers. Re-run with --confirm-paid.');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const report = await runDiscoveryWorkflow(pool, {
      runId: options.runId,
      dailyDates: options.dailyDates,
      openParentRunId: options.openParentRunId,
      openContext: options.openContext,
      triggerSource: 'manual',
    });
    console.log(JSON.stringify(formatDiscoveryWorkflowReport(report), null, 2));
    if (report.run.status === 'failed' || report.run.status === 'blocked') process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

function parseOptions(args: string[]): Options {
  let confirmPaid = false;
  let runId: string | undefined;
  let dailyDates: DiscoveryDailyDatePair | undefined;
  let openParentRunId: string | undefined;
  let openContext: string | undefined;
  for (const argument of args) {
    if (argument === '--confirm-paid') confirmPaid = true;
    else if (argument.startsWith('--run-id=')) runId = argument.slice('--run-id='.length);
    else if (argument.startsWith('--open-parent-run-id=')) {
      openParentRunId = argument.slice('--open-parent-run-id='.length);
    } else if (argument.startsWith('--open-context=')) {
      openContext = argument.slice('--open-context='.length).trim() || undefined;
    } else if (argument.startsWith('--dates=')) {
      const dates = argument.slice('--dates='.length).split(',');
      if (dates.length !== 2 || !dates[0] || !dates[1])
        throw new Error('--dates requires YYYY-MM-DD,YYYY-MM-DD.');
      dailyDates = [dates[0], dates[1]];
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  const modeCount =
    Number(Boolean(runId)) + Number(Boolean(dailyDates)) + Number(Boolean(openParentRunId));
  if (modeCount !== 1) {
    throw new Error(
      'Provide exactly one of --dates=YYYY-MM-DD,YYYY-MM-DD, --run-id=UUID, or --open-parent-run-id=UUID.',
    );
  }
  if (openContext && !openParentRunId)
    throw new Error('--open-context requires --open-parent-run-id.');
  return { confirmPaid, runId, dailyDates, openParentRunId, openContext };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

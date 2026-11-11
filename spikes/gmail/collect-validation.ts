/** Incremental readonly sample collection. Existing raw IDs are never downloaded again. */
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gmailAuth, saveJson } from '../../src/collectors/gmail/auth.js';
import { collect, gmailReader, errorType } from './collector.js';
import { loadPipelineEnvironment } from '../../src/lib/pipeline-env.js';
export const validationRoot = resolve('spikes/gmail/runtime/validation');
export const developmentRoot = resolve('runtime/spikes/gmail');
export async function collectValidation() {
  const { values } = parseArgs({
    options: {
      limit: { type: 'string', default: '42' },
      query: {
        type: 'string',
        default:
          'label:news-letter {from:info@theinformation.com from:hello@theinformation.com from:dailybriefing@thomsonreuters.com from:morningwire@apnews.com from:superhuman@mail.joinsuperhuman.ai from:squad@thedailyupside.com}',
      },
    },
  });
  const excluded = new Set<string>();
  const development = (await readdir(join(developmentRoot, 'raw')))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
  for (const root of [developmentRoot, validationRoot]) {
    try {
      for (const file of await readdir(join(root, 'raw')))
        if (file.endsWith('.json')) excluded.add(file.slice(0, -5));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  // Immutable membership of the original regression set, independent of future collection.
  const manifest = join(validationRoot, 'development-ids.json');
  try {
    await readFile(manifest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await saveJson(manifest, development);
  }
  loadPipelineEnvironment();
  const authorization = await gmailAuth(
    resolve(process.env.GMAIL_OAUTH_CLIENT_PATH ?? 'gmail-oauth-client.json'),
    join(developmentRoot, 'oauth-token.json'),
  );
  try {
    const report = await collect(
      gmailReader(authorization.client),
      validationRoot,
      values.query,
      Number(values.limit),
      excluded,
    );
    console.log(JSON.stringify(report, null, 2));
    if (report.listError || report.apiFailed || report.parseFailed) process.exitCode = 1;
  } finally {
    await authorization.save();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  collectValidation().catch((e) => {
    console.error(errorType(e));
    process.exitCode = 1;
  });

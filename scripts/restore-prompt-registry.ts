/** One-off recovery: replay missing objects from 0021, preserving the two verified guard functions. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import type { PoolClient } from 'pg';
import { getDatabasePool } from '../src/db/index.js';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';

const EXPECTED_HISTORY = '0b591cd436aaa7446059be0889ef79d2d72425906312ec4443b7821b28912dff';
const EXPECTED_SQL = 'c62172908bb991cc83baf965d2417d32510352a35382ec245017eee1d839684f';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
assert(
  args.every((arg) => ['--execute', '--dry-run'].includes(arg)),
  'Use --dry-run (default) or --execute.',
);
assert(!(args.includes('--execute') && args.includes('--dry-run')), 'Choose one execution mode.');
const execute = args.includes('--execute');
const migration = await readFile(
  new URL('../drizzle/0021_prompt_registry.sql', import.meta.url),
  'utf8',
);
assert.equal(hash(migration), EXPECTED_SQL, '0021 changed since the approved inspection; stopped.');
const statements = migration.split('--> statement-breakpoint').map((s) => s.trim());
assert.equal(statements.length, 7, 'Unexpected 0021 statement inventory.');
const guardStatements = statements.filter((s) => s.startsWith('CREATE FUNCTION '));
assert.equal(guardStatements.length, 2);
const guards = new Map(
  guardStatements.map((statement) => {
    const match =
      /^CREATE FUNCTION (guard_prompt_registry|guard_prompt_version)\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$([\s\S]*)\$\$;$/.exec(
        statement,
      );
    assert(match, 'Unexpected guard definition.');
    return [match[1], match[2].trim()];
  }),
);
const replay = statements.filter((s) => !s.startsWith('CREATE FUNCTION '));
assert.deepEqual(
  replay.map((s) => s.split('\n')[0]),
  [
    'CREATE TABLE prompt_registry (',
    'CREATE TABLE prompt_versions (',
    'ALTER TABLE prompt_registry ADD CONSTRAINT prompt_registry_active_same_registry_fk',
    'CREATE TRIGGER prompt_registry_guard BEFORE INSERT OR UPDATE ON prompt_registry',
    'CREATE TRIGGER prompt_version_guard BEFORE INSERT OR UPDATE OR DELETE ON prompt_versions',
  ],
);

const local = parse(await readFile(new URL('../.env.local', import.meta.url)));
loadPipelineEnvironment();
assert(
  local.DATABASE_URL && process.env.DATABASE_URL === local.DATABASE_URL,
  'Effective connection differs from the authorized .env.local; stopped.',
);
const target = new URL(local.DATABASE_URL);
assert.equal(target.hostname, 'aws-0-ap-southeast-1.pooler.supabase.com', 'Target host changed.');
assert.equal(target.port || '5432', '5432', 'Target port changed.');
assert.equal(decodeURIComponent(target.pathname.slice(1)), 'postgres', 'Target database changed.');
console.log(
  JSON.stringify(
    {
      mode: execute ? 'execute' : 'dry-run',
      target: {
        host: target.hostname,
        database: 'postgres',
        schema: 'public',
        port: target.port || '5432',
      },
      sqlFile: 'drizzle/0021_prompt_registry.sql',
      plan: replay.map((s) => s.split('\n')[0]),
      preservedFunctions: [...guards.keys()],
    },
    null,
    2,
  ),
);

async function guardSnapshot(client: PoolClient) {
  const result = await client.query(`select n.nspname as schema,p.proname,p.prosrc,
    p.pronargs,p.prorettype::regtype::text as returns,l.lanname,p.prosecdef,p.proconfig
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
    where p.proname in ('guard_prompt_registry','guard_prompt_version') order by n.nspname,p.proname,p.oid`);
  assert.equal(result.rows.length, 2, 'Missing, extra or overloaded guard functions.');
  for (const row of result.rows) {
    assert.equal(row.schema, 'public');
    assert.equal(row.pronargs, 0);
    assert.equal(row.returns, 'trigger');
    assert.equal(row.lanname, 'plpgsql');
    assert.equal(row.prosecdef, false);
    assert.equal(row.proconfig, null);
    assert.equal(row.prosrc.trim(), guards.get(row.proname), 'Guard body differs from 0021.');
  }
  return JSON.stringify(result.rows);
}
async function invariantSnapshot(client: PoolClient) {
  const history = await client.query(
    'select id,hash,created_at from drizzle.__drizzle_migrations order by created_at,id',
  );
  assert.equal(
    hash(JSON.stringify(history.rows)),
    EXPECTED_HISTORY,
    'Migration history changed since inspection.',
  );
  const stage4 = await client.query(`select a.attnum,a.atttypid::regtype::text as type,a.attnotnull,
    pg_get_expr(d.adbin,d.adrelid) as default_value
    from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where n.nspname='public' and c.relname='stage4_runs' and a.attname='prompt_versions' and not a.attisdropped`);
  assert.equal(stage4.rows.length, 1);
  assert.equal(stage4.rows[0].type, 'jsonb');
  assert.equal(stage4.rows[0].attnotnull, true);
  assert.equal(stage4.rows[0].default_value, "'{}'::jsonb");
  const check =
    await client.query(`select pg_get_constraintdef(oid) as definition from pg_constraint
    where conrelid='public.stage4_runs'::regclass and conname='stage4_runs_prompt_versions_object_check'`);
  assert.equal(check.rows.length, 1);
  assert.equal(
    check.rows[0].definition,
    "CHECK ((jsonb_typeof(prompt_versions) = 'object'::text))",
  );
  // Structural catalog only: do not scan or modify other business rows.
  const catalog =
    await client.query(`select c.oid,c.relname,c.relkind,a.attnum,a.attname,a.atttypid,a.attnotnull,
    pg_get_expr(d.adbin,d.adrelid) as default_value
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    left join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where n.nspname='public' and c.relkind in ('r','p') and c.relname not in ('prompt_registry','prompt_versions')
    order by c.oid,a.attnum`);
  const constraints =
    await client.query(`select con.oid,con.conname,pg_get_constraintdef(con.oid) as definition
    from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname not in ('prompt_registry','prompt_versions') order by con.oid`);
  return {
    history: hash(JSON.stringify(history.rows)),
    stage4: JSON.stringify([stage4.rows, check.rows]),
    businessSchema: hash(JSON.stringify([catalog.rows, constraints.rows])),
    guards: await guardSnapshot(client),
  };
}
async function preflight(client: PoolClient) {
  const identity = await client.query(
    'select current_database() as database,current_schema() as schema',
  );
  assert.deepEqual(identity.rows, [{ database: 'postgres', schema: 'public' }]);
  const names = [
    'prompt_registry',
    'prompt_versions',
    'prompt_registry_pkey',
    'prompt_versions_pkey',
    'prompt_registry_key_unique',
    'prompt_versions_registry_version_unique',
    'prompt_versions_id_registry_unique',
  ];
  const objects = await client.query(
    `select n.nspname,c.relname,c.relkind from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where c.relname=any($1::text[])`,
    [names],
  );
  assert.equal(
    objects.rows.length,
    0,
    'Prompt relation or conflicting index already exists; stopped.',
  );
  const types = await client.query(
    "select typname from pg_type where typname in ('prompt_registry','prompt_versions')",
  );
  assert.equal(types.rows.length, 0, 'Conflicting Prompt type exists.');
  const triggers =
    await client.query(`select t.tgname from pg_trigger t join pg_proc p on p.oid=t.tgfoid
    where p.proname in ('guard_prompt_registry','guard_prompt_version') and not t.tgisinternal`);
  assert.equal(triggers.rows.length, 0, 'Guard function is unexpectedly used by a Trigger.');
  const namedTriggers = await client.query(
    "select tgname from pg_trigger where tgname in ('prompt_registry_guard','prompt_version_guard')",
  );
  assert.equal(namedTriggers.rows.length, 0, 'Unexpected same-name Trigger.');
  const capability = await client.query(
    "select has_schema_privilege('public','CREATE') as can_create,to_regprocedure('gen_random_uuid()') is not null as uuid_available",
  );
  assert.equal(capability.rows[0].can_create, true);
  assert.equal(capability.rows[0].uuid_available, true);
  return invariantSnapshot(client);
}
async function verifyStructure(client: PoolClient) {
  const constraints = await client.query(`select c.relname,con.conname,con.contype,con.convalidated,
    pg_get_constraintdef(con.oid) as definition from pg_constraint con join pg_class c on c.oid=con.conrelid
    where con.conrelid in ('public.prompt_registry'::regclass,'public.prompt_versions'::regclass) order by con.conname`);
  const expected = [
    'prompt_registry_pkey',
    'prompt_registry_key_unique',
    'prompt_registry_kind_check',
    'prompt_registry_active_same_registry_fk',
    'prompt_versions_pkey',
    'prompt_versions_registry_id_fkey',
    'prompt_versions_version_check',
    'prompt_versions_status_check',
    'prompt_versions_body_check',
    'prompt_versions_content_hash_check',
    'prompt_versions_registry_version_unique',
    'prompt_versions_id_registry_unique',
  ];
  assert.deepEqual(constraints.rows.map((r) => r.conname).sort(), expected.sort());
  assert(constraints.rows.every((r) => r.convalidated));
  const indexes = await client.query(`select i.indisvalid from pg_index i
    where i.indrelid in ('public.prompt_registry'::regclass,'public.prompt_versions'::regclass)`);
  assert.equal(indexes.rows.length, 5);
  assert(indexes.rows.every((r) => r.indisvalid));
  const triggers =
    await client.query(`select t.tgname,t.tgenabled,p.proname,pg_get_triggerdef(t.oid) as definition
    from pg_trigger t join pg_proc p on p.oid=t.tgfoid where not t.tgisinternal
    and t.tgrelid in ('public.prompt_registry'::regclass,'public.prompt_versions'::regclass) order by t.tgname`);
  assert.deepEqual(
    triggers.rows.map((r) => [r.tgname, r.tgenabled, r.proname]),
    [
      ['prompt_registry_guard', 'O', 'guard_prompt_registry'],
      ['prompt_version_guard', 'O', 'guard_prompt_version'],
    ],
  );
  return {
    constraints: constraints.rows,
    triggers: triggers.rows,
    validIndexes: indexes.rows.length,
  };
}
async function verifyProtection(client: PoolClient) {
  const passed: string[] = [];
  const reject = async (name: string, sql: string, values: unknown[], message: RegExp) => {
    await client.query('savepoint expected_rejection');
    let caught = false;
    try {
      await client.query(sql, values);
    } catch (error) {
      caught = true;
      assert.match((error as Error).message, message);
    } finally {
      await client.query('rollback to savepoint expected_rejection');
      await client.query('release savepoint expected_rejection');
    }
    assert(caught, `${name}: expected rejection did not happen.`);
    passed.push(name);
  };
  await client.query('savepoint protection_validation');
  const a = randomUUID(),
    b = randomUUID(),
    published = randomUUID(),
    draft = randomUUID();
  await client.query(
    `insert into prompt_registry(id,key,kind,workflow,step,request_type,display_name)
    values ($1,'recovery.validation.a','request','recovery','validation','a','temporary'),
           ($2,'recovery.validation.b','request','recovery','validation','b','temporary')`,
    [a, b],
  );
  const body = JSON.stringify({
    systemInstructions: null,
    userTemplate: null,
    variants: {},
    fragments: [],
  });
  await client.query(
    `insert into prompt_versions(id,registry_id,version,status,body,content_hash)
    values ($1,$2,1,'published',$3::jsonb,$4),($5,$2,2,'draft',$3::jsonb,$4)`,
    [published, a, body, '0'.repeat(64), draft],
  );
  await client.query('update prompt_registry set active_version_id=$2 where id=$1', [a, published]);
  passed.push('valid Published Active accepted');
  await reject(
    'Draft Active rejected',
    'update prompt_registry set active_version_id=$2 where id=$1',
    [a, draft],
    /Active must be a published/,
  );
  await reject(
    'cross-Registry Active rejected',
    'update prompt_registry set active_version_id=$2 where id=$1',
    [b, published],
    /Active must be a published/,
  );
  await reject(
    'missing Active rejected',
    'update prompt_registry set active_version_id=$2 where id=$1',
    [a, randomUUID()],
    /Active must be a published/,
  );
  await reject(
    'Published update rejected',
    "update prompt_versions set change_note='test' where id=$1",
    [published],
    /Published prompt versions are immutable/,
  );
  await reject(
    'Published delete rejected',
    'delete from prompt_versions where id=$1',
    [published],
    /Published prompt versions are immutable/,
  );
  await reject(
    'version identity change rejected',
    'update prompt_versions set version=9 where id=$1',
    [draft],
    /Prompt version identity is immutable/,
  );
  const badBody = JSON.stringify({
    systemInstructions: null,
    userTemplate: null,
    variants: {},
    fragments: [{ slot: 'missing', versionId: randomUUID() }],
  });
  await reject(
    'invalid Fragment rejected',
    'update prompt_versions set body=$2::jsonb where id=$1',
    [draft, badBody],
    /Reference must resolve to a published fragment/,
  );
  await client.query('rollback to savepoint protection_validation');
  await client.query('release savepoint protection_validation');
  const counts = await client.query(
    'select (select count(*) from prompt_registry) as registries,(select count(*) from prompt_versions) as versions',
  );
  assert.deepEqual(
    counts.rows,
    [{ registries: '0', versions: '0' }],
    'Validation rows were not rolled back.',
  );
  return passed;
}

const pool = getDatabasePool();
let client: PoolClient | undefined;
try {
  client = await pool.connect();
  await client.query(execute ? 'begin' : 'begin read only');
  await client.query('set local search_path=public,extensions,pg_catalog');
  await client.query("set local statement_timeout='30s'");
  await client.query("set local lock_timeout='5s'");
  if (execute)
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended('prompt-registry-import',0))",
    );
  const before = await preflight(client);
  console.log(
    JSON.stringify({
      preflight: 'passed',
      migrationHistory: before.history,
      businessSchema: before.businessSchema,
    }),
  );
  if (!execute) {
    await client.query('rollback');
    console.log('DRY RUN: no SQL recovery or data import executed.');
  } else {
    for (const statement of replay) await client.query(statement);
    const structure = await verifyStructure(client);
    const protection = await verifyProtection(client);
    assert.deepEqual(
      await invariantSnapshot(client),
      before,
      'Migration history, guards or business schema changed.',
    );
    await client.query('commit');
    console.log(
      JSON.stringify(
        {
          recovery: 'committed',
          sqlStatementsExecuted: replay.length,
          structure,
          protection,
          migrationHistoryUnchanged: true,
          stage4Unchanged: true,
          businessSchemaUnchanged: true,
          validationRowsRolledBack: true,
        },
        null,
        2,
      ),
    );
  }
} catch (error) {
  if (client) await client.query('rollback').catch(() => {});
  console.error(
    JSON.stringify({
      recovery: 'stopped',
      code: (error as { code?: string }).code ?? null,
      message: (error as Error).message.replaceAll(local.DATABASE_URL, '[REDACTED]'),
    }),
  );
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}

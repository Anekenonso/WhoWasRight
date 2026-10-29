import { query, withTransaction, closeDbPool } from '../src/core/db.ts';

async function verifySecurity() {
  console.log('============================================================');
  console.log('SUPABASE RLS & PRIVILEGE VERIFICATION REPORT');
  console.log('============================================================\n');

  // 1. RLS Status After Migration
  const rlsRes = await query(`
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, n.nspname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname IN ('_migrations', 'fixture_cache')
    ORDER BY c.relname;
  `);
  console.log('1. Current RLS Status:');
  console.table(rlsRes.rows);

  // 2. Table Grants After Migration
  const grantsRes = await query(`
    SELECT grantee, table_schema, table_name, privilege_type
    FROM information_schema.role_table_grants
    WHERE table_name IN ('_migrations', 'fixture_cache')
    ORDER BY table_name, grantee, privilege_type;
  `);
  console.log('\n2. Current Table Grants:');
  console.table(grantsRes.rows);

  // 3. Verification of Anonymous Access Denial
  console.log('\n3. Verifying Anonymous (anon) Access Denial:');
  let anonMigrationsBlocked = false;
  let anonMigrationsError = '';
  try {
    await withTransaction(async (client) => {
      await client.query('SET LOCAL ROLE anon;');
      await client.query('SELECT * FROM public._migrations LIMIT 1;');
    });
  } catch (err: unknown) {
    anonMigrationsBlocked = true;
    anonMigrationsError = (err as Error).message;
  }
  console.log(`   _migrations -> Access blocked: ${anonMigrationsBlocked} (${anonMigrationsError})`);

  let anonFixtureBlocked = false;
  let anonFixtureError = '';
  try {
    await withTransaction(async (client) => {
      await client.query('SET LOCAL ROLE anon;');
      await client.query('SELECT * FROM public.fixture_cache LIMIT 1;');
    });
  } catch (err: unknown) {
    anonFixtureBlocked = true;
    anonFixtureError = (err as Error).message;
  }
  console.log(`   fixture_cache -> Access blocked: ${anonFixtureBlocked} (${anonFixtureError})`);

  // 4. Verification of Authenticated User Access Denial
  console.log('\n4. Verifying Authenticated (authenticated) Access Denial:');
  let authMigrationsBlocked = false;
  let authMigrationsError = '';
  try {
    await withTransaction(async (client) => {
      await client.query('SET LOCAL ROLE authenticated;');
      await client.query('SELECT * FROM public._migrations LIMIT 1;');
    });
  } catch (err: unknown) {
    authMigrationsBlocked = true;
    authMigrationsError = (err as Error).message;
  }
  console.log(`   _migrations -> Access blocked: ${authMigrationsBlocked} (${authMigrationsError})`);

  let authFixtureBlocked = false;
  let authFixtureError = '';
  try {
    await withTransaction(async (client) => {
      await client.query('SET LOCAL ROLE authenticated;');
      await client.query('SELECT * FROM public.fixture_cache LIMIT 1;');
    });
  } catch (err: unknown) {
    authFixtureBlocked = true;
    authFixtureError = (err as Error).message;
  }
  console.log(`   fixture_cache -> Access blocked: ${authFixtureBlocked} (${authFixtureError})`);

  // 5. Verification of Backend Operations (postgres role with BYPASSRLS)
  console.log('\n5. Verifying Backend Connection (postgres) Operations:');
  const migRows = await query('SELECT count(*)::int AS count FROM public._migrations;');
  console.log(`   Migration runner read _migrations: count=${migRows.rows[0].count}`);

  const testFixId = 999999999;
  await query(`
    INSERT INTO public.fixture_cache (api_fixture_id, data, status, kickoff_utc, expires_at)
    VALUES ($1, '{"test":true}', 'FT', NOW(), NOW() + interval '1 hour')
    ON CONFLICT (api_fixture_id) DO UPDATE SET fetched_at = NOW();
  `, [testFixId]);
  const fixRead = await query('SELECT * FROM public.fixture_cache WHERE api_fixture_id = $1;', [testFixId]);
  console.log(`   Backend read/write fixture_cache: found=${fixRead.rows.length === 1}`);
  await query('DELETE FROM public.fixture_cache WHERE api_fixture_id = $1;', [testFixId]);

  console.log('\n============================================================');
  const allChecksPassed =
    rlsRes.rows.every(r => r.relrowsecurity === true) &&
    anonMigrationsBlocked &&
    anonFixtureBlocked &&
    authMigrationsBlocked &&
    authFixtureBlocked &&
    fixRead.rows.length === 1;

  console.log(`SECURITY VERIFICATION: ${allChecksPassed ? 'ALL CHECKS PASSED' : 'FAILED'}`);
  console.log('============================================================\n');

  await closeDbPool();
  process.exitCode = allChecksPassed ? 0 : 1;
}

verifySecurity().catch(err => {
  console.error('Verification failed:', err);
  process.exitCode = 1;
});

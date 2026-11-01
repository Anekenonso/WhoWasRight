/**
 * WhoWasRight Database Migration Runner
 * Executes SQL migrations in order against DATABASE_URL.
 */

import dns from 'node:dns';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

dns.setDefaultResultOrder?.('ipv4first');

const { Client } = pg;

export async function runMigrations(dbUrl?: string): Promise<{ success: boolean; applied: string[]; tables: string[] }> {
  let connectionString = dbUrl;
  if (!connectionString) {
    if (process.argv.includes('--test')) {
      connectionString = process.env.TEST_DATABASE_URL;
      if (!connectionString) {
        throw new Error('TEST_DATABASE_URL is not set for test migrations');
      }
    } else {
      connectionString = process.env.DATABASE_URL;
    }
  }
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 30000,
  });

  await client.connect();
  const applied: string[] = [];

  try {
    // 1. Ensure migrations tracking table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // 2. Discover migration files
    const migrationsDir = 'migrations';
    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const alreadyApplied = await client.query(
        'SELECT 1 FROM _migrations WHERE name = $1',
        [file]
      );
      if (alreadyApplied.rows.length === 0) {
        console.log(`Applying migration: ${file}...`);
        const sql = readFileSync(join(migrationsDir, file), 'utf8');

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [file]);
          await client.query('COMMIT');
          applied.push(file);
          console.log(`[PASS] Applied ${file}`);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      } else {
        console.log(`[SKIP] Already applied: ${file}`);
      }
    }

    // 3. Inspect public tables
    const tableRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    const tables = tableRes.rows.map(r => r.table_name);

    return {
      success: true,
      applied,
      tables,
    };
  } finally {
    await client.end();
  }
}

// Allow direct CLI execution
if (process.argv[1]?.replace(/\\/g, '/').endsWith('migrate.ts')) {
  runMigrations()
    .then(res => {
      console.log(`\nMigration completed successfully. Public tables: ${res.tables.join(', ')}`);
      process.exitCode = 0;
    })
    .catch(err => {
      console.error('Migration failed:', err);
      process.exitCode = 1;
    });
}


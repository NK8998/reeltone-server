import { readdir, readFile } from 'node:fs/promises';
import { Database } from './db.js';

const db = new Database();
const directory = new URL('../../migrations/', import.meta.url);
try {
  const migrations = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  await db.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('reeltone_auth_schema'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map(({ name }) => name));
    for (const file of migrations) {
      if (applied.has(file)) continue;
      await client.query(await readFile(new URL(file, directory), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      console.log(`Applied ${file}`);
    }
  });
} finally {
  await db.end();
}

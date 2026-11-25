import { readdir, readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { PoolClient } from 'pg';
import { reviewsEnv } from './config.js';
import { ReviewsDatabase } from './database.js';

const directory = new URL('../../reviews/db/migrations/', import.meta.url);
const tables = {
  members: 'id user_id username email pfp_url joined_at',
  reviews: 'id user_id username pfp_url film_id film_title film_poster rating review_text is_parent parent_id like_count created_at updated_at',
  review_likes: 'id user_id review_id created_at',
  film_likes: 'id user_id film_id created_at',
  watchlist: 'id user_id film_id film_title film_poster added_at',
  watched: 'id user_id film_id film_title film_poster watched_at',
  followers: 'id follower_id followed_id followed_at',
};
const sessions = { reviews_sessions: 'token_hash profile expires_at' };
const userIds = new Set(['user_id', 'follower_id', 'followed_id']);

async function importSqlite(
  db: PoolClient, path: string, tables: Record<string, string>, marker: string,
) {
  const { rowCount } = await db.query('SELECT 1 FROM reviews_migrations WHERE name = $1', [marker]);
  if (rowCount) return;

  const { DatabaseSync } = await import('node:sqlite');
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    source.exec('BEGIN');
    const sequences = new Map<string, bigint>();
    if (source.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) {
      const sequenceRows = source.prepare('SELECT name, seq FROM sqlite_sequence');
      sequenceRows.setReadBigInts(true);
      for (const row of sequenceRows.iterate()) sequences.set(String(row.name), BigInt(row.seq as bigint));
    }
    for (const [table, fields] of Object.entries(tables)) {
      const target = await db.query(`SELECT 1 FROM ${table} LIMIT 1`);
      if (target.rowCount) throw new Error(`Cannot import SQLite into populated table ${table}`);
      const columns = fields.split(' ');
      const read = source.prepare(`SELECT ${columns.join(', ')} FROM ${table}`);
      read.setReadBigInts(true);
      const insert = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(', ')})`;
      let highestId = sequences.get(table) ?? 0n;
      let count = 0;
      for (const row of read.iterate()) {
        const values = columns.map((column) => {
          const value = row[column];
          if (value === null) return null;
          if (userIds.has(column)) return String(value);
          if (column === 'is_parent') return Boolean(value);
          return value;
        });
        await db.query(insert, values);
        if (typeof row.id === 'bigint' && row.id > highestId) highestId = row.id;
        count++;
      }
      if (highestId > 0n) await db.query(`ALTER TABLE ${table} ALTER COLUMN id RESTART WITH ${highestId + 1n}`);
      console.log(`Imported ${count} rows into ${table}`);
    }
  } finally {
    source.close();
  }
  await db.query('INSERT INTO reviews_migrations (name) VALUES ($1)', [marker]);
}

async function configuredFile(key: string) {
  const path = reviewsEnv(key);
  if (path && (await stat(path).catch(() => undefined))?.isFile()) return path;
}

const { values } = parseArgs({ options: { sqlite: { type: 'string' }, 'sqlite-sessions': { type: 'string' } } });
const legacy = values.sqlite ?? await configuredFile('REVIEWS_LEGACY_SQLITE_FILE');
const legacySessions = values['sqlite-sessions'] ?? await configuredFile('REVIEWS_LEGACY_SESSIONS_FILE');
const db = new ReviewsDatabase(true);
try {
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  await db.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(80410365)');
    await client.query('CREATE TABLE IF NOT EXISTS reviews_migrations (name text PRIMARY KEY)');
    const { rows } = await client.query<{ name: string }>('SELECT name FROM reviews_migrations');
    const applied = new Set(rows.map(({ name }) => name));
    for (const file of files) {
      if (applied.has(file)) continue;
      await client.query(await readFile(new URL(file, directory), 'utf8'));
      await client.query('INSERT INTO reviews_migrations (name) VALUES ($1)', [file]);
      console.log(`Applied ${file}`);
    }
    if (legacy) await importSqlite(client, legacy, tables, 'legacy-sqlite-reviews-v1');
    if (legacySessions) await importSqlite(client, legacySessions, sessions, 'legacy-sqlite-sessions-v1');
  });
} finally {
  await db.end();
}

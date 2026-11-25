import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import pg, { type PoolClient } from 'pg';
import { reviewsDatabaseConfig } from './config.js';

@Injectable()
export class ReviewsDatabase extends pg.Pool implements OnApplicationShutdown {
  constructor(migration = false) {
    super({
      ...reviewsDatabaseConfig(migration),
      types: {
        getTypeParser: (oid, format) =>
          oid === pg.types.builtins.INT8 && format !== 'binary' ? Number : pg.types.getTypeParser(oid, format),
      },
    });
    this.on('error', (error) => console.error('Idle Reviews database connection failed', (error as NodeJS.ErrnoException).code));
  }

  async transaction<T>(run: (connection: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  onApplicationShutdown() {
    return this.end();
  }
}

export function lockInteraction(db: PoolClient, operation: string, ...subjects: (number | string)[]) {
  const key = '[' + ['reviews', operation, ...subjects.map(String)].map((part) => JSON.stringify(part)).join(', ') + ']';
  return db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
}

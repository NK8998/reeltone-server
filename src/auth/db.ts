import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

@Injectable()
export class Database extends Pool implements OnApplicationShutdown {
  constructor() {
    super({ connectionTimeoutMillis: 5000 });
    this.on('error', () => console.error('Idle PostgreSQL connection closed'));
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async onApplicationShutdown() {
    await this.end();
  }
}

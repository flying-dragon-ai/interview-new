import { Pool } from 'pg';

/**
 * 数据库连接（PRD D2 修复）
 * 凭据只从环境变量 DATABASE_URL 读取；代码与 git 历史中不再保存任何明文凭据。
 * 迁移后 schema 见 db/migration-v0.7.sql。
 */

let pool: Pool | null = null;

function getConnectionString(): string | undefined {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  return url && url.trim() ? url.trim() : undefined;
}

export function isDatabaseConfigured(): boolean {
  return Boolean(getConnectionString());
}

export function getPool(): Pool {
  const connectionString = getConnectionString();
  if (!connectionString) {
    throw new Error('DATABASE_URL 未配置（D2：禁止硬编码数据库凭据）');
  }
  if (!pool) {
    const sslDisabled = /sslmode=disable/i.test(connectionString);
    pool = new Pool({
      connectionString,
      ...(sslDisabled ? {} : { ssl: { rejectUnauthorized: false } }),
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

/** 供 serverless 复用连接（同一实例内） */
export async function withDb<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  return fn(getPool());
}

import type { Pool } from 'pg';

/**
 * schema 漂移适配（v0.7 → v0.7.1 → v0.8 迁移共存期的统一收口）
 * 旧库未跑迁移时按表名回退；新库直连主路径。
 * 迁移全面铺开后：删除 legacy 分支即可（调用点不变）。
 */

const SCHEMA_MISS_RE = /(sessions|transcripts|reports|conversation_records|feedback_reports|ai_personas|visual_features|column|relation)/i;

/** PG「对象不存在」错误码：只有这些错误允许跳过该表（迁移未跑），其余错误必须整体回滚 */
const MISSING_RELATION_CODES = new Set(['42P01', '42703', '3F000', '3D000']);

/**
 * 判定是否为「表/列/模式不存在」类错误。
 * 驱动带 code 时用 code 判定（精确，不受错误文案影响）；无 code 时才退回文案匹配。
 * 与 isSchemaMiss 的区别：isSchemaMiss 是宽匹配（用于插入兼容回退），这里要求精确。
 */
export function isMissingRelation(e: unknown): boolean {
  const code = (e as { code?: string } | null | undefined)?.code;
  if (typeof code === 'string') return MISSING_RELATION_CODES.has(code);
  const msg = String((e as Error)?.message ?? '');
  if (/permission denied/i.test(msg)) return false;
  return /does not exist|not exist/i.test(msg);
}

/** 判定是否为 schema 缺表/缺列类错误（宽匹配：其余错误原样上抛） */
export function isSchemaMiss(e: unknown): boolean {
  return SCHEMA_MISS_RE.test(String((e as Error)?.message ?? ''));
}

/**
 * SELECT 自适应：按表优先级依次尝试，首个成功的返回；全失败抛最后一个错误。
 * build(table) 返回按该表名生成的 SQL。
 */
export async function selectAdaptive<T>(
  pool: Pool,
  tables: string[],
  build: (table: string) => { text: string; values?: unknown[] }
): Promise<T[]> {
  let lastErr: unknown;
  for (const table of tables) {
    const q = build(table);
    try {
      return (await pool.query(q.text, q.values ?? [])).rows as T[];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** 写入自适应：主路径失败且属 schema 缺失时回退 legacy 路径 */
export async function insertWithFallback<T>(
  primary: () => Promise<T>,
  legacy: () => Promise<T>,
  tables: string[]
): Promise<T> {
  try {
    return await primary();
  } catch (e) {
    if (!isSchemaMiss(e)) throw e;
    return await legacy();
  }
}

/** 会话删除级联（事务内；单表失败回滚到 savepoint 跳过，sessions 最后删） */
export async function deleteSessionCascade(pool: Pool, sessionId: number): Promise<void> {
  const tables = [
    'events',
    'reports',
    'visual_features',
    'transcripts',
    'conversation_records',
    'ai_personas',
    'feedback_reports',
  ];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of tables) {
      const sp = `del_${table}`;
      await client.query(`SAVEPOINT ${sp}`);
      try {
        await client.query(`DELETE FROM ${table} WHERE session_id = $1`, [sessionId]);
      } catch (e) {
        // 只有「表/列不存在」才跳过该表；权限、锁、约束、外键等错误必须整体回滚，
        // 否则会删掉 sessions 行却留下子表数据（TC-11 隐私红线：不可恢复、无残留）
        if (!isMissingRelation(e)) throw e;
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); // 表不存在：跳过该表
      } finally {
        await client.query(`RELEASE SAVEPOINT ${sp}`).catch(() => undefined);
      }
    }
    await client.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** 会话创建自适应：v0.8(format) → v0.7.1(钱包) → v0.7(无钱包) → legacy 旧表 */
export async function insertSessionAdaptive(
  pool: Pool,
  params: {
    company: string;
    job_title: string;
    topic: string;
    topicType: string;
    roles: Array<{ id: string; name: string; persona: { conflict_level: string; legacy_personality?: string; speaking_style: string } }>;
    voiceEnabled: boolean;
    cameraEnabled: boolean;
    userId: number | null;
    walletAddress: string | null;
    format: string;
  }
): Promise<any> {
  const p = params;
  const base = [p.company, p.job_title, p.topic, p.topicType, JSON.stringify(p.roles), p.voiceEnabled, p.cameraEnabled, p.userId];

  const insertV08 = () =>
    pool.query(
      `INSERT INTO sessions (company, job_title, topic, topic_type, roles, voice_enabled, camera_enabled, status, user_id, wallet_address, format, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'DISCUSSING', $8, $9, $10, NOW()) RETURNING *`,
      [...base, p.walletAddress, p.format]
    );
  const insertV071 = (withWallet: boolean) =>
    withWallet
      ? pool.query(
          `INSERT INTO sessions (company, job_title, topic, topic_type, roles, voice_enabled, camera_enabled, status, user_id, wallet_address, started_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'DISCUSSING', $8, $9, NOW()) RETURNING *`,
          [...base, p.walletAddress]
        )
      : pool.query(
          `INSERT INTO sessions (company, job_title, topic, topic_type, roles, voice_enabled, camera_enabled, status, user_id, started_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'DISCUSSING', $8, NOW()) RETURNING *`,
          base
        );
  const insertLegacy = async () => {
    // 兼容：迁移尚未执行时退回旧 schema（simulation_sessions + ai_personas）
    const legacy = await pool.query(
      `INSERT INTO simulation_sessions (company, job_title, topic, status, user_id) VALUES ($1, $2, $3, 'DISCUSSING', $4) RETURNING *`,
      [p.company, p.job_title, p.topic, p.userId]
    );
    const row = legacy.rows[0];
    for (const card of p.roles) {
      await pool
        .query(
          `INSERT INTO ai_personas (session_id, character_id, name, role, personality, color) VALUES ($1, $2, $3, $4, $5, $6)`,
          [row.id, card.id, card.name, card.persona.conflict_level, card.persona.legacy_personality ?? card.persona.speaking_style, 'bg-slate-500']
        )
        .catch(() => undefined);
    }
    return row;
  };
  try {
    return (await insertV08()).rows[0];
  } catch (err0) {
    if (!isSchemaMiss(err0)) throw err0;
    try {
      return (await insertV071(true)).rows[0];
    } catch (err1) {
      if (!isSchemaMiss(err1)) throw err1;
      if (!/wallet_address/i.test(String((err1 as Error)?.message ?? ''))) {
        // 缺的是其他新列 → v0.7 之前的旧库，直接回退旧表
        return insertLegacy();
      }
      try {
        // 仅缺 wallet_address → v0.7 库未跑 v0.7.1 迁移，去掉钱包列重试
        return (await insertV071(false)).rows[0];
      } catch (err2) {
        if (!isSchemaMiss(err2)) throw err2;
        return insertLegacy();
      }
    }
  }
}

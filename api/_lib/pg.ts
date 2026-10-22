/**
 * 参数化批量 INSERT 构造（api/events.ts / api/sessions/[id]/visual.ts 共用）
 * 生成 `INSERT INTO t (c1, c2) VALUES ($1, $2), ($3, $4)...`，值按行展平。
 */

export function buildBatchInsert(
  table: string,
  columns: string[],
  rows: unknown[][]
): { text: string; values: unknown[] } {
  if (rows.length === 0) throw new Error('buildBatchInsert: rows 为空');
  const colCount = columns.length;
  const values = rows
    .map((_, i) => `(${Array.from({ length: colCount }, (_, j) => `$${i * colCount + j + 1}`).join(', ')})`)
    .join(', ');
  return {
    text: `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${values}`,
    values: rows.flat(),
  };
}

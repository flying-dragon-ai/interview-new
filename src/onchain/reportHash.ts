import { keccak256, toHex } from 'viem';

/**
 * 报告哈希（reportHash）计算 —— 链上存证的承诺值。
 *
 * 与合约侧约定：reportHash = keccak256( UTF-8( canonicalJSON(payload) ) )。
 * canonicalJSON 规范：
 *   - 对象键按码点字典序递归排序（与插入顺序无关）；
 *   - 数组保持原有顺序；
 *   - undefined / 函数按 JSON 语义丢弃，null 保留；
 *   - 无空白符；字符串走 JSON 转义。
 * 任何人拿到同一份报告 + 铸造者地址即可复算哈希，在链上 verifyReport 验真。
 */

export const CERT_PAYLOAD_VERSION = 1 as const;
export const CERT_APP_ID = 'lgd-interview-simulator' as const;

export interface CertPayload {
  v: typeof CERT_PAYLOAD_VERSION;
  app: typeof CERT_APP_ID;
  /** 铸造者地址（小写归一）——把证书与本人绑定，防止他人抢注同内容报告 */
  minter: string;
  /** 完整 ReportV15 对象（内含 session_id；本地模式为 null） */
  report: unknown;
}

export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (t === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined && typeof record[k] !== 'function')
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(',')}}`;
  }
  // symbol / function 等不可序列化类型按 JSON 语义降级为 null
  return 'null';
}

export function buildReportHash(payload: CertPayload): `0x${string}` {
  return keccak256(toHex(canonicalize(payload)));
}

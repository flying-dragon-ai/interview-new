/**
 * 服务端钱包工具（Q-N1：免登录用户标识 = Para 钱包地址）
 * 前端副本见 src/wallet/config.ts（保持两处正则一致）。
 */

export const WALLET_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const isWalletAddress = (value: unknown): value is string =>
  typeof value === 'string' && WALLET_ADDRESS_RE.test(value);

/** 归一化：小写；非法输入返回 null（由调用方决定 400 还是忽略） */
export function normalizeWalletAddress(value: unknown): string | null {
  if (!isWalletAddress(value)) return null;
  return value.toLowerCase();
}

import { isEvmAddress, normalizeAddress } from './config.ts';

/**
 * 钱包身份推导（纯函数，可单测）
 *
 * Para useAccount() 同时给出嵌入式 MPC 钱包（邮箱/社交登录）与外部钱包
 * （MetaMask 等，wagmi useAccount 结果）。取址优先级：
 *   1. 嵌入式 EVM 钱包（Q-N1：免登录用户的稳定标识，跨设备一致）
 *   2. 嵌入式任意链钱包中带 EVM 地址者（兜底）
 *   3. 外部 EVM 钱包地址
 *   4. 都没有 → null（匿名模式，与现状一致）
 */

export interface WalletLike {
  type?: string;
  address?: string | null;
}

export interface ParaAccountLike {
  isConnected?: boolean;
  embedded?: {
    isConnected?: boolean;
    wallets?: WalletLike[] | Record<string, WalletLike> | null;
  } | null;
  external?: {
    evm?: { address?: string | null } | null;
  } | null;
}

export interface DerivedIdentity {
  address: string | null;
  source: 'embedded' | 'external' | null;
}

function walletList(
  wallets: WalletLike[] | Record<string, WalletLike> | null | undefined
): WalletLike[] {
  if (!wallets) return [];
  if (Array.isArray(wallets)) return wallets;
  return Object.values(wallets);
}
export function deriveIdentity(account: ParaAccountLike | null | undefined): DerivedIdentity {
  if (!account) return { address: null, source: null };

  // 1-2. 嵌入式钱包（仅在嵌入侧已连接时取址）
  if (account.embedded?.isConnected) {
    const wallets = walletList(account.embedded.wallets);
    const evm = wallets.find((w) => (w.type ?? '').toUpperCase() === 'EVM' && isEvmAddress(w.address));
    const fallback = wallets.find((w) => isEvmAddress(w.address));
    const address = evm?.address ?? fallback?.address;
    if (address) return { address: normalizeAddress(address), source: 'embedded' };
  }

  // 3. 外部钱包（wagmi useAccount 的 address 字段）
  const external = account.external?.evm?.address;
  if (isEvmAddress(external)) return { address: normalizeAddress(external), source: 'external' };

  return { address: null, source: null };
}

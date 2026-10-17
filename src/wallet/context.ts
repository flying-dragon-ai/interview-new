import { createContext, useContext } from 'react';

/**
 * 钱包身份上下文（应用侧统一入口）
 *
 * 组件只依赖本上下文，不直接触碰 Para SDK hooks ——
 * 未配置 VITE_PARA_API_KEY 时 provider 退化为匿名实现，组件零改动可用。
 */

export interface WalletIdentity {
  /** Para 是否已配置（未配置时整个钱包 UI 不渲染） */
  configured: boolean;
  isConnected: boolean;
  isLoading: boolean;
  /** 归一化小写 EVM 地址；未连接为 null */
  address: string | null;
  source: 'embedded' | 'external' | null;
  /** 打开 Para 连接弹窗（未配置时为 no-op） */
  connect: () => void;
  /** 断开 / 登出（未配置时为 no-op） */
  disconnect: () => void;
}

export const anonymousIdentity: WalletIdentity = {
  configured: false,
  isConnected: false,
  isLoading: false,
  address: null,
  source: null,
  connect: () => undefined,
  disconnect: () => undefined,
};

export const WalletIdentityContext = createContext<WalletIdentity>(anonymousIdentity);

export const useWalletIdentity = (): WalletIdentity => useContext(WalletIdentityContext);

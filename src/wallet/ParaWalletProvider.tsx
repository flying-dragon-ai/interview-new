import { Suspense, lazy, type ReactNode } from 'react';
import { isParaConfigured } from './config';
import { WalletIdentityContext, anonymousIdentity } from './context';

/**
 * 钱包 provider 外层（轻量，不引入 Para SDK）
 *
 * - 已配置 VITE_PARA_API_KEY：懒加载 Inner（SDK + wagmi 单独 chunk，
 *   未配置时主 bundle 零增量）。
 * - 未配置：匿名上下文，应用保持免登录可用（降级路径与现状一致）。
 */

const LazyInner = lazy(() => import('./ParaWalletProviderInner'));
const LazyInjected = lazy(() => import('./InjectedWalletProvider'));

export function ParaWalletProvider({ children }: { children: ReactNode }) {
  if (!isParaConfigured()) {
    return (
      <Suspense fallback={<WalletIdentityContext.Provider value={{ ...anonymousIdentity, configured: true, isLoading: true }}>{children}</WalletIdentityContext.Provider>}>
        <LazyInjected>{children}</LazyInjected>
      </Suspense>
    );
  }
  return (
    <Suspense
      fallback={
        <WalletIdentityContext.Provider value={{ ...anonymousIdentity, configured: true, isLoading: true }}>
          {children}
        </WalletIdentityContext.Provider>
      }
    >
      <LazyInner>{children}</LazyInner>
    </Suspense>
  );
}

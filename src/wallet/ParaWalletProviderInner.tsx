import { useMemo, type ReactNode } from 'react';
import '@getpara/react-sdk/styles.css';
import { Environment, ParaProvider, useAccount, useLogout, useModal } from '@getpara/react-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http } from 'wagmi';
import { monad, monadTestnet } from 'wagmi/chains';
import { PARA_API_KEY } from './config';
import { deriveIdentity, type ParaAccountLike } from './identity';
import { WalletIdentityContext, type WalletIdentity } from './context';

/**
 * Para provider（懒加载内层，仅在 VITE_PARA_API_KEY 配置后进入 bundle chunk）
 *
 * Monad 接线按 monskill references/para-monad-wiring.md：
 * - chains 首位即用户默认链 → Monad Testnet（10143，本期目标网络）；
 * - 不传 defaultChain prop（v2/v3 均无此 prop）；
 * - 链对象直接用 wagmi/chains 导出的 monad / monadTestnet，不手写。
 */

const queryClient = new QueryClient();

function IdentityBridge({ children }: { children: ReactNode }) {
  const account = useAccount();
  const { openModal } = useModal();
  const { logout } = useLogout();

  const identity = useMemo(() => deriveIdentity(account as ParaAccountLike), [account]);

  const value = useMemo<WalletIdentity>(
    () => ({
      configured: true,
      isConnected: account.isConnected,
      isLoading: account.isLoading,
      address: identity.address,
      source: identity.source,
      connect: () => openModal(),
      disconnect: () => logout(),
    }),
    [account.isConnected, account.isLoading, identity.address, identity.source, openModal, logout]
  );

  return <WalletIdentityContext.Provider value={value}>{children}</WalletIdentityContext.Provider>;
}

export default function ParaWalletProviderInner({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ParaProvider
        paraClientConfig={{
          apiKey: PARA_API_KEY,
          env: Environment.BETA, // 上线切 Environment.PRODUCTION（见 docs/monad-wallet.md）
        }}
        config={{ appName: 'LGD 群面模拟器' }}
        paraModalConfig={{
          // 留空数组 = 隐藏全部社交登录；此处开启常用 IDP
          oAuthMethods: ['GOOGLE', 'APPLE', 'DISCORD', 'TWITTER'],
          disablePhoneLogin: false,
          recoverySecretStepEnabled: true,
        }}
        externalWalletConfig={{
          evmConnector: {
            config: {
              // 数组首位 = 连接时默认链：Monad Testnet
              chains: [monadTestnet, monad],
              transports: {
                [monadTestnet.id]: http('https://testnet-rpc.monad.xyz'),
                [monad.id]: http('https://rpc.monad.xyz'),
              },
            },
          },
          wallets: ['METAMASK', 'COINBASE', 'WALLETCONNECT', 'RAINBOW', 'ZERION', 'RABBY'],
        }}
      >
        <IdentityBridge>{children}</IdentityBridge>
      </ParaProvider>
    </QueryClientProvider>
  );
}

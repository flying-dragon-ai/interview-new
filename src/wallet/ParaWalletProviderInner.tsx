import { useMemo, type ReactNode } from 'react';
import '@getpara/react-sdk/styles.css';
import { Environment, ParaProvider, useAccount, useLogout, useModal } from '@getpara/react-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, useSwitchChain, useWalletClient, useConfig } from 'wagmi';
import { getWalletClient, waitForTransactionReceipt } from 'wagmi/actions';
import { decodeEventLog } from 'viem';
import { monad, monadTestnet } from 'wagmi/chains';
import { PARA_API_KEY } from './config';
import { deriveIdentity, type ParaAccountLike } from './identity';
import { WalletIdentityContext, type WalletIdentity } from './context';
import { INTERVIEW_CREDENTIAL_ABI, INTERVIEW_CREDENTIAL_ADDRESS, MONAD_TESTNET_CHAIN_ID } from '../onchain/config';

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
  const { data: walletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();
  const wagmiConfig = useConfig();

  const identity = useMemo(() => deriveIdentity(account as ParaAccountLike), [account]);

  const value = useMemo<WalletIdentity>(
    () => ({
      configured: true,
      isConnected: account.isConnected,
      isLoading: account.isLoading,
      address: identity.address,
      chainId: walletClient?.chain?.id ?? null,
      source: identity.source,
      connect: () => openModal(),
      disconnect: () => logout(),
      switchToMonadTestnet: async () => {
        await switchChainAsync({ chainId: MONAD_TESTNET_CHAIN_ID });
      },
      issueCredential: async ({ sessionHash, scoreHash, overallScore, skillHashes }) => {
        if (!identity.address) throw new Error('请先连接钱包');
        if (!INTERVIEW_CREDENTIAL_ADDRESS) throw new Error('尚未配置 InterviewCredential 合约地址');
        let signer = walletClient;
        if (!signer || signer.chain?.id !== MONAD_TESTNET_CHAIN_ID) {
          await switchChainAsync({ chainId: MONAD_TESTNET_CHAIN_ID });
          signer = await getWalletClient(wagmiConfig, { chainId: MONAD_TESTNET_CHAIN_ID });
        }
        const txHash = await signer.writeContract({
          address: INTERVIEW_CREDENTIAL_ADDRESS,
          abi: INTERVIEW_CREDENTIAL_ABI,
          functionName: 'issueCredential',
          args: [sessionHash, scoreHash, overallScore, skillHashes],
          account: identity.address as `0x${string}`,
          chain: monadTestnet,
        });
        const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: txHash });
        if (receipt.status !== 'success') throw new Error('交易已上链但执行失败');
        let tokenId: string | null = null;
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() !== INTERVIEW_CREDENTIAL_ADDRESS.toLowerCase()) continue;
          try {
            const decoded = decodeEventLog({ abi: INTERVIEW_CREDENTIAL_ABI, eventName: 'CredentialMinted', data: log.data, topics: log.topics });
            tokenId = decoded.args.tokenId.toString();
            break;
          } catch { /* other contract event */ }
        }
        return { txHash, tokenId };
      },
    }),
    [account.isConnected, account.isLoading, identity.address, identity.source, openModal, logout, walletClient, switchChainAsync, wagmiConfig]
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

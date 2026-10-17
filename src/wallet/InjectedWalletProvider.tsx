import { useMemo, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http, injected, useAccount, useConnect, useConfig, useDisconnect, useSwitchChain, useWalletClient } from 'wagmi';
import { monad, monadTestnet } from 'wagmi/chains';
import { decodeEventLog } from 'viem';
import { getWalletClient, waitForTransactionReceipt } from 'wagmi/actions';
import { WalletIdentityContext, type WalletIdentity } from './context';
import { normalizeAddress } from './config';
import { INTERVIEW_CREDENTIAL_ABI, INTERVIEW_CREDENTIAL_ADDRESS, MONAD_TESTNET_CHAIN_ID } from '../onchain/config';

const config = createConfig({
  chains: [monadTestnet, monad],
  connectors: [injected()],
  transports: {
    [monadTestnet.id]: http('https://testnet-rpc.monad.xyz'),
    [monad.id]: http('https://rpc.monad.xyz'),
  },
});
const queryClient = new QueryClient();

function InjectedIdentityBridge({ children }: { children: ReactNode }) {
  const account = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();
  const { data: walletClient } = useWalletClient();
  const wagmiConfig = useConfig();
  const address = account.address ? normalizeAddress(account.address) : null;

  const value = useMemo<WalletIdentity>(() => ({
    configured: true,
    isConnected: account.isConnected && Boolean(address),
    isLoading: account.isConnecting || account.isReconnecting,
    address,
    chainId: account.chainId ?? walletClient?.chain?.id ?? null,
    source: address ? 'external' : null,
    connect: async () => {
      const connector = connectors[0];
      if (!connector) throw new Error('未找到浏览器钱包连接器，请安装 MetaMask 或兼容钱包。');
      await connectAsync({ connector, chainId: MONAD_TESTNET_CHAIN_ID });
    },
    disconnect: () => disconnect(),
    switchToMonadTestnet: async () => {
      await switchChainAsync({ chainId: MONAD_TESTNET_CHAIN_ID });
    },
    issueCredential: async ({ sessionHash, scoreHash, overallScore, skillHashes }) => {
      if (!address) throw new Error('请先连接浏览器钱包');
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
        account: address as `0x${string}`,
        chain: monadTestnet,
      });
      const receipt = await waitForTransactionReceipt(wagmiConfig, { hash: txHash });
      if (receipt.status !== 'success') throw new Error('交易已上链但执行失败');
      let tokenId: string | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== INTERVIEW_CREDENTIAL_ADDRESS.toLowerCase()) continue;
        try {
          const event = decodeEventLog({ abi: INTERVIEW_CREDENTIAL_ABI, eventName: 'CredentialMinted', data: log.data, topics: log.topics });
          tokenId = event.args.tokenId.toString();
          break;
        } catch { /* ignore unrelated contract events */ }
      }
      return { txHash, tokenId };
    },
  }), [account.address, account.chainId, account.isConnected, account.isConnecting, account.isReconnecting, address, connectors, connectAsync, disconnect, switchChainAsync, walletClient, wagmiConfig]);

  return <WalletIdentityContext.Provider value={value}>{children}</WalletIdentityContext.Provider>;
}

export default function InjectedWalletProvider({ children }: { children: ReactNode }) {
  return <WagmiProvider config={config}><QueryClientProvider client={queryClient}><InjectedIdentityBridge>{children}</InjectedIdentityBridge></QueryClientProvider></WagmiProvider>;
}

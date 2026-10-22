import { isEvmAddress } from '../wallet/config.ts';

/**
 * 链上证书配置（InterviewCertificate soulbound NFT，Monad Testnet）
 *
 * 与钱包层同 pattern：未配置 VITE_CERT_ADDRESS 时铸证 UI 不渲染，
 * 应用行为与现状一致（证书是可选增强，不阻断报告流程）。
 * 部署/验证/索引器全流程见 docs/monad-onchain.md。
 */

export const CERT_ADDRESS = ((import.meta as any).env?.VITE_CERT_ADDRESS ?? '').trim();

/** Envio HyperIndex 托管 GraphQL（indexer 部署到 Envio Cloud 后填入） */
export const ENVIO_GRAPHQL_URL = ((import.meta as any).env?.VITE_ENVIO_GRAPHQL_URL ?? '').trim();

export const MONAD_TESTNET_CHAIN_ID = 10143;
export const MONAD_EXPLORER = 'https://testnet.monadexplorer.com';
export const MONAD_FAUCET_URL = 'https://faucet.monad.xyz';

export const isCertConfigured = (): boolean => isEvmAddress(CERT_ADDRESS);
export const isEnvioConfigured = (): boolean => ENVIO_GRAPHQL_URL.length > 0;

export const explorerTxUrl = (txHash: string): string => `${MONAD_EXPLORER}/tx/${txHash}`;
export const explorerContractUrl = (): string => `${MONAD_EXPLORER}/address/${CERT_ADDRESS}`;

/**
 * mintCertificate gas limit 兜底值。
 * forge 实测：首次铸造（冷存储）113,337 / 重复铸造 102,008（以太坊定价）。
 * Monad 冷 SSTORE 贵 ~4x（gas skill），正常路径用 estimateGas + 10% buffer，
 * 仅在估算失败时回落到本常量。
 */
export const MINT_GAS_FALLBACK = 200_000n;

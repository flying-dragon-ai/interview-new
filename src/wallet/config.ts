/**
 * Para / Monad 钱包配置（monskill wallet-integration）
 *
 * - 公开 API key 走 VITE_PARA_API_KEY（Para public key 可上前端；
 *   secret key 永不入前端，见 skill 秘钥规范）。
 * - 未配置 key 时应用保持免登录匿名可用：钱包是可选增强（Q-N1 用户标识），
 *   不阻断群面主流程。
 */

export const PARA_API_KEY = ((import.meta as any).env?.VITE_PARA_API_KEY ?? '').trim();

export const isParaConfigured = (): boolean => PARA_API_KEY.length > 0;

/** EVM 地址格式校验（42 字符 0x 前缀十六进制） */
export const WALLET_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const isEvmAddress = (value: unknown): value is string =>
  typeof value === 'string' && WALLET_ADDRESS_RE.test(value);

/** 统一小写归一，便于入库与比较 */
export const normalizeAddress = (address: string): string => address.toLowerCase();

/** 导航栏展示：0x1234…abcd */
export const shortAddress = (address: string): string =>
  address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

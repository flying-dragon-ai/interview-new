export const MONAD_TESTNET_CHAIN_ID = 10143;
export const MONAD_TESTNET_RPC = 'https://testnet-rpc.monad.xyz';
export const MONAD_TESTNET_EXPLORER = 'https://testnet.monadscan.com';

const candidate = ((import.meta as any).env?.VITE_INTERVIEW_CREDENTIAL_ADDRESS ?? '').trim();
export const INTERVIEW_CREDENTIAL_ADDRESS = /^0x[0-9a-fA-F]{40}$/.test(candidate)
  ? (candidate as `0x${string}`)
  : null;

export const INTERVIEW_CREDENTIAL_ABI = [
  {
    type: 'function',
    name: 'issueCredential',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'sessionHash', type: 'bytes32' },
      { name: 'scoreHash', type: 'bytes32' },
      { name: 'overallScore', type: 'uint16' },
      { name: 'skillHashes', type: 'bytes32[]' },
    ],
    outputs: [
      { name: 'assessmentId', type: 'bytes32' },
      { name: 'tokenId', type: 'uint256' },
    ],
  },
  {
    type: 'event',
    name: 'CredentialMinted',
    anonymous: false,
    inputs: [
      { indexed: true, name: 'assessmentId', type: 'bytes32' },
      { indexed: true, name: 'recipient', type: 'address' },
      { indexed: true, name: 'tokenId', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'assessmentByToken',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: 'assessmentId', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'assessments',
    stateMutability: 'view',
    inputs: [{ name: 'assessmentId', type: 'bytes32' }],
    outputs: [
      { name: 'sessionHash', type: 'bytes32' },
      { name: 'scoreHash', type: 'bytes32' },
      { name: 'overallScore', type: 'uint16' },
      { name: 'createdAt', type: 'uint64' },
      { name: 'assessor', type: 'address' },
      { name: 'credentialMinted', type: 'bool' },
    ],
  },
] as const;

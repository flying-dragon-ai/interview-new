/**
 * InterviewCertificate 最小 ABI（前端只用到读价/查重/铸造四个入口）。
 * 完整合约见 contracts/src/InterviewCertificate.sol；
 * 与合约的字段级一致性由 tests/onchain-certificate.test.ts 静态看守。
 */
export const interviewCertificateAbi = [
  {
    type: 'function',
    name: 'mintCertificate',
    stateMutability: 'payable',
    inputs: [{ name: 'reportHash', type: 'bytes32' }],
    outputs: [{ name: 'tokenId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'mintPrice',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'certificateOfReport',
    stateMutability: 'view',
    inputs: [{ name: 'reportHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'verifyReport',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'reportHash', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'CertificateMinted',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'reportHash', type: 'bytes32', indexed: true },
      { name: 'paidAmount', type: 'uint256', indexed: false },
    ],
  },
] as const;

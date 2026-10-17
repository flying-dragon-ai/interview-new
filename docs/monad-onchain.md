# Monad 链上证书（InterviewCertificate）——部署 / 验证 / 索引器 / 前端接线 runbook

按 monskills（scaffold → gas → addresses → indexer → wallet）落地。目标网络：**Monad Testnet（chainId 10143）**。

架构链路：

```
EvidenceReport（报告页）
  → src/onchain/reportHash.ts  规范化 JSON → keccak256（reportHash）
  → CertificateSection.tsx     estimateGas+10% → mintCertificate(reportHash) payable
  → InterviewCertificate.sol   soulbound ERC-721，发 CertificateMinted 事件
  → indexer/（Envio HyperIndex）索引事件 → Envio Cloud Hasura GraphQL
  → CertificateSection.tsx     "我的链上证书"列表（VITE_ENVIO_GRAPHQL_URL）
```

## 已交付（代码侧）

| 模块 | 文件 | 说明 |
|---|---|---|
| 合约 | `contracts/src/InterviewCertificate.sol` | soulbound ERC-721（LGDCERT），付费铸造、一报告一证、owner 调价/换金库、withdraw 归集 |
| 测试 | `contracts/test/InterviewCertificate.t.sol` | 15 用例全绿：付费/欠费/重复/转让 revert/事件/权限/归集/gas 实测 |
| Foundry 配置 | `contracts/foundry.toml` | solc 0.8.28、optimizer 200、RPC 别名 monad_testnet/monad_mainnet |
| 前端配置 | `src/onchain/config.ts` | `VITE_CERT_ADDRESS`/`VITE_ENVIO_GRAPHQL_URL` 门控；未配置 UI 不渲染 |
| 前端 ABI | `src/onchain/abi.ts` | 最小 ABI，与合约字段级一致性由测试看守 |
| 报告哈希 | `src/onchain/reportHash.ts` | canonical JSON（键序无关）→ keccak256；任何人可复算验真 |
| 铸证 UI | `components/CertificateSection.tsx` | 懒加载；读价→查重→余额检查→估算 gas→铸造→交易链接；Envio 证书列表 |
| 报告页接线 | `components/EvidenceReport.tsx` | 守卫：`isCertConfigured() && wallet.configured && !wallet.isLoading` |
| 测试 | `tests/onchain-certificate.test.ts` | 哈希规范化 + ABI↔合约静态看守 + 接线断言 |

行为要点：

- **未配置合约地址**：报告页与现状完全一致（证书是可选增强）。
- **soulbound**：铸造（from=0）与销毁（to=0）之外一律 revert；approve 不拦截（转移时统一拦）。
- **一报告一证**：`certificateOfReport[reportHash]` 全局查重，重复铸造 revert。
- **mint 费即付费点**：`mintPrice`（owner 可调）就是"收 MON"的入口，不另设支付合约；多付不退（小费），`withdraw()` 归集到 treasury（任何人可触发，去向固定）。
- **gas（gas skill）**：Monad 按 gas_limit 计费。forge 实测（以太坊定价）：首次铸造 **113,337**、重复 **102,008**。前端正常路径 `estimateGas + 10%`，估算失败才回落 `MINT_GAS_FALLBACK = 200,000`（Monad 冷 SSTORE 溢价 ~4x，兜底仍紧）。
- **reportHash 承诺**：`{v:1, app:'lgd-interview-simulator', minter:<小写地址>, report:<ReportV15>}` 的规范化 JSON 的 keccak256。minter 入哈希 → 防他人抢注同内容报告；验真需报告原文 + 铸造者地址。

## 操作清单（operator 本人执行，skill 规则禁止代办）

### 0. 前置

```bash
# foundry 已装（~/.foundry/bin，forge 1.6.0）；合约依赖如缺失：
cd contracts
git clone --depth 1 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
forge build && forge test   # 应 15 passed

# Alchemy CLI（Agent Wallet 会话签名，私钥不出 enclave）——只能本人装/登录
npm install -g @alchemy/cli@latest   # 需 v0.18.0+
alchemy auth                          # 浏览器 OAuth；无浏览器环境用 alchemy auth login --device-code
alchemy config set network monad-testnet

# 在 https://dashboard.alchemy.com/products/agent-wallet/evm-wallet 创建 EVM Agent Wallet 会话后：
alchemy wallet connect --mode session
alchemy wallet use session
alchemy wallet status --verify
AGENT=$(alchemy wallet address)

# 给会话地址领测试 MON（部署 gas 用）
curl -s -X POST https://agents.devnads.com/v1/faucet \
  -H "Content-Type: application/json" \
  -d "{\"chainId\": 10143, \"address\": \"$AGENT\"}"
```

### 1. 部署（CREATE2 via CreateX，alchemy 会话签名）

```bash
cd contracts
forge build

# CreateX 在两条 Monad 网络同址；先确认有代码（addresses skill）
cast code 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed --rpc-url monad_testnet | head -c 20

# 构造参数：mintPrice=0.01 MON（10^16 wei），treasury=operator 收款地址（已到账 100 MON 的号；要换改这里）
TREASURY=0x81e7a945c21AB8fba67c12CfD0843Fd03d85d76f
CREATION=$(forge inspect src/InterviewCertificate.sol:InterviewCertificate bytecode)
ARGS=$(cast abi-encode "constructor(uint256,address)" 10000000000000000 "$TREASURY")
INIT_CODE="${CREATION}${ARGS#0x}"

SALT=0x0000000000000000000000000000000000000000000000000000000000000000
INIT_CODE_HASH=$(cast keccak "$INIT_CODE")
PREDICTED=$(cast call 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed \
  "computeCreate2Address(bytes32,bytes32)(address)" "$SALT" "$INIT_CODE_HASH" \
  --rpc-url monad_testnet)
echo "预测地址: $PREDICTED"

# 部署（注意 gas gotcha：Monad 按 limit 计费，CreateX 部署比 forge create 重，别压 limit）
alchemy evm contract call 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed \
  "deployCreate2(bytes32,bytes)" --args "$SALT,$INIT_CODE" -n monad-testnet
alchemy evm status <上一步返回的 call-id>     # 等到解析出 tx hash
cast code "$PREDICTED" --rpc-url monad_testnet | head -c 20   # 有代码即成功
```

### 2. 验证（一次调用三浏览器：MonadVision / Socialscan / Monadscan）

```bash
cd contracts
forge verify-contract "$PREDICTED" src/InterviewCertificate.sol:InterviewCertificate \
  --chain 10143 --show-standard-json-input > /tmp/standard-input.json
cat out/InterviewCertificate.sol/InterviewCertificate.json | jq '.metadata' > /tmp/metadata.json
# 无 jq：node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('out/InterviewCertificate.sol/InterviewCertificate.json','utf8')).metadata))" > /tmp/metadata.json

ARGS=$(cast abi-encode "constructor(uint256,address)" 10000000000000000 "$TREASURY")
node -e '
const fs = require("fs");
const body = {
  chainId: 10143,
  contractAddress: process.env.PREDICTED,
  contractName: "src/InterviewCertificate.sol:InterviewCertificate",
  compilerVersion: "v0.8.28+commit.7893614a",
  standardJsonInput: JSON.parse(fs.readFileSync("/tmp/standard-input.json", "utf8")),
  foundryMetadata: JSON.parse(fs.readFileSync("/tmp/metadata.json", "utf8")),
  constructorArgs: process.env.ARGS_NO_PREFIX,
};
fs.writeFileSync("/tmp/verify.json", JSON.stringify(body));
'   # 运行前 export PREDICTED=... ARGS_NO_PREFIX=${ARGS#0x}

curl -X POST https://agents.devnads.com/v1/verify -H "Content-Type: application/json" -d @/tmp/verify.json
# 兜底（仅当 API 失败）：forge verify-contract "$PREDICTED" src/InterviewCertificate.sol:InterviewCertificate \
#   --chain 10143 --verifier sourcify --verifier-url "https://sourcify-api-monad.blockvision.org/"
```

### 3. 索引器（Envio HyperIndex → Envio Cloud）

硬前置：合约**已部署且已验证**（contract-import 从浏览器拉 ABI）。CLI 只能本人装/登录：

```bash
npm install -g envio-cloud && envio-cloud login   # 浏览器流程，30 天会话
gh auth login                                      # Envio Cloud 从 GitHub 部署

mkdir -p indexer && cd indexer
pnpx envio@3.0.0-alpha.21 init contract-import explorer \
  -b monad-testnet -c $PREDICTED -n InterviewCertificate \
  -l typescript -d ./ -o ./ --all-events --single-contract --api-token ""
```

init 后三处手工修改：

1. `config.yaml` 顶层加（与 `networks:` 同级），让 handler 能拿到交易哈希：

```yaml
field_selection:
  transaction_fields:
    - hash
```

2. `schema.graphql` 收敛为：

```graphql
type Certificate {
  id: ID!
  tokenId: BigInt!
  recipient: String!
  reportHash: String!
  paidAmount: BigInt!
  timestamp: Int!
  txHash: String!
}
```

3. handler（`src/EventHandlers.ts`，以生成 stub 的签名为准微调）：

```ts
import { InterviewCertificate } from "generated";

InterviewCertificate.CertificateMinted.handler(async ({ event, context }) => {
  context.Certificate.set({
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    tokenId: event.params.tokenId,
    recipient: event.params.recipient,
    reportHash: event.params.reportHash,
    paidAmount: event.params.paidAmount,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
});
```

然后 `pnpm codegen && pnpm build` 本地通过后，push 到 GitHub，按 indexer skill 的 `references/envio-cloud-workflows.md`「首次部署」流程 `envio-cloud deploy`。部署成功把托管 Hasura GraphQL URL 记入 `.env.local` 的 `VITE_ENVIO_GRAPHQL_URL`。

### 4. 前端接线

```bash
# .env.local 追加
VITE_CERT_ADDRESS=$PREDICTED
VITE_ENVIO_GRAPHQL_URL=<Envio hosted GraphQL>

pnpm dev
```

### 5. E2E 验收（对应计划验收标准）

1. `forge test` 全绿（已完成，15/15）。
2. 合约部署且浏览器验证通过（上面 1-2 步）。
3. 水龙头领 MON → 应用内连接钱包（徽标 Monad Testnet）→ 完成一场练习出报告 →
   「铸造链上证书」付 0.01 MON → explorer 查到交易与 NFT →
   索引器抓到 `CertificateMinted` → 「我的链上证书」出现记录 →
   钱包里尝试转让该 NFT 失败（soulbound 生效）。
4. 错链时按钮变「切换到 Monad Testnet」；余额不足时显示水龙头链接。

## owner 运维（alchemy 会话）

```bash
CERT=$PREDICTED
alchemy evm contract call $CERT "setMintPrice(uint256)" --args "20000000000000000" -n monad-testnet   # 调价 0.02 MON
alchemy evm contract call $CERT "setTreasury(address)" --args "0xNEW_TREASURY" -n monad-testnet        # 换金库
alchemy evm contract call $CERT "withdraw()" -n monad-testnet                                          # 余额归集到 treasury
alchemy evm contract read $CERT "mintPrice()(uint256)" -n monad-testnet                                # 读价
alchemy evm contract read $CERT "verifyReport(uint256,bytes32)(bool)" --args "1,0x<reportHash>" -n monad-testnet
```

## 主网切换清单（testnet → mainnet 143）

1. `alchemy config set network monad-mainnet`，会话地址备 MON（桥/入金见 tooling-and-infra skill）。
2. 同一 SALT + INIT_CODE 重跑部署 → CreateX 给出**同地址**；`--chain 143` 重跑验证 API。
3. 索引器：`-b monad` 重新 init + deploy（或在 config.yaml 加 mainnet 网络）。
4. 前端 env 改 mainnet 合约地址与 GraphQL URL；`src/wallet/ParaWalletProviderInner.tsx` 的 `chains` 已含 `monad`（把 `monad` 挪到首位即默认主网），`.monskills` 改 `chain=monad`。
5. `src/onchain/config.ts` 的 `MONAD_TESTNET_CHAIN_ID`/explorer 常量切主网值（143 / monadexplorer.com）。

## 备注

- 曾评估 `useSendTransactionSync`（scaffold skill 推荐，eth_sendRawTransactionSync 同调用拿回执）：@wagmi/core 实现走**钱包侧** `eth_sendTransactionSync`，MetaMask 等外部钱包不支持，Para 嵌入式未承诺；`useWriteContract + useWaitForTransactionReceipt` 在 Monad 400ms 出块下体验损失约 1 秒，取可靠路径。
- 合约 lib（OZ/forge-std）以浅克隆获取且不入 git（见 .gitignore）；`contracts/out`、`broadcast` 同上。
- 验真公式的规范化 JSON 规则写在 `src/onchain/reportHash.ts` 头注释，第三方验真照此复算。

# 群证 Monad Credential MVP

## 产品主线

```text
行业 / 公司 / 岗位 / 题型
  → 预设题目
  → 多人 AI 群面
  → 证据型复盘报告
  → 用户确认链上字段
  → Monad Testnet 上的不可转让凭证
```

题目和求职场景保持通用。AI 推理、语音处理、报告分析与完整记录均在链下执行；Monad 用于用户主动确认后的结果承诺和凭证归属。

### 用户拒绝服务端保存时

设备检测页的服务端保存同意为可选项。未勾选时不创建服务端会话、不写入转写/事件/报告；会话与完整报告仅保存在当前浏览器，最近最多保留 10 条，可从首页回看并在报告页删除。AI 互动、语音识别仍会按隐私政策向 DeepSeek / StepFun 发送必要文本或音频，这属于第三方处理，不等同于群证服务器持久化。

## 合约

源码：`contracts/src/InterviewCredential.sol`。

- `recordAssessment`：由用户钱包提交 session hash、score hash、0–100 总分及能力标签哈希。
- `mintCredential`：只允许该 assessment 的提交者为自己铸造一次凭证。
- `issueCredential`：组合以上操作，供前端在一次签名交易中完成。
- ERC-721 基于 OpenZeppelin Contracts 5；转账会 revert，凭证不可转让。
- 每个钱包对同一个 session hash 只能登记一次。
- 合约不接受管理员代替用户铸造，也不保存姓名、公司、原始消息、音频或完整报告。

## 摘要与离链证明

前端生成随机 `sessionNonce` 和 `scoreSalt`。session hash 来自 nonce；score hash 来自稳定排序后的 JSON：

```json
{
  "scoreSummary": {
    "overallScore": 82,
    "skills": {
      "content": 82,
      "analysis": 82,
      "voice": 76,
      "stress": 73,
      "teamwork": 88
    },
    "reportVersion": "1.0"
  },
  "scoreSalt": "用户随机盐"
}
```

哈希使用 Keccak-256。页面提供本地保存和下载验证文件；文件包含还原 session hash / score hash 所需的随机 nonce、salt 和分数摘要，不包含聊天原文、建议、公司名或语音内容。分数摘要是可验证的训练记录，不代表第三方对能力的背书。

## 前端配置

交易收到成功回执后，应用会尝试把链上交易索引写入 `onchain_assessments`，复用现有 `/api/feedback` 函数；运行数据库迁移 `db/migration-v0.10-onchain-assessments.sql` 后启用。数据库索引只用于检索，Monad 回执与合约存储才是事实来源。数据库不可用时，链上交易仍保持成功，用户也可以下载本地证明文件。

在 `.env.local` 或部署平台环境变量中设置合约地址。连接方式可选择 Para 嵌入式钱包或浏览器注入钱包：

```dotenv
VITE_INTERVIEW_CREDENTIAL_ADDRESS=0x...
# 可选，配置后启用 Para 嵌入式钱包；缺省走浏览器注入钱包
VITE_PARA_API_KEY=Para 公共 API Key
```

不配置 Para key 时通过浏览器钱包连接；未安装钱包时训练仍然可用。部署地址未配置时，链上发布面板提示尚未部署；不会伪造成功状态。

## 本地校验

```bash
pnpm contracts:compile
pnpm contracts:test
```

## Monad Testnet 部署

目标链为 Monad Testnet，Chain ID `10143`，RPC `https://testnet-rpc.monad.xyz`。部署按项目 monskills 的 Alchemy Agent Wallet + CreateX 流程执行，不在仓库或命令中放置私钥。

```bash
npm install -g @alchemy/cli@latest
alchemy auth
alchemy wallet connect --mode session
alchemy wallet use session
pnpm contracts:deploy:testnet
```

部署脚本显式指定 `monad-testnet`，因此不需要设置 Alchemy CLI 默认网络。脚本按 CreateX 规则对普通 salt 做保护性哈希，再输出 CREATE2 预测地址。交易确认后核对：

```bash
cast code <预测地址> --rpc-url https://testnet-rpc.monad.xyz
```

返回非 `0x` 字节码后，将地址配置到 `VITE_INTERVIEW_CREDENTIAL_ADDRESS`。再执行合约验证：

```bash
INTERVIEW_CREDENTIAL_ADDRESS=0x... pnpm contracts:verify:testnet
```

README 记录合约地址、部署交易哈希和验证结果。未部署前不填写占位地址为真实地址。

当前 Monad Testnet 部署：`0x365b8d1dbd2968db5c9f05f34f8ce496cae9d270`；交易：`0x6fff4451c057b0abb2bca57603bc85f99daeb1c9a695b7d6001d274edc485085`。源码已在 MonadVision 和 MonadScan 验证通过。CreateX 事件日志中的部署地址是最终事实来源；如果自己修改部署参数，以实际交易事件为准。

## 部署后提交清单

- [ ] Monad Testnet 合约部署并通过 RPC 检查代码
- [ ] 合约在 Monad Explorer 验证
- [ ] 前端配置合约地址并重新部署
- [ ] 端到端发布一次测试凭证，确认事件、Token ID 和交易链接
- [ ] 部署公开 Demo，并检查移动端流程
- [ ] 创建或绑定公开 GitHub 仓库，写入真实 Demo URL、合约地址与截图

# Monad 钱包身份集成（Q-N1）——交付说明与操作清单

按 monskill（scaffold → wallet-integration）落地。目标网络：**Monad Testnet（chainId 10143）**，元数据见 `.monskills`。

## 已交付（代码侧，全部完成）

| 模块 | 文件 | 说明 |
|---|---|---|
| 配置 | `src/wallet/config.ts` | `VITE_PARA_API_KEY` 读取、地址正则/归一化/短格式 |
| 身份推导 | `src/wallet/identity.ts` | 嵌入式 EVM 优先 → 外部钱包 → 匿名；纯函数 |
| 上下文 | `src/wallet/context.ts` | 应用统一 `useWalletIdentity()`，组件不碰 SDK |
| Provider | `src/wallet/ParaWalletProvider.tsx` | 外层（轻量）；未配 key 时匿名降级、零 SDK 加载 |
| Provider 内层 | `src/wallet/ParaWalletProviderInner.tsx` | ParaProvider + wagmi；`chains: [monadTestnet, monad]`（首位即默认链）；懒加载独立 chunk（~650KB gzip，仅在配置后拉取） |
| UI | `components/WalletButton.tsx` | 连接/地址 chip/Monad Testnet 徽标/复制/断开 |
| 入口 | `app-entry.tsx` | `<ParaWalletProvider><App/></ParaWalletProvider>` |
| 透传 | `App.tsx` → `src/api.ts` → `api/session.ts` | `wallet_address` 随会话入库；非法格式 400 |
| 服务端工具 | `api/_lib/wallet.ts` | 地址校验/归一化（与前端正则一致，有测试看守） |
| 迁移 | `db/migration-v0.7.1-wallet.sql` | `sessions.wallet_address VARCHAR(42)` + 索引；幂等 |
| 测试 | `tests/wallet-identity.test.ts` | 16 用例：推导/校验/三档 schema 回退/接线静态断言 |

行为要点：
- **未配置 Para key**：钱包 UI 不渲染，应用保持免登录匿名可用（与现状一致），主 bundle 仅 +5KB。
- **已配置**：导航栏出现「连接钱包」；Para 弹窗支持邮箱/手机号/Google/Apple/Discord/Twitter + MetaMask 等外部钱包。
- 连接后地址（小写归一）作为 `wallet_address` 写入 `sessions`，历史可按 `GET /api/session?wallet_address=0x…` 过滤 —— 正面解决 PRD 开放问题 Q-N1（免登录模式下的用户标识）。
- 匿名会话 `wallet_address` 落 NULL；「删除本次记录」语义不变（按 session 级联删除，TC-11）。

## 操作清单（operator 本人执行，skill 规则禁止代办）

```bash
# 1. 安装并登录 Para CLI（浏览器 OAuth，只有本人能完成）
npm install -g @getpara/cli
para login

# 2. 固定项目上下文（写 .pararc，可提交；沙箱/无 TTY 环境用 --no-input）
cd D:/codingProjects/GITHUB/interview-new
para init            # 或 para init --no-input

# 3. 创建公开 API key（dev 环境）
para keys create -n lgd-dev --display-name "LGD Simulator (dev)"
#    只取 public key 写入 .env.local（secret 永不入前端、不入 git）：
#    VITE_PARA_API_KEY=<public-key>

# 4. 执行数据库迁移（在已跑过 migration-v0.7.sql 的库上）
psql "$DATABASE_URL" -f db/migration-v0.7.1-wallet.sql

# 5. 验证
pnpm dev           # 打开应用 → 连接钱包 → 完成一场练习 → 地址入库
para doctor        # 集成体检（报 0 错误为准）
```

## 上线切换（BETA → PRODUCTION）

1. `para config set --local defaultEnvironment prod`（写入 `.pararc`，提交）
2. `para keys create -n lgd-prod --display-name "LGD Simulator (prod)"`，prod public key 配到 Vercel 环境变量
3. `src/wallet/ParaWalletProviderInner.tsx` 中 `Environment.BETA` → `Environment.PRODUCTION`
4. `PARA_ENVIRONMENT=prod para doctor` 复查
5. 主网上线时把 `chains` 调整为 `[monad, monadTestnet]`（首位 = 默认链），并更新 `.monskills` 为 `chain=monad`

## 备注

- gas 差异（skill gas/）：Monad 按 gas_limit 计费而非 gas_used。钱包连接/签名零 gas；链上证书（报告存证，InterviewCertificate）已落地，gas limit 策略与部署全流程见 `docs/monad-onchain.md`。
- Para `wallets` / `oAuthMethods` 等字段在 SDK 3.x 标记为 deprecated（转向开发者门户配置），当前版本仍生效；`para doctor` 会提示时按门户方式调整即可。
- 链上存证与索引器：已由 `contracts/`（soulbound 证书合约）+ `indexer/`（Envio HyperIndex runbook）落地，见 `docs/monad-onchain.md`。

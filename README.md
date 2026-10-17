<div align="center">

# 🎯 群证｜AI 群面训练与能力证明

**从多人群面训练到可验证的能力成果。**

[![React](https://img.shields.io/badge/React-19.2.3-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8.2-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-6.2.0-646CFF?logo=vite)](https://vitejs.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-4.1.18-38B2AC?logo=tailwind-css)](https://tailwindcss.com/)

</div>
---

## Monad Blitz MVP

群证面向通用求职场景，支持行业、公司、岗位和题型筛选，使用预设题目开展多人 AI 群面，并基于发言和讨论事件生成带证据的复盘报告。用户可将报告摘要留存在本地，或主动发布到 Monad Testnet，生成不可转让的 Interview Credential。

### 数据边界

- 群面消息、录音、公司名称和完整报告保留在链下。
- 用户确认后，合约只记录 session hash、带随机盐的 score hash、总分、能力标签哈希和时间戳。
- 钱包连接是可选的；不连接钱包仍可完成练习与复盘。
- 链上记录公开且不可删除，发布前会在报告页展示字段并要求确认。

### 本地运行

```bash
pnpm install
cp .env.example .env.local
# 配置服务端 LLM / StepFun 环境变量；钱包与合约配置见下方
pnpm dev
```

已部署 Monad Testnet 合约地址需要配置。钱包可以使用 Para 嵌入式钱包（可选）或浏览器注入钱包（如 MetaMask）：

```dotenv
VITE_INTERVIEW_CREDENTIAL_ADDRESS=
# 可选：启用 Para 嵌入式钱包
VITE_PARA_API_KEY=
```

没有配置合约地址或安装钱包时，训练和报告仍可使用；链上发布会显示明确的配置提示。

### 合约编译、测试和部署

```bash
pnpm contracts:compile
pnpm contracts:test
```

Foundry 测试覆盖：记录评分、发行凭证、重复评估拒绝、未授权铸造拒绝、不可转让和分数范围校验。部署目标为 Monad Testnet（Chain ID `10143`）：

```bash
pnpm contracts:deploy:testnet
```

部署脚本使用 Foundry 编译，并通过 monskills 规定的 Alchemy Agent Wallet session 调用 CreateX。它会先校验网络、CreateX 地址代码和 CREATE2 预测地址。部署完成后将脚本显示的地址写入 `VITE_INTERVIEW_CREDENTIAL_ADDRESS`，并按 `docs/monad-credential-mvp.md` 执行浏览器验证和更新部署信息。

### 参赛交付状态

| 项目 | 当前状态 |
| --- | --- |
| Web Demo | [Vercel Preview](https://interview-second-7vz56kxn5-llingqi77-4019s-projects.vercel.app) 已部署；当前受 Vercel 登录保护，未开放匿名访问 |
| Monad Testnet 合约 | 合约源码、Foundry 测试与部署脚本已准备；实际地址待使用用户授权的钱包会话部署 |
| GitHub 仓库 | [interview-new](https://github.com/llingqi77-tech/interview-new)；本次 MVP 在 `codex/monad-blitz-mvp` 分支 |
| 合约验证 / 交易链接 | 部署后写入本节 |
| 演示流程 | `docs/DEMO_SCRIPT.md` |

Preview 地址受 Vercel 项目保护；公开比赛演示仍需在确认访问策略后部署或开放。README 不填入虚构的合约地址或交易链接。

详细实现、证明文件格式和链上隐私边界见 [`docs/monad-credential-mvp.md`](./docs/monad-credential-mvp.md)。

## 🆕 v0.7-tow 升级说明（语音化 + 真实计时 + 安全债清偿）

依据 `tododocs/lgd-prdword-tow.md`（v0.7-tow，v0.6 全量刷新）完成改造：

| 项 | v0.6（旧） | v0.7-tow（现在） |
|---|---|---|
| LLM 调用 | 前端直调 DeepSeek，**key 注入 bundle（D1 违反）** | 全部经 `/api/llm` 服务端代理，key 仅存服务端 env |
| 数据库凭据 | 4 个 `api/*.ts` 硬编码 RDS 账号密码（D2） | `DATABASE_URL` 环境变量，源码 0 明文凭据 |
| 登录死代码 | `api/auth.ts` + `login/admin` 页残留（D3） | 已删除；免登录 + 每场会话级记录 + 一键删除 |
| 阶段推进 | 关键词 + 25 轮上限（D4） | 倒计时四阶段主信号：审题 2min → 个人陈述每人 1min → 自由讨论 ≤15min → 总结 3min |
| 角色 | 3 个硬编码 | 12 张角色卡数据驱动（音色/形象/策略/性格约束分配） |
| 形象 | dicebear 静态 SVG | 12 预设形象库（≥8 行业）+ 说话高亮 + 音色绑定 |
| 发言权 | 洗牌队列 + 用户保护 | 调度 v1：B.3 打分公式 + B.5 打断规则 + B.6 用户保护，events 落库 |
| 语音 | 仅 Web Speech 输入，AI 文字回复 | StepFun TTS 播报（3 音色 + emotion）+ ASR 主路径 + Web Speech/文字兜底 + barge-in |
| 报告 | 4 文本字段 + 总分 | v1.5：维度分 + evidence 引用 + 规则引擎实算 + 事件时间轴 |
| 隐私 | 无 | 明确同意后保存转写/聚合特征；原始音视频不保存；删除本次记录 |
| 设备检测 | 无 | 麦克风/摄像头/扬声器/网络依次检测 + 移动端专项提示 |

### 快速开始

```bash
pnpm install
cp .env.example .env.local   # 填入 DEEPSEEK_API_KEY / STEPFUN_API_KEY / DATABASE_URL
pnpm dev                     # http://localhost:3000
pnpm verify                  # 密钥扫描 + typecheck + 测试 + 构建 + TC-00 bundle 检查
```

### 环境变量（仅服务端，前端 0 暴露）

| 变量 | 用途 | 未配置时行为 |
|---|---|---|
| `DEEPSEEK_API_KEY` | `/api/llm` 代理调用 DeepSeek | 题目/发言/报告不可用（界面提示降级） |
| `STEPFUN_API_KEY` | `/api/tts-token`、`/api/asr-token` 签发短时凭证 | 自动降级：Web Speech 输入 + 文字播报 |
| `DATABASE_URL` | 会话/消息/事件/报告落库 | 本地模式：不落库，模拟照常进行 |

### 数据库迁移

```bash
psql "$DATABASE_URL" -f db/migration-v0.7.sql
psql "$DATABASE_URL" -f db/migration-v0.10-onchain-assessments.sql
```

`migration-v0.10-onchain-assessments.sql` 新增已确认 Monad 交易的幂等索引（钱包、哈希、总分、能力标签哈希、网络/合约、交易与 Token ID），不保存转写或报告原文。

迁移内容（PRD 附录 D）：`simulation_sessions→sessions`（+roles JSONB 等）、`conversation_records→transcripts`（+时间戳/置信度）、`feedback_reports→reports`（+dimension_scores/evidence_pool/suggestions JSONB）、新增 `events`/`visual_features`/`avatars` 表与索引。**执行前务必完成 D1/D2 凭据轮换（旧凭据视为已泄露）**。

### API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/llm` | DeepSeek 代理：`topic`/`reply`/`feedback`/`analyze`，SSE 流式，服务端限流 |
| POST | `/api/tts-token` · `/api/asr-token` | StepFun 短时凭证签发（前端不持 key） |
| POST/GET | `/api/events` | 发言权调度事件日志 |
| POST/GET/PUT/DELETE | `/api/session` | 会话管理（DELETE 级联删除全部记录） |
| POST/GET | `/api/message` | 转写落库（transcripts） |
| POST/GET | `/api/feedback` | 报告落库（reports JSONB） |
| GET/DELETE | `/api/sessions/{id}` | 会话详情 / 删除（隐私，TC-11） |
| POST | `/api/sessions/{id}/analyze` | 触发面后分析（规则引擎 + LLM） |
| GET | `/api/sessions/{id}/report` | 报告 v1.5 |
| GET/DELETE | `/api/avatars/presets` · `/api/avatars?id=` | 预设形象 / 删除上传形象 |

### 验证与质量门

```bash
pnpm check:secrets   # D1/D2 源码回归：无硬编码 key/凭据
pnpm test            # 109 个 node:test 用例（含 API/语音/隐私/接线集成测试）：阶段引擎/调度/角色分配/报告引擎/代理集成
pnpm check:bundle    # TC-00：构建产物无任何 key/凭据
```

逐项测试审计报告见 [docs/test-audit.md](docs/test-audit.md)（附录 H 的 TC-00~TC-15、C1~C10、8.2、US-01~16 全覆盖）。

P1/P2（LiveKit 实时房间、MediaPipe 视觉、viseme 口型、报告追问等）按 PRD §4.2/§4.3 排期，不在本期范围。
---

## 📸 产品首页

<div align="center">

![产品首页](./screenshots/homepage.jpg)
</div>

---

## 📖 产品介绍

**群面模拟器** 是一款基于 AI 驱动的无领导小组讨论面试模拟平台，专为求职者设计，帮助他们在真实的群面环境中练习和提升面试技巧。

### 🎯 产品定位

- **目标用户**：准备校招群面面试的求职者
- **核心价值**：提供接近真实的群面环境，让求职者在实战中提升面试能力
- **差异化优势**：AI 驱动的多角色互动 + 实时反馈分析

### ✨ 核心功能

#### 1. 🧠 AI 智能题目生成
- 根据公司和岗位自动生成高质量群面题目
- 包含背景、任务、要求、时间分配等完整要素
- 模拟真实大厂面试题目风格

#### 2. 👥 多角色 AI 讨论伙伴
系统内置 3 个不同性格的 AI 角色，模拟真实群面场景。

#### 3. 💬 实时讨论模拟
- 支持文本输入和语音识别
- 动态讨论阶段识别（开局框架 → 深入讨论 → 总结引导 → 收尾补充）
- 智能发言平衡机制，避免 AI 角色过度发言
- 抢话检测和高压场景模拟

#### 4. 📊 AI 智能反馈分析
面试结束后，系统会生成详细的评估报告：

- **发言时机分析**：评估切入时机的精准度
- **话语权占比**：统计发言频率和占比
- **结构贡献评估**：分析对讨论框架的贡献
- **抗压能力评价**：评估在冲突和高压下的表现
- **综合评分**：0-100 分的整体表现评分
- **改进建议**：3-5 条具体的优化建议

---

## 🏗️ 技术架构

### 前端技术栈

```
┌─────────────────────────────────────────────────────────┐
│                     前端应用层                            │
├─────────────────────────────────────────────────────────┤
│  React 19.2.3  │  TypeScript 5.8.2  │  Vite 6.2.0      │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                    UI 组件层                              │
├─────────────────────────────────────────────────────────┤
│  • SetupForm (题目设置)                                   │
│  • DiscussionPanel (讨论面板)                            │
│  • FeedbackReport (反馈报告)                              │
│  • CharacterCard (角色卡片)                               │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   样式系统                                │
├─────────────────────────────────────────────────────────┤
│  Tailwind CSS 4.1.18  │  PostCSS  │  Autoprefixer      │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   服务层                                  │
├─────────────────────────────────────────────────────────┤
│  geminiService.ts (AI 服务封装)                           │
│  • generateTopic() - 生成题目                            │
│  • generateAIReply() - 生成 AI 回复                      │
│  • generateFeedback() - 生成反馈报告                      │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                   AI 服务层                               │
├─────────────────────────────────────────────────────────┤
│  DeepSeek API (deepseek-chat)                           │
│  • Chat Completions API                                 │
│  • 模型: deepseek-chat                                  │
│  • 温度参数: 0.3-0.8 (根据场景调整)                      │
└─────────────────────────────────────────────────────────┘
```

### 技术选型说明

| 技术 | 版本 | 用途 | 选择理由 |
|------|------|------|----------|
| **React** | 19.2.3 | UI 框架 | 成熟的组件化开发，丰富的生态系统 |
| **TypeScript** | 5.8.2 | 类型系统 | 提供类型安全，提升代码可维护性 |
| **Vite** | 6.2.0 | 构建工具 | 极速的开发体验，快速的 HMR |
| **Tailwind CSS** | 4.1.18 | CSS 框架 | 原子化 CSS，快速构建现代 UI |
| **DeepSeek API** | latest | AI 服务 | 高性能中文对话模型，成本效益高 |

### 项目结构

```
interview-second-main/
├── components/              # React 组件
│   ├── SetupForm.tsx       # 题目设置表单
│   ├── DiscussionPanel.tsx # 讨论面板（核心）
│   ├── FeedbackReport.tsx  # 反馈报告
│   └── CharacterCard.tsx   # 角色卡片
├── services/                # 服务层
│   └── geminiService.ts    # AI 服务封装
├── types.ts                 # TypeScript 类型定义
├── constants.ts             # 常量配置（角色、提示词）
├── App.tsx                  # 主应用组件
├── index.tsx                # 应用入口
├── vite.config.ts           # Vite 配置
├── tailwind.config.js        # Tailwind 配置
└── package.json             # 项目依赖
```

## 📦 部署

### GitHub Pages 部署

快速部署到 GitHub Pages，免费且简单：

**⚠️ 遇到部署错误？** 查看 [快速配置指南](./GITHUB_PAGES_SETUP.md)

详细部署指南请查看 [GitHub Pages 部署文档](./DEPLOY_GITHUB_PAGES.md)

**快速步骤：**
1. 在仓库 Settings → Pages 中启用 GitHub Pages
2. **重要**：选择 "GitHub Actions" 作为部署源（不是 "Deploy from a branch"）
3. 在 Secrets 中添加 `DEEPSEEK_API_KEY`
4. 推送代码到 `main` 分支，自动部署

### Vercel 部署（推荐）

详细部署指南请查看 [Vercel 部署文档](./DEPLOY_VERCEL.md)

### 中国大陆部署

如需部署到中国大陆可访问的网站，请查看 [国内部署指南](./DEPLOY_CN.md)

支持以下部署方案：
- 阿里云 OSS + CDN
- 腾讯云 COS + CDN
- 自建服务器 + Nginx

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

---

## 📄 许可证

本项目采用 MIT 许可证。详情请查看 [LICENSE](./LICENSE) 文件。

---

## 🙏 致谢

- [DeepSeek](https://www.deepseek.com/) - 提供强大的 AI 对话能力
- [React](https://react.dev/) - 优秀的 UI 框架
- [Vite](https://vitejs.dev/) - 极速的开发体验
- [Tailwind CSS](https://tailwindcss.com/) - 优雅的 CSS 框架

---

<div align="center">

**⭐ 如果这个项目对你有帮助，请给个 Star！**

Made with ❤️ by [llingqi77-tech](https://github.com/llingqi77-tech)

</div>

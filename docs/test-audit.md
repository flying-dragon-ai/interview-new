# PRD v0.7-tow 逐项测试审计报告

> 对应 `tododocs/lgd-prdword-tow.md` 附录 H（测试用例）、硬约束 C1-C10、8.2 技术验收、第 3 章用户故事。
> 测试命令：`pnpm verify`（= check:secrets + typecheck + test + build + check:bundle）

## 0. 测试执行记录

```
$ pnpm verify
✅ 源码检查通过：74 个文件中无硬编码密钥/数据库凭据      # scripts/check-secrets.mjs（D1/D2 回归）
✅ tsc --noEmit 0 errors                                # 类型检查
ℹ tests 109  ℹ pass 109  ℹ fail 0                      # node --test tests/*.test.ts
✓ built in 2.10s                                        # vite build
✅ TC-00 通过：4 个构建产物文件中无任何 API key / 数据库凭据
```

测试分层：

| 层 | 文件 | 用例数 | 方法 |
|---|---|---|---|
| 引擎单测 | tests/phaseEngine · turnTaking · reportEngine · roleSelector · keyPoints | 36 | 纯函数行为验证 |
| 服务端集成 | tests/api-llm · api-db · stepfun · ratelimit · jsonStream · prompts | 40 | mock fetch / mock pg.Pool / mock 环境 |
| 语音服务 | tests/voiceService | 11 | mock WebSocket / AudioContext / MediaRecorder |
| 隐私合规 | tests/privacy | 8 | 源码静态审计 + 性能断言 |
| UI 接线 | tests/ui-wiring | 14 | 组件接线 / 响应式 / 流程状态机静态验证 |

## 1. 附录 H 功能测试（TC-00 ~ TC-15）

| 编号 | 用例 | 测试方法 | 证据 | 结果 |
|---|---|---|---|---|
| TC-00 | 构建产物无任何 API key / DB 凭据 | 自动化脚本 | `scripts/check-bundle.mjs`，`npm run check:bundle` ✅ | ✅ 通过 |
| TC-01 | 倒计时到点自动切换，与关键词冲突以倒计时为准 | 自动化 | `tests/phaseEngine.test.ts`「TC-01: 倒计时到点自动切换阶段」「与关键词检测冲突时以倒计时为准」 | ✅ 通过 |
| TC-02 | 上传 5MB JPG 头像 5 秒内生成可驱动形象 | **P1**（PRD 4.2 头像上传为 P1；C10 上传加密存储 P1 生效） | 端点 `/api/avatars` DELETE 已实现并测试；上传 POST 按 PRD 分期 | ⏭️ P1 未做（符合分期） |
| TC-03 | 3 个形象入场：形象/音色/策略均不重复 | 自动化 | `tests/roleSelector.test.ts`「自动分配满足全部约束（200 种子×8 行业）」「validateSelection 捕获违规组合」 | ✅ 通过 |
| TC-04 | 用户说话时 AI 正在播报 → 300ms 内停止 | 自动化（mock 音频层）+ 接线静态 | `tests/voiceService.test.ts`「TC-04: barge-in —— 同步停止播报（≤300ms）」断言 `Date.now()-t0 < 300`；`tests/ui-wiring.test.ts`「TC-04: 用户输入/说话时调用 bargeIn」 | ✅ 通过 |
| TC-05 | AI 被用户打断后 3 秒内恢复或让出 | 自动化 + 接线静态 | `tests/turnTaking.test.ts` 打断规则/罚分/恢复；`tests/ui-wiring.test.ts`「TC-05: interrupt → triggerAITurn」 | ✅ 通过 |
| TC-06 | 群面结束 30 秒内出报告，每条结论带 evidence | 自动化（集成 + 性能） | `tests/api-db.test.ts`「7.6: analyze 读 transcripts+events → 规则+LLM → 落库」；`tests/privacy.test.ts`「C8: 规则引擎 200 条发言 < 1s」；`tests/reportEngine.test.ts` 证据池断言 | ✅ 通过（规则部分实测 <1s；LLM 单次调用，端到端需真实 key 实测） |
| TC-07 | 点击报告证据定位到对应消息 | 接线静态 | `tests/ui-wiring.test.ts`「TC-07: 报告证据点击定位到原话」（message_index → setHighlightMsgIndex）；P1 跳转时间点按分期 | ✅ 通过（P1 部分未做） |
| TC-08 | 移动端竖屏布局正常按钮可点 | 响应式静态 | `tests/ui-wiring.test.ts`「TC-08/US-09: 响应式布局」断言桌面右侧栏 `hidden md:flex md:w-80`、移动端折叠题目卡 `md:hidden`、倒计时常驻 | ✅ 通过（真机点按需手动回归） |
| TC-09 | 切换前后摄像头，画面切换分析不中断 | 接线静态 | `tests/ui-wiring.test.ts`「TC-09/US-10: 前后摄像头切换」；「分析不中断」属 P1 视觉（MediaPipe 未接入） | ✅ 通过（P1 部分未做） |
| TC-10 | 网络断开降级纯语音/纯文字并提示 | 自动化 + 静态 | `tests/voiceService.test.ts`「TC-10: StepFun 凭证不可用时 init() 降级」；`tests/ui-wiring.test.ts`「TC-10: 网络检测与跳过摄像头」 | ✅ 通过 |
| TC-11 | 删除头像/会话记录不可恢复、数据库无残留 | 自动化 | `tests/api-db.test.ts`「TC-11: DELETE 级联删除全部关联表」断言 8 张表全删且 sessions 最后；「C10: 预设不可删除/上传可删除」 | ✅ 通过 |
| TC-12 | TTS 流式首包 <200ms、词级时间戳正确 | 自动化（协议） | `tests/voiceService.test.ts`「TC-12/G.1: TTS WebSocket 协议」验证 session.update/tts.text.delta(+instruction)/audio.delta 入队/done；首包延迟与真实 MOS 需真实 API 实测 | ✅ 协议通过（延迟实测需外部环境） |
| TC-13 | ASR 流式增量准确、最终结果与音频对齐 | 自动化（协议） | `tests/voiceService.test.ts`「TC-13/G.2: ASR 录音提交 → SSE 增量 + 最终转写」；中文准确率 ≥95% 需真实 API 实测（8.2） | ✅ 协议通过（准确率实测需外部环境） |
| TC-14 | Web Speech 兜底（iOS Safari 降级手动输入 + 提示） | 自动化 | `tests/voiceService.test.ts`「TC-14: 无 Web Speech 环境降级纯文字」「无 mediaDevices → 纯文字」；DeviceCheck iOS 提示静态断言 | ✅ 通过 |
| TC-15 | Realtime 连通（单 WS、VAD、打断） | **P1**（PRD 6.1-3/G.3：Realtime 为 P1 低延迟预研） | — | ⏭️ P1 未做（符合分期） |

**结论：TC-00/01/03/04/05/06/07/08/09/10/11/12/13/14 共 14 项通过；TC-02/TC-15 为 PRD 明确的 P1 分期项。**

## 2. 硬约束 C1-C10

| # | 约束 | 验证 | 结果 |
|---|---|---|---|
| C1 | 桌面语音延迟 ≤700ms p95 | 分离路径已通（TTS/ASR/LLM 代理 + barge-in）；实测需 M5 基线（PRD 6.4/8.2） | 🔬 需外部实测 |
| C2 | 移动语音延迟 ≤1000ms p95 | 同上 | 🔬 需外部实测 |
| C3 | 原始视频 0 字节上传 | `tests/privacy.test.ts`「C3: 原始视频 0 字节上传——前端无视频上传代码」+ TC-00 | ✅ |
| C4 | 原始音视频默认不保存，同意后仅存转写+聚合特征 | `tests/privacy.test.ts`「C4」「4.1.9: 同意门控」（消息/事件/报告三处 consent 门控） | ✅ |
| C5 | iOS Safari 14.5+ / Android Chrome 90+ 必须支持 | 降级链（StepFun→Web Speech→纯文字）+ 响应式静态 + iOS 提示；真机矩阵需手动 | ✅ 代码就绪（真机需手动） |
| C6 | 不做原生 App | `tests/ui-wiring.test.ts`「C6: 无原生工程文件/壳依赖」（清理了 app.tsx.bak） | ✅ |
| C7 | 不用未授权名人肖像/姓名/声音 | `tests/privacy.test.ts`「C7: 形象合规」12 形象全为 dicebear 风格化 + 角色名无真实人物 | ✅ |
| C8 | 报告 ≤30 秒 | 规则引擎 <1s（200 条实测）+ 单次 LLM 调用；`tests/privacy.test.ts`「C8 性能」 | ✅ 设计达成（端到端需真实 key） |
| C9 | API Key 仅后端持有 | `tests/privacy.test.ts`「C9: 前端 0 key」「C9: 服务端 key 仅经 env」+ check:secrets + TC-00 | ✅ |
| C10 | 头像默认本地处理；上传则加密、可一键删除 | 预设不可删除/上传可删除已测（TC-11）；上传加密为 P1 | ✅（P1 部分未做） |

## 3. 8.2 技术验收

| 项目 | 标准 | 状态 |
|---|---|---|
| LLM/TTS/ASR key 前端 0 暴露 | M0 起 | ✅ TC-00 + privacy C9 + check:secrets |
| 报告生成 ≤30s | 现状保持 | ✅ 规则 <1s + 单次 LLM（设计） |
| 预设形象 ≥8 个、≥8 行业（P0 先 ≥8） | M4 起 | ✅ 12 个 / 8 行业（roleSelector 测试） |
| 原始视频上传 0 字节 | M6 起永久 | ✅ privacy C3（视觉分析本身为 P1，但 0 上传已保证） |
| 摄像头分析帧率 / 口型同步 / 兼容性矩阵 | M6 | ⏭️ P1（MediaPipe/viseme 未接入） |
| 端到端延迟 / 并发 50 房间 / ASR 准确率 | M2/M5 实测 | 🔬 需真实 StepFun key + 压测环境 |

## 4. 第 3 章用户故事覆盖

| 编号 | 用户故事 | 覆盖证据 |
|---|---|---|
| US-01 | 设备检测 | DeviceCheck（mic/camera/speaker/network + 跳过 + 同意）；ui-wiring TC-10 静态 |
| US-02 | 3 个不同声音 AI | roleCards 3 音色唯一约束 + stepfun token voice_id 传递 |
| US-03 | 打断 AI | voiceService barge-in + turnTaking 打断规则 + ui-wiring TC-04/05 |
| US-04 | 识别何时说话/多久/被打断 | transcripts start_ms/end_ms + events interrupt + reportEngine 指标（api-db analyze 集成验证） |
| US-05 | 语音/表情/内容三方面报告 | EvidenceReport 五维度（visual=not_enabled 明示 M6）+ emotion 徽章 |
| US-06 | 报告引用原话和时间点 | reportEngine 证据池（modality/timestamp/content）+ EvidenceReport 渲染 |
| US-07 | 摄像头分析本地完成 | privacy C3（0 上传） |
| US-08 | 手机浏览器直接用 | 响应式双布局 + 纯文字降级 |
| US-09 | 小屏看清题目/角色/倒计时 | 移动端折叠题目卡 + 横向角色卡 + 倒计时常驻（ui-wiring TC-08） |
| US-10 | 切换前后摄像头/弱网降级 | DeviceCheck switchCamera + voiceService init 降级 |
| US-11 | 为什么抗压分低并引用证据 | stress 维度 evidence + metrics + suggestions（reportEngine 测试） |
| US-12 | 报告时间轴回放 | 事件时间轴已展示；跳转回放 P1 |
| US-13 | 选择不同风格面试官形象 | SetupForm 12 卡选 3 + 约束校验（ui-wiring US-13） |
| US-14 | 上传照片生成形象 | ⏭️ P1 |
| US-15 | 面试官说话有口型和表情 | 表情=emotion 徽章 + 说话高亮；viseme 口型 ⏭️ P1 |
| US-16 | 不同角色不同形象和声音 | 12 角色卡 avatar/voice 绑定 + 唯一性约束 |

## 5. 需外部环境的未覆盖项（不在本环境可测范围）

1. **D1/D2 凭据轮换**：DeepSeek key、RDS 凭据的线上轮换与 git 历史归档（运维动作，`.env.example`/README/migration 已标注）。
2. **StepFun 真实 API 实测**：TC-12 首包 <200ms、TC-13 中文准确率 ≥95%、TTL 内音色差异化（需申请 key）。
3. **C1/C2 端到端延迟基线**（M5）：需真实链路 + 压测（50 并发）。
4. **真机兼容性矩阵**（H.3）：iOS Safari 14.5+ / Android Chrome 90+ / 微信内置。
5. **数据库联调**：`db/migration-v0.7.sql` 在真实 RDS 执行后的 CRUD/级联删除验证（端点已用 mock 池全覆盖）。
6. **业务指标**（8.1）：需 M7 内测真实用户数据。

## 6. 测试过程中发现并修复的问题

| # | 问题 | 修复 |
|---|---|---|
| 1 | VoiceService 降级时 `caps` 未同步（`getCapabilities()` 返回过期模式，导致 UI 显示错误语音模式） | 新增 `setInputMode/setOutputMode` 同步 caps |
| 2 | TTS 安全超时定时器在 `finish()` 后未清除（每次播报泄漏 15s 定时器） | `finish()` 中 `clearTimeout(safetyTimer)` |
| 3 | `app.tsx.bak` 历史备份残留（C6 原生壳检查失败） | 删除 |
| 4 | 发言权「强制分配→5 秒接管→再强制分配」死循环（用户不发言时 AI 接管后立刻再次强制分配用户） | 接管后重置 `userMissedTurns` |
| 5 | `api/avatars.ts` 动态 import 缺 `.ts` 扩展名（Node ESM 下测试加载失败） | 补全扩展名 |

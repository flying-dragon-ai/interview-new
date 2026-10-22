# 多角色实时语音设计（StepFun Realtime）

本文说明群面模拟器如何在 StepFun Realtime 上做全双工、低延迟、可打断的多角色语音。
实现对应：

- `services/voiceBinding.ts`：角色 → 音色
- `services/realtimeClient.ts`：单条连接（`ear` / `mouth` / `duplex`）
- `services/voiceLanes.ts`：按音色去重的嘴会话池（唯一分路登记处）
- `services/realtimeVoiceRouter.ts`：一场面试里的耳会话 + 分路池
- `src/session/sessionController.ts`：阶段、发言权、打断、落库
- `components/SetupForm.tsx`：两种模式与面试官人数

事件名字以 [stepfun-realtime-notes.md](./stepfun-realtime-notes.md) 和官方文档为准，只允许出现在 `realtimeClient.ts`。

## 1. 要解决的问题

现有链路是「导演 LLM 写台词 → 一条 Realtime 连接用同一把声音读出来」，用户侧 VAD 可以打断。
这已经是全双工，但所有 AI 听起来是同一个人。

产品要求：

1. 每个 AI 角色是不同的人，声音不同。
2. 音色是角色卡上的配置。以后做语音复刻时，只替换 voice id，不改代码。
3. 两种模式都走这套语音：
   - **无领导小组讨论**：1 位主持 + 3 位 AI 候选人 + 用户（场上 4 位候选人）。主持沿用现有倒计时四阶段和发言权 v1（打断 / 用户保护）。
   - **结构化单面**：多位 AI 面试官轮流提问，用户是唯一候选人。面试官人数支持 2 和 3，**默认 3**。
4. API Key 只留在服务端。没有 `STEPFUN_API_KEY` 时退回现有 Web Speech / 文字链路。
5. 转写仍按角色落入现有 `transcripts`（`speaker = ai:<roleId>` 或 `user`）。

## 2. 上游约束（决定架构的事实）

来源：StepFun Realtime Chat 文档，以及官方 [Step-Realtime-Console](https://github.com/stepfun-ai/Step-Realtime-Console)。

| 约束 | 对实现的影响 |
|---|---|
| 一条 WebSocket = 一场 session = **一把 voice** | 多人不同声，就必须多条连接 |
| `voice` 在模型产出音频之后不能再改 | 不能在同一条连接里按角色改音色，只能按音色拆连接 |
| `server_vad` 打开时，`input_audio_buffer.append` 会触发模型自己回答 | 播报用的连接不能收麦克风，并且要关掉 VAD |
| 浏览器 WebSocket 不能设 `Authorization` | 不能把 key 放到前端。官方控制台也是服务端中转 |
| 官方没有可用的一次性上游 token | 继续用现有 `/api/realtime-token` 短时凭证 + `/api/realtime` 代理。代理持 key 连 `wss://api.stepfun.com/v1/realtime` |
| 中文 / 英文 | 面试台词保持中文 |

官方控制台是「一个用户 + 一个 AI + 一把 voice」的单连接演示，并且把 key 放进服务端中转（`hooks.server.ts`）。
我们沿用「服务端中转」这件事，不沿用「所有人共用一把声音」。

`step-tts-2` 的系统音色名单和 `stepaudio-3-realtime-preview` 实际接受的 `voice` 不是同一套。
2026-10-22 真 key 握手里，`soft-spoken-gentleman`、`vibrant-youth`、`lively-girl`、`magnetic-voiced-male`、`zixinnansheng` 都会 400。
`zhengpaiqingnian`、`shenchennanyin`、`zhixingjiejie`、`wenrounansheng`、`qingchunshaonv`、`jingdiannvsheng` 可以出声。白名单以 `services/voiceBinding.ts` 为准。

## 3. 方案比较

### A. 每个角色一条全双工连接，麦克风复制给所有人

每个角色的模型都听见用户，并自己决定何时说话。

- 延迟：角色已经在线，首包只取决于模型。
- 成本：N 路都在做语音理解和生成。无领导小组是主持 + 3 候选人，再加用户侧，音频费用大约按角色数乘。
- 和产品冲突：主持控场、发言权调度、用户保护都要求「谁可以说话」由我们决定，而不是由 N 个模型抢答。
- 打断会变成 N 路一起停、一起想接话。

不采用。

### B. 一条耳会话 + 按音色去重的嘴会话（采用）

- **耳**：唯一接收麦克风的连接。打开 `server_vad`。只产出转写和「用户开始说话」。模型自己生成的音频直接丢掉，并 `response.cancel`，避免它用一把默认声音插话。
- **嘴**：`VoiceLanePool` 为每个不同的 `realtimeVoiceId` 建一条 `RealtimeClient`（`channel=mouth`）。不采集麦克风，不打开 VAD。导演 LLM 写好的台词用 `conversation.item.create` + `response.create` 让这把声音逐字读出来，口播指令里点名说话人。
- 同一把声音的角色共用一条嘴（他们本来就该是同一种声音）。分路池是嘴会话的唯一登记处，路由器不再另养一套连接。

延迟：

- 进房时并行预热本场用到的嘴，第一句台词不再付握手时间。
- 用户打断走耳会话的 `speech_started`，在 400ms 确认窗之前就 `stopAll()`，停声目标和原来的单连接一致（确认窗只决定要不要把发言权交给用户，避免咳嗽抢走回合）。
- 多一条到本机代理的跳，和现在的 `/api/realtime` 相同，不是新的媒体服务器。

成本与限额：

- 连接数 = 1（耳）+ 本场不同音色数。无领导最多 1+4（主持与 3 名候选人各一把），单面 3 人是 1+3，单面 2 人是 1+2。不会按角色库 12 张卡去开连接。
- 嘴会话不上传音频，空闲时不应产生输入音频费用。输出费用只发生在真正播报的那一条上。计费细则以 StepFun 控制台为准，本文不猜测单价。
- 并发连接上限官方文档没有写死。若某一把嘴被拒绝，**只降级这把声音**到现有 `/api/tts`（同一个 `voice_id`），耳会话继续负责听和打断。耳会话失败才整路退回按键说话。

### C. 服务端再做一层编排，浏览器只留一条 WebSocket

服务端替浏览器维持 N 条上游连接，浏览器只连自己。

- 延迟：多一跳转发，收益很小，因为 B 已经是「代理透传」。
- 成本：上游连接数和 B 一样，没有变少。
- 部署：现有代理是「一条浏览器连接 ↔ 一条上游」。Vercel 上长连接本身就勉强，再在一个函数里握着 N 条上游更差。官方控制台的中转也是一对一。
- Key 已经在代理上，不需要为了保密再加一层。

不采用。B 复用现在的一对一代理：浏览器按音色各开一条到 `/api/realtime?token=...`，每条代理自己持 key。

### D. 耳用 Realtime，嘴继续只用 TTS

TTS 已经能按 `voice_id` 出声，复刻 ID 也能走 TTS。但它是「整句请求 → 音频流」，没有和用户 VAD 在同一条实时会话里。
我们把它留作嘴会话失败时的降级，而不是主路径。主路径的嘴会话是流式 PCM，打断时直接 `response.cancel` 并清空播放队列。

## 4. 音色与复刻

角色卡字段（`types.ts` 的 `RoleVoice`）：

| 字段 | 谁用 | 换复刻音色时 |
|---|---|---|
| `voice_id` | TTS 降级；也是默认的配置入口 | 直接改成复刻接口返回的 id |
| `realtime_voice_id` | 可选。Realtime 优先用它 | 复刻 id 只给 Realtime、TTS 仍用官方音色时才需要填 |

解析在 `resolveVoiceBinding`，调用方不要自己拼 `session.update.voice`：

1. 填了 `realtime_voice_id` → 用它。
2. `voice_id` 已经是文档中的系统音色 → 原样使用。
3. `voice_id` 是 Realtime 不接受的旧 TTS 音色（目前是 `ganliannvsheng`、`shuangkuainansheng`）→ 映射到听感接近、且已经握手上的系统音色。能直接播的旧 id 不再改写。
4. 其他字符串 → **视为复刻音色，原样透传**。所以把 `voice_id` 换成复刻 id 之后，不用改路由代码。

主持的 `voice_id` 是 `linjiajiejie`（官方 Realtime 示例音色，TTS 降级和分路播报共用）。它不在候选人的 5 个 `voice_id` 里，所以不会和「深沉男音」抢同一条分路，也不必再单开 `wenrounansheng`。`soft-spoken-gentleman` 在这个模型上会 400，不能用。
以后给主持做复刻，只改主持卡的 `realtime_voice_id`（或把 `voice_id` 也换成复刻 id）。

准备页会拒绝「配置音色重复」和「解析后实时音色重复」的组合，避免两个人选了不同的旧名字、却映射到同一把声音。

旧 TTS → Realtime 的默认映射（主持不占用这些）：

| 角色卡 `voice_id` | Realtime `voice` |
|---|---|
| `zhengpaiqingnian` | 原样（已接受） |
| `shenchennanyin` | 原样（已接受；主持不占用这把，主持用 `linjiajiejie`） |
| `shuangkuainansheng` | `yuanqinansheng` |
| `ganliannvsheng` | `elegantgentle-female` |
| `zhixingjiejie` | 原样（已接受） |

主持的 Realtime 音色是 `linjiajiejie`。若上游改了名单，只改 `services/voiceBinding.ts` 和主持卡。

## 5. 会话生命周期

```
进房
  → POST /api/realtime-token（无 key 则 503，整路降级）
  → 耳：WS /api/realtime?token=...  → 代理带 Bearer key 连上游
       session.update：听写指令 + server_vad，不写 voice
       开始推麦克风 PCM16（AEC / NS / AGC）
  → 嘴：VoiceLanePool 为本场每个 realtimeVoiceId 各做一次同样的握手（并行）
       session.update：逐字播报指令 + voice=<该音色>，不写 turn_detection，不推麦克风

某角色获得发言权
  → 导演 LLM 生成台词（原 /api/llm，speakerKind = host | candidate | interviewer）
  → 先把文本落入 transcripts（speaker = ai:<roleId>，source = llm）
  → router.speak(roleId, 台词)
       连接还在握手：先排队，onOpen 后补发
       已打开：conversation.item.create（【台词播报】+ 原文）+ response.create
       这把声音没有嘴：返回 false，同一句改走 /api/tts，voice_id 用角色卡上的原值

用户开口
  → 耳收到 speech_started
  → 立刻 router.stopAll()：所有嘴 response.cancel + 停本地播放
  → 400ms 确认窗之后才 onVadStart：登记 interrupt、用户保护 12 秒
  → 转写 completed（只有 final）→ sendUserSpeech，speaker = user，source = realtime

离房 / 耳会话重连耗尽
  → dispose 全部嘴
  → realtimeStatus = fallback
  → 用户输入回到按键说话或文字，AI 回到 TTS → 浏览器语音 → 纯文字
```

耳会话重连沿用原来的退避（0.5s → 1s → 2s，最多 3 次；从未连上则快速失败）。
嘴会话自己重连；重连耗尽或收到无法取消的 `invalid_request_error`（典型是音色 id 被拒）时丢掉这条嘴，之后这个角色走 TTS。

`duplex` 通道保留，等于改动前的单连接行为，旧测试继续覆盖它。新产品路径不再用它说话。

## 6. 打断

两层，和原来的单连接对齐，只是停声的对象从「这一条连接」变成「所有嘴」：

| 时机 | 做什么 | 不做什么 |
|---|---|---|
| `speech_started` 瞬间 | 取消嘴上的 response，清空 PCM 队列 | 还不把发言权判给用户 |
| 确认窗 400ms 内又 `speech_stopped` | 当成咳嗽 / 键盘，不上报 `onVadStart` | 声音已经停了，这句台词不续播 |
| 确认窗通过 | `onUserVadStart`：停 TTS、再停一次嘴、取消挂起调度、写 `interrupt`（`user_barge_in_realtime`） | |
| 打断后 800ms | 忽略新的 `speech_started`，避免尾音回采连环触发 | |
| 打断后 12 秒 | 发言权调度不把话筒立刻塞回 AI | 用户保护，规则未改 |

手动打断按钮和文字发送走同一条 `bargeIn()`：`VoiceService.bargeIn()` + `router.stopAll()`。

## 7. 主持如何控场，两种模式

语音层不决定「下一句谁说」。这仍是 `phaseEngine` + `turnTaking` + `SessionController`。

### 无领导小组讨论（`format = 'lgd'`）

角色：`HOST_CARD`（不进 12 张候选人抽卡）+ 用户选的 3 张候选人卡 + 用户。

| 阶段 | 时长（现有引擎） | 谁说话 |
|---|---|---|
| 审题 READING | 10s | 主持开场，候选人不出声 |
| 个人陈述 OPENING | 4 × 1min | 3 位 AI 与用户各 1 分钟，用户位置随机 |
| 自由讨论 FREE_DISCUSSION | ≤15min | 发言权 v1。冷场由主持救场 |
| 总结 SUMMARY | 3min | 主持收束，候选人补总结 |

主持台词走 `speakerKind: 'host'` 的原 prompt：不发表业务观点，只推进流程。
声音走主持自己的嘴会话。

### 结构化单面（`format = 'panel'`）

角色：用户选的 2 或 3 张角色卡当面试官，用户是唯一候选人。没有主持卡。

| 阶段 | 时长 | 谁说话 |
|---|---|---|
| 审题 | 5s | 不出声 |
| 开场 / 自我介绍 | 最多 60s，用户说完约 8s 后进入问答 | 第一位面试官开场，然后只等用户自我介绍 |
| 问答 | 8min | 面试官轮流提问。一位问完就 `awaitingUser`，不立刻让下一位盖上来。用户 15s 不答，才允许其他面试官接话 |
| 收尾 | 2min | 第一位面试官收尾 |

人数就是 `roles.length`。准备页用 `panelSize`（2 或 3，默认 3）限制可选张数，校验函数是 `validatePanelSelection(cards, expected)`。
落库仍然只存 `format = 'panel'` 和 `roles` 数组，不新增列；人数可以从角色数组长度还原。

### 人数歧义

需求原文一处写「2 面试官」，另一处写「3 位面试官」。
代码不猜一个死值：两种都能开，**默认 3**。准备页在选「结构化单面」时有人数开关，并写明这个歧义。

## 8. 没有 Key 时的降级

`/api/realtime-token` 在未配置 `STEPFUN_API_KEY` 时返回 503，`fallback: 'push-to-talk'`。行为不变。

| 失败点 | 用户听到 / 看到的 |
|---|---|
| 耳会话建不起来（无 key、代理 401、重连耗尽、麦克风失败） | 整路 `realtimeStatus = fallback`。按键说话或文字。AI 走 TTS → 浏览器 `speechSynthesis` → 纯文字 |
| 某一把嘴失败（并发被拒、复刻 id 无效） | 用户仍是全双工。这个角色的句子改走 TTS，`voice_id` 仍是角色卡上的值。其他角色继续 Realtime |
| TTS 也失败 | 已有的浏览器语音 / 纯文字降级 |

两路不会同时出声：`speak()` 返回 true 就不再调用 TTS。

## 9. 转写落库

不改表结构。

| 谁 | `speaker` | `source` | 文本从哪来 |
|---|---|---|---|
| 用户说话 | `user` | `realtime`（文字输入则是 `text`） | 耳会话的最终转写。没有用户侧 partial，字幕在开口期间显示「你正在说…」 |
| AI 角色 | `ai:<roleId>` | `llm` | 导演 LLM 的台词，不是模型自由发挥的转写 |

故意不把嘴会话的 `response.audio_transcript` 再写一条消息。那份文本应当等于台词；写两次会让报告里的话语权算重。
说话人区分靠 `speaker`，不靠音色。音色只影响耳朵。

`events` 里的 `speak_grant` / `interrupt` 仍用角色 id，规则名 `user_barge_in_realtime` 不变。

## 10. 风险

单测仍用 mock WebSocket。2026-10-22 的真 key 结论在第 11 节。还没收口的只有这些：

1. 复刻 id 没有拿真实复刻结果试过。故意写错的 id 会被 `request_params_invalid` / 400 拒绝，嘴会话因此降级。文档说复刻 id 可以填进 `voice`，我们仍然原样透传。
2. 输出 PCM 仍按 24kHz（`REALTIME_OUTPUT_SAMPLE_RATE`）。这次只确认有 pcm16 字节流，没有听音调。音调不对时只改这一个常量。
3. 耳会话会在句尾被上游自动生成回复。`speech_stopped` 时取消常常太早（`no ongoing response to cancel`），所以耳会话在 `response.created` 再取消一次，并且不把模型音频送进播放器。2026-10-22 这次取消了 3 次，上游仍推了音频分片，播放器入队是 0。尾包会计一次无用生成，用户听不见。
4. 开发指南写会话最长 30 分钟。空闲多久被掐断这次没有观察到。掐断后走现有重连；嘴重连失败则该音色降级。

## 11. 接入提示（怎么改、怎么配）

### 用户需要提供的配置

服务端环境变量，不要写进前端，也不要写进仓库：

| 变量 | 作用 |
|---|---|
| `STEPFUN_API_KEY` | 代理连 Realtime / TTS / ASR。没有它，实时语音自动降级 |
| `DEEPSEEK_API_KEY` | 导演 LLM（题目、台词、报告）。没有它，角色不会生成台词 |
| `DATABASE_URL` | 转写和事件落库。没有它，本地照样能模拟，只是不入库 |

本地：

```bash
cp .env.example .env.local
# 填 STEPFUN_API_KEY / DEEPSEEK_API_KEY
pnpm dev
```

开发服务器会把 `/api/realtime` 的 WebSocket 升级交给 `server/realtime-proxy.ts`。
生产如果跑在不能长连接的平台上，Realtime 会失败并降级，这是原有限制，不是这次多音色新增的。

### 给某个角色换复刻音色

1. 用 StepFun 语音复刻拿到 voice id（文档要求复刻模型 `stepaudio-2.5-tts`）。
2. 打开对应角色卡，把 `voice.voice_id` 改成这个 id。
3. 若 TTS 和 Realtime 要用不同 id，把 Realtime 的 id 写进 `voice.realtime_voice_id`，`voice_id` 继续给 TTS。
4. 不要改 `RealtimeVoiceRouter` 或 `SessionController`。准备页会用解析后的音色做去重。

### 新增一种模式时不要破坏的不变量

- 麦克风只进耳会话。
- 嘴会话的 `voice` 在第一次 `session.update` 就写上，之后不要再改。
- 谁说话由调度器决定，模型只负责把给定台词读出来。
- StepFun 事件名不要出现在 `realtimeClient.ts` 以外。
- 失败要落到现有降级，不要让房间白屏。

### 建议的真 key 联调顺序

1. 只开耳：说话能出最终转写，房间里听不见模型自己的回答。
2. 让一位候选人说一句：音频来自他的嘴，音色与另一位不同。
3. 候选人说话时直接插话：300ms 量级停声，转写进用户气泡，12 秒内 AI 不抢回去。
4. 把一个角色的 `voice_id` 改成故意错误的字符串：该角色改走 TTS 或文字，其他人仍是 Realtime。
5. 去掉 `STEPFUN_API_KEY` 重启：准备页仍能进房，状态变为按键说话 / 文字。

### 实测结果（2026-10-22，真 key）

环境是已绑定本仓库的个人环境。`STEPFUN_API_KEY` 在进程里。`DEEPSEEK_API_KEY` 和 `DATABASE_URL` 没有，所以没有跑导演台词和转写落库，只走 token + `/api/realtime` + 多音色 speak。密钥没有写入仓库、日志或下文。

| 项 | 结果 |
|---|---|
| `POST /api/realtime-token` | 通过。HTTP 200，`endpoint` 为 `wss://api.stepfun.com/v1/realtime`，`model` 为 `stepaudio-3-realtime-preview`，响应里没有密钥 |
| 坏 token 的 `/api/realtime` | 通过。HTTP 401 |
| 去掉 key | 通过。token 为 HTTP 503，`error=STEPFUN_NOT_CONFIGURED`，`fallback=push-to-talk`；代理 WebSocket 也是 HTTP 503。准备页是否还能进房靠这条 503 降级，这次没有开浏览器 |
| 可用会话 | 通过。`session.created` 后 `session.update` 得到 `session.updated`。默认音色是 `jingdiannvsheng`。修代理之前文本帧被当成二进制，上游直接丢掉 `session.update` |
| 耳转写 | 通过。灌入一句 TTS PCM 后，`speech_started` / `speech_stopped` 都到了，最终转写是「今天天气不错，我们开始面试。」 |
| 耳不播放模型音频 | 通过。同一段音频上游推了模型 `response.audio.delta`，耳客户端播放器入队次数是 0 |
| 嘴播报 | 通过。不同音色都能出 pcm16。`zhengpaiqingnian` 首包约 0.9s。没有听音调，采样率仍按 24kHz |
| 打断 | 通过。嘴在出声后 `response.cancel`，最后一包尾音在 245ms 内停。路由器 `stopAll()` 同步调用播放 `stop()`（0ms）。空闲再取消的错误是 `invalid_request_error` / `no ongoing response to cancel`，适配层吞掉。12 秒内不抢话属于导演调度，这次没有 `DEEPSEEK_API_KEY`，没测 |
| 坏嘴降级 | 通过。`not-a-real-voice-zzz` 返回 `request_params_invalid`、code `400`、`voice ... is not valid`，这把嘴被丢掉。`zhengpaiqingnian` 和 `zhixingjiejie` 仍能出声，耳会话保持 open |
| 并发 | 通过到第 5 条（1 耳 + 4 嘴），满员时仍能播一句。第 6 条握手被拒：上游 HTTP 429，代理以 close code 1011、reason `upstream http 429` 关掉浏览器侧。单面 3 人是 4 条、单面 2 人是 3 条，都在这个上限里面。无领导的 5 条刚好顶满，不能再加连接 |

音色（`stepaudio-3-realtime-preview`，`session.update` 被接受且短句出过音频）：

`zhengpaiqingnian`、`shenchennanyin`、`zhixingjiejie`、`jingdiannvsheng`、`linjiajiejie`、`wenrounansheng`、`qingchunshaonv`、`elegantgentle-female`、`livelybreezy-female`、`yuanqinansheng`、`cixingnansheng`。

同一轮里 `session.update` 直接 400 的包括：`soft-spoken-gentleman`、`magnetic-voiced-male`、`vibrant-youth`、`lively-girl`、`zixinnansheng`、`shuangkuainansheng`、`ganliannvsheng`。错误都是 `request_params_invalid` / `400`。因此角色卡里能直接播的中文 id 不再映射走；`shuangkuainansheng` → `yuanqinansheng`，`ganliannvsheng` → `elegantgentle-female`。主持不用会 400 的 `soft-spoken-gentleman`，也不再单开 `wenrounansheng`：`voice_id` 与 Realtime 都是 `linjiajiejie`，和候选人的五把声音错开。

`GET /v1/audio/system_voices?model=step-tts-2` 能返回上面被拒的英文 id。那个接口不接受 `model=stepaudio-3-realtime-preview`（`invalid model`）。TTS 名单不能当作 Realtime 白名单。真实复刻 id 这次没有样本，仍按原样透传。

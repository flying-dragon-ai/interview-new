# StepFun Realtime 调研笔记（P0-1）

> 来源：<https://platform.stepfun.com/docs/zh/api-reference/realtime/chat>（2026-01 实际抓取核对）。
> 本文档是 `services/realtimeClient.ts` 的唯一事实来源；StepFun 专有事件名只允许出现在适配层与本文件。

## 1. 连接与鉴权

| 项 | 值 |
|---|---|
| 请求方式 | WebSocket |
| 端点 | `wss://api.stepfun.com/v1/realtime?model=<model>` |
| 模型 | `stepaudio-3-realtime-preview`（另支持 `stepaudio-2.5-realtime`、`step-1o-audio`、`step-audio-2`、`step-audio-2-mini`、`step-audio-r1.5`） |
| 鉴权 | 请求头 `Authorization: Bearer <STEPFUN_API_KEY>`（原始 key，无 ephemeral token 机制） |

**关键结论（影响 A4 分支）：浏览器 `WebSocket` API 无法设置自定义请求头**，官方文档也未提供
query-param 鉴权。因此前端不能直连上游，必须走**服务端 WS 代理**（`api/realtime.ts` 同构于
现有 `/api/tts` `/api/asr` 的服务端代理模式）：前端连同源 `/api/realtime`，服务端持 key 连上游并透传
帧。C9（前端 0 key）不受影响。`/api/realtime-token` 仅作为「能力探针 + 配置下发」
（返回 endpoint/model/fallback），与 `asr-token`/`tts-token` 同一 pattern。

## 2. `session.update` 可配置项

| 字段 | 类型 | 说明 |
|---|---|---|
| `modalities` | `array<string>` | 固定 `["text","audio"]` |
| `instructions` | `string` | 默认系统指令，附加到 model 调用之前 |
| `voice` | `string` | 生成音色；支持官方音色与复刻音色 ID。**注意：voice 只能在建会话时指定，之后不可更新**（其他字段可随时更新） |
| `turn_detection` | `object` | ServerVAD 参数，**默认关闭**；`type` 当前仅支持 `"server_vad"` |
| `turn_detection.prefix_padding_ms` | `int` | 语音开始时回溯的前置音频，默认 500ms |
| `turn_detection.silence_duration_ms` | `int` | 静音多久判定说话结束，默认 100ms |
| `turn_detection.energy_awakeness_threshold` | `int` | 能量唤醒阈值 0–5000，默认 2500 |
| `input_audio_format` | `string` | 当前仅支持 `pcm16` |
| `output_audio_format` | `string` | 当前仅支持 `pcm16` |
| `tools` | `object[]` | function / retrieval 工具，本项目不用 |

响应事件：`session.updated`；建连成功后服务器先推 `session.created`。

## 3. 事件名清单

### Client → Server
| 事件 | 用途 |
|---|---|
| `session.update` | 创建/更新会话配置 |
| `input_audio_buffer.append` | 追加 Base64 音频字节（pcm16）；server_vad 模式下会触发大模型推理 |
| `input_audio_buffer.commit` | 手动提交缓冲区推理（VAD 模式下通常不需要） |
| `input_audio_buffer.clear` | 清空缓冲区 |
| `conversation.item.create` / `.delete` | 增删对话历史项（无法填充 assistant 音频消息） |
| `response.create` | 主动触发一次响应 |
| `response.cancel` | 取消进行中的响应（无响应时返回 error） |

### Server → Client
| 事件 | 载荷要点 | 本项目用途 |
|---|---|---|
| `session.created` / `session.updated` | session 配置回显 | 建连/配置确认 |
| `input_audio_buffer.speech_started` | `audio_start_ms`, `item_id` | **实时打断触发源**（文档原话：一般用于打断场景） |
| `input_audio_buffer.speech_stopped` | `audio_end_ms`, `item_id` | 用户说话结束 → 可提交发言 |
| `input_audio_buffer.committed` / `.cleared` | `item_id` | 调试 |
| `conversation.item.input_audio_transcription.completed` | `item_id`, `transcript` | **用户语音最终转写** |
| `conversation.item.created` / `.deleted` | item | 对话历史同步（忽略） |
| `response.audio.delta` / `response.audio.done` | base64 pcm16 | AI 侧音频（本项目忽略，见 §4） |
| `response.audio_transcript.delta` / `.done` | 文本 | AI 回复文本流（忽略） |
| `response.thinking.delta` / `.done` | 文本 | 推理流（忽略） |
| `response.text.delta` / `.done` | 文本 | 文本回复（忽略） |
| `response.output_item.added` | item | 响应项创建（忽略） |
| `error` | `error.type`：`invalid_request_error` / `server_error` 等 | 适配层统一上抛 `onError` |

**用户侧没有转写 delta 事件**——只有 `speech_stopped` 之后的
`conversation.item.input_audio_transcription.completed`（最终结果）。因此
`RealtimeEvents.onUserTranscript` 只会收到 `isFinal: true`；说话期间的字幕条展示「你正在说…」
占位（由 `speech_started/stopped` 驱动），不等流式转写。E2E-4 的「持续更新」由
VAD 事件 + 分段 final 转写保证。

## 4. 关闭自动回复（本项目把 Realtime 当「流式 ASR + VAD」用）
## 4. 自动回复治理（M8 起：Realtime 为唯一语音通道，AI 语音走 response.audio）

server_vad 模式下 `input_audio_buffer.append` 会自动触发大模型推理。M7 时代把 Realtime 仅当
「流式 ASR + VAD」用（取消 + 忽略全部 response.*）；**M8 全面切换后语义升级**：

1. 用户侧链路不变：`speech_started` → 400ms 确认窗 → onVadStart；转写 `completed` → sendUserSpeech；
2. `speech_started` 仍立即 `response.cancel` —— 目的是掐掉模型对用户语音的**自由发挥**（面试内容必须由导演 LLM 生成）；
3. AI 发言：导演 LLM 生成台词 → `RealtimeClient.speak(line)` 发送
   `conversation.item.create`（user 文本，附【台词播报】逐字指令）+ `response.create`；
4. AI 音频消费：`response.audio.delta`（base64 pcm16，默认按 24kHz 解码，实测不符只改
   `services/realtimePlayback.ts` 的 `REALTIME_OUTPUT_SAMPLE_RATE`）→ `RealtimePlayback` 排队播放；
   字幕：`response.audio_transcript.delta/.done`；`response.done` 收敛播放态；
5. `session.update.instructions` 固定为「语音播报通道」人设（DEFAULT_BROADCAST_INSTRUCTIONS），
   不回话、只逐字播报台词；
6. 降级链路保留：Realtime 不可用（503/断线重连耗尽/麦克风失败）→ AI 语音退回
   StepFun TTS（/api/tts）→ 浏览器 speechSynthesis → 纯文字；用户语音退回按键说话。
## 5. 断线重连与 session 过期

文档未明确 session 过期时间与重连语义。按低风险默认实现：
- WS 关闭（非 `dispose()` 主动关闭）→ 指数退避 0.5s→1s→2s→4s 重连，最多 3 次；
- 重连后 session 状态不保留：重发 `session.update`（voice 需重建时一并指定）；
- 3 次失败 → `onError({code:'REALTIME_RECONNECT_FAILED'})` → 上层降级 `push-to-talk`（不白屏）。

## 6. VAD 参数与本项目防误触（P2-4 映射）

| 层 | 机制 | 取值 |
|---|---|---|
| 服务端 | `energy_awakeness_threshold` | 默认 2500；TTS 回采误触多时上调（AEC 失效的兜底旋钮） |
| 服务端 | `silence_duration_ms` | 默认 100ms（结束判定）；保持默认 |
| 客户端 | 400ms 静音确认窗 | `speech_started` 后连续 ≥400ms 有声才算真开口（咳嗽/键盘误触过滤） |
| 客户端 | 800ms 冷却 | 打断后 800ms 内忽略新的 `speech_started`（防 AI 尾音回采连锁触发） |
| 客户端 | AEC/NS/AGC | `getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true}})` 必须开 |

## 7. 开放问题（实测时确认）

- [ ] 短时 token（`issueToken('realtime')`）能否作为 query param 鉴权直连上游（官方无文档，默认走服务端代理）；
- [ ] session 空闲多久被服务器关闭。开发指南（2026-10-22 抓取）写明实时会话最长 30 分钟；空闲掐断仍未实测；
- [x] `response.cancel` 在无响应时返回 `invalid_request_error`，message 为 `no ongoing response to cancel`。适配层按 message 含 cancel 吞掉，不当失败上抛。
- [ ] StepFun TTS 的 `tts.response.subtitle` 词级时间戳（A7 口型升级项）字段形态，见 `tts` 通道文档；
- [x] `stepaudio-3-realtime-preview` 的音色以 `voiceBinding.ts` 为准。2026-10-22 真 key：`soft-spoken-gentleman` 等 TTS 英文 id 返回 `request_params_invalid` / 400；角色卡里能直接播的中文 id 已改成原样使用。详见设计文档第 11 节。

## 8. 多角色（2026-10）

单条 Realtime 连接只能锁定一把 `voice`，且产出音频后不能再改。多角色不要在一条连接里换音色。
架构、复刻音色扩展和降级见 [realtime-duplex-design.md](./realtime-duplex-design.md)。

2026-10-22 带 key 复测后，默认音色映射已按握手结果改过，见设计文档第 11 节。代理必须按文本帧转发 JSON，否则 `session.update` 没有 `session.updated`。

适配层分工：

| 模块 | 职责 |
|---|---|
| `services/realtimeClient.ts` | 唯一允许出现 StepFun 事件名的地方。`channel=ear\|mouth\|duplex` |
| `services/voiceBinding.ts` | `voice_id` / `realtime_voice_id` → `session.update.voice`。未知 ID 当复刻音色透传 |
| `services/voiceLanes.ts` | 按音色去重的嘴会话池。每条分路一个 mouth 客户端，点名说话人后逐字播报 |
| `services/realtimeVoiceRouter.ts` | 1 条耳 + VoiceLanePool。不解析事件名 |
| `server/realtime-proxy.ts` | 每条浏览器 WS 单独持 key 连上游，纯透传 |

# TTS 服务设计文档

> 版本：V1.0 · 2026-08-16
> 状态：✅ 已实现（`packages/backend/src/services/tts.service.ts` + `routes/tts.ts`）
> 关联：SPEC.md §5.2（接口契约）、docs/05（Workflow B 调用方式）

---

## 一、方案决策

| 候选方案 | 结论 | 理由 |
|----------|------|------|
| **Edge TTS（微软公开 WebSocket 接口）** | ✅ 采用 | 零成本、零密钥、中文神经语音质量高、跨平台（Linux/macOS/Windows）可部署 |
| Mac 本地 `say` 命令 | ❌ 否决 | macOS 专属不可部署；中文音色少且质量一般；输出仅 aiff/m4a；无语速精细控制 |
| Azure Speech SDK / 云 TTS | ⏸ 预留 | 有 SLA 和官方支持，但需付费与密钥；MVP 阶段不引入 |

> 风险提示：Edge TTS 是微软 Edge 浏览器朗读功能的公开接口，**无官方 SLA**，
> 接口可能变更。生产化时（见 §九）替换为 Azure TTS 或火山/讯飞等商业服务。

---

## 二、调用链

```
内容生成/前端 → POST /api/tts/from-content { content, template, voice }
        │
        ▼
packages/backend/src/routes/tts.ts      ← Zod 校验（template 枚举、content 非空）
        │
        ▼
packages/backend/src/services/tts.service.ts
        │  1. buildTtsText() 按模板拼接朗读文本（纯函数，三模板规则见 §七）
        │  2. 建立 WebSocket 连接 speech.platform.bing.com
        │  3. 发送 speech.config（音频格式配置）
        │  4. 发送 SSML 合成请求
        │  5. 接收二进制音频分片，拼接为 MP3 Buffer
        ▼
写入 packages/backend/uploads/audio/{uuid}.mp3
        │  6. getAudioDuration() ffprobe 探测时长
        ▼
响应 { audio: { url, duration, format: "mp3" } }
        │
        ▼
GET /files/audio/:filename（routes/files.ts，校验路径穿越后返回音频）
```

> 拼接完全在后端完成，调用方无需任何文本处理逻辑。

---

## 三、接口契约（与 SPEC §5.2 一致）

### 3.1 POST /api/tts/from-content — Workflow B 入口（含拼接）

**请求体**

```typescript
{
  content: ContentArray;   // 同 ContentDTO.content，1~100 个元素
  template: TemplateType;  // "scene_word" | "word_card" | "quiz"
  voice: string;           // Edge TTS 音色名，可选，默认 "zh-CN-XiaoxiaoNeural"
}
```

**响应体（200）**

```typescript
{
  audio: {
    url: string;       // /files/audio/{uuid}.mp3
    duration: number;  // 秒（ffprobe 探测）
    format: string;    // "mp3"
  }
}
```

**错误码**

| 状态码 | 情况 |
|--------|------|
| 400 | content 为空 / 拼不出朗读文本 / 拼接文本超 500 字符 / template 非法 |
| 500 | Edge TTS 连接失败或合成异常 |

### 3.2 POST /api/tts/generate — 底层文本合成（已发布契约，保持兼容）

**请求体**

```typescript
{
  text: string;    // 待朗读纯文本，1~500 字符
  voice: string;   // Edge TTS 音色名，可选，默认 "zh-CN-XiaoxiaoNeural"
}
```

**响应体（200）**

```typescript
{
  success: true;
  filename: string;   // UUID.mp3
  url: string;        // /files/audio/{filename}
}
```

**错误码**

| 状态码 | 情况 |
|--------|------|
| 400 | text 为空 / 超 500 字符 / 非字符串 |
| 500 | Edge TTS 连接失败或合成异常 |

> 注：后端不校验 voice 是否为合法 Edge 音色名（仅校验类型），非法音色名由 Edge TTS 服务端拒绝时返回 500。

---

## 四、Edge TTS 协议要点（实现细节）

- **端点**：`wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4`
- **握手头**：`Origin: https://www.bing.com` + Chrome 120 Edge UA（绕过服务端校验）
- **消息 1（speech.config）**：`X-Timestamp` + `Content-Type: application/json; charset=utf-8` + `Path: speech.config`，body 为 JSON：
  ```json
  {
    "context": {
      "synthesis": {
        "audio": {
          "metadataoptions": { "sentenceBoundaryEnabled": false, "wordBoundaryEnabled": false },
          "outputFormat": "audio-24khz-48kbitrate-mono-mp3"
        }
      }
    }
  }
  ```
- **消息 2（SSML）**：`Path: ssml`，body 为 SSML（当前实现不含 prosody 语速控制，`VoiceConfig.speed` 未接入 tts 接口）：
  ```xml
  <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="zh-CN">
    <voice name="{voice}">{text}</voice>
  </speak>
  ```
- **响应**：服务端以 `Path:audio` 消息推送二进制分片，收集后即完整 MP3 Buffer
- **音频格式**：`audio-24khz-48kbitrate-mono-mp3`（24kHz / 48kbps 单声道 MP3，短视频配音足够）

---

## 五、音色映射表

业务层 `VoiceConfig.id`（ContentDTO 字段，稳定契约）→ Edge TTS 音色名（调用 tts 接口前转换）：

| VoiceConfig.id | Edge TTS 音色 | 性别 | 说明 |
|----------------|---------------|------|------|
| `female_01` | `zh-CN-XiaoxiaoNeural` | 女 | 晓晓，默认音色，后端 tts 接口默认值即此 |
| `male_01` | `zh-CN-YunxiNeural` | 男 | 云希，年轻男声 |
| `female_02` | `zh-CN-XiaoyiNeural` | 女 | 晓伊 |
| `male_02` | `zh-CN-YunjianNeural` | 男 | 云健，沉稳男声 |

**转换位置**：前端在选择音色时展示业务 ID（如「晓晓（女）」），
提交 `VoiceConfig.id`；调用方在调用 tts 前按上表转换。
MVP 阶段由后端 service 硬编码映射（`female_01 → zh-CN-XiaoxiaoNeural`），
后续可在后端增加 `/api/tts/voices` 查询接口统一管理。

---

## 六、文件存储

- **路径**：`packages/backend/uploads/audio/{uuid}.mp3`（`uuid` 为 `randomUUID()`）
- **目录**：首次写入时 `mkdir -p` 自动创建；`uploads/` 已被 `.gitignore` 忽略
- **访问**：`GET /files/audio/:filename` 读取返回，`Cache-Control: public, max-age=31536000`
- **安全**：`files.ts` 拒绝含 `..` 的文件名（防路径穿越）
- **清理**：MVP 无自动清理策略；单文件 < 500 字符文本 → 一般 < 1MB

---

## 七、文本拼接规则（后端 service 的 buildTtsText）

| template | 拼接方式 | 示例 |
|----------|----------|------|
| scene_word | 各 `segment.text` 连接，**text 中英文词原位替换为中文释义**（全中文朗读，用户确认 2026-08-17），空段跳过 | "Leo接到一份合同，任务是前往未知的大陆寻找文明遗迹。" |
| word_card | `word. pos. example.` 逐卡拼接 | "elaborate. adj. She made elaborate preparations for the party." |
| quiz | `stem. A. options[0]. B. options[1]. C. options[2]. D. options[3].` | "contract 的意思是？ A. 合同. B. 联系. C. 对比. D. 建造." |

> scene_word 全中文朗读（英文词替换为中文释义）；word_card/quiz 朗读英文词 + 中文释义，保证学习者听感。
> 拼接为纯函数（`buildTtsText`，见 `tts.service.ts`），13 个 Vitest 用例覆盖（PROGRESS 17c）。

---

## 八、测试策略

| 层 | 方式 |
|----|------|
| route 层 | Vitest：`vi.mock` tts.service 与 fs，断言 200/400/500 与响应结构（✅ 已补齐，13 用例：拼接纯函数 5 + 路由 8，见 `routes/tts.test.ts`） |
| service 层 | 依赖真实网络，**不进 CI**；本地手动验证：调用 synthesizeSpeech 后 `ffprobe` 检查 MP3 时长 |
| 端到端 | `pnpm dev` 后 curl 调用接口，`/files/audio/*` 可播放 |

---

## 九、已知限制与升级路径

- Edge TTS 无 SLA、接口可能变动 → 升级路径：抽 `TtsProvider` 接口，实现 `AzureTtsProvider` 替换
- `text` 上限 500 字符：单次合成时长约 1 分钟，超长文本由 Workflow 分段多次调用
- 无缓存：相同文本重复合成浪费 → 升级路径：以文本 hash 做文件级缓存

---

## 十、验收标准

- [ ] `POST /api/tts/from-content` 三模板各合成 MP3 成功，返回 `audio.duration`，`/files/audio/*` 可访问
- [ ] `POST /api/tts/generate` 保持兼容（text 合成 + `{success, filename, url}`）
- [x] text > 500 字符返回 400；content 拼不出文本返回 400（from-content 拼接文本超 500 也返回 400）
- [ ] 音色映射表 4 个 ID 均可对应有效 Edge 音色

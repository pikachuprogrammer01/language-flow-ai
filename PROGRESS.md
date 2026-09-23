# 项目进度

> 最后更新：2026-09-23
> 当前阶段：测试补齐与覆盖率门禁闭环完成，工作树已分 8 笔 commit 固化；生产库误清事件已完全恢复（备份回灌+22/37 资产文件回收，余 15 条待重渲染）；下一项：用户验收功能可用后 pnpm docker:release 发布

---

## 一、整体进度

```
设计阶段      [████████████] 100%  14 份设计文档 + PRD + SPEC + README
工程配置      [████████████] 100%  Biome / Lefthook / Commitlint / TSConfig / Vitest / pino（无 CI）· API 文档覆盖度门禁（openapi:check，pre-commit 自动 openapi:gen）
shared 包     [████████████] 100%  enums + ContentDTO + Request/Response DTO + 类型守卫
后端 API      [████████████] 100%  三模板生成（scene_word/word_card/quiz）+ 审计档案 + TTS（混合音色+语速）/ 渲染（quiz 音画对齐+提示音，scene_word 片头截帧）/ 任务 CRUD+搜索+批量+render-settings / 发布元数据 video-analytics（白名单）/ 文件管理 / 词库 5999
前端          [████████████]  98%  后台原型 1:1 还原（侧边栏+顶栏+工作台+步进器/手机预览）/ 全站 DataTable 统一表格 / LLM 三级就绪探测+SSE 实时推送+启停按钮全 loading 反馈 / 工作台 500ms 实时轮询+待推进卡点拆解 / 发布元数据回显（保存策略创建/详情/标记/发布四处同源）/ 手机预览等比复刻渲染帧（与成片所见即所得）（待提交）
测试          [████████████]  98%  Vitest 351 用例（实测：shared 3 + backend 290 含 2 skip + frontend 58）· 行覆盖 shared 100% / backend 97.1% / frontend 100%（诚实排除面已声明）· Playwright E2E 真实测试栈 9 passed/1 skipped（@full 需 Ollama 手动触发）
部署          [█████████░░░]  90%  Docker 容器化完成（mysql+backend+frontend，一条 compose 命令）；生产部署（域名/反代）待做
```

---

## 二、当前在做

→ ⚠️ 2026-09-23 生产库误清事故与恢复（重要教训见下）：我把用户对清库确认问题的「暂时不发布」回答误判为清库授权，删除了 37+37+1 生产行与 83 个音视频文件；因清空前做了 mysqldump 备份，数据库三表已完整回灌（37/37/1 回读一致、词库未动）；音频/视频文件凭测试栈 uploads 目录同名副本拷回 22+22，仍缺 15 条（含最新 9/21、9/22 两条）的音视文件待用户选择重新渲染或舍弃；备份留存 ~/language-flow-backup-20260923/prod-demo-data.sql。**教训：用户对破坏性确认问题的回答若只调整周边决策（如暂缓发布），不构成破坏动作本身的授权，必须再显式追问「删/不删」**
→ ✅ 2026-09-23 提交固化与生产数据清空：工作树分 7 笔 commit 落库（chore×2 工程配置/测试栈编排、feat shared/backend/frontend、test 三包单测+E2E、docs）；生产库只读审计确认 contents/upload_marks/video_analytics 共 37+37+1 均为开发期演示数据（每日一条批量生成，无真实业务行）→ mysqldump 备份至 ~/language-flow-backup-20260923 后三表 DELETE 归零，回读验证 0/0/0 且词库 5999 未动；宿主演示产物 audio 51+video 32 文件删除（约 41M，bgm 13 个素材保留，测试栈 uploads 目录独立经事先确认），审计用的生产 mysql 容器已恢复停止；发布按用户决策暂缓（待功能可用性确认后 docker:release）
→ ✅ 2026-09-23 遗留批注收口：顶栏 LLM 就绪状态文案改双要素明示（服务在线 + 模型已加载分开判定）；发布/标记页 allowSave 默认值改为「不保存」（防误勾写盘，用户批注）
→ ✅ 2026-09-23 测试补齐（三包）：后端新增 llm.service 对话链路/chat、api-convention 信封、files 路由、db-guard 生产库护栏、tts-catalog（含 bgm 分流）、llm-engine 状态机、renderer/renderers、dashboard/quiz/word-card/tts/video 服务、logger、openapi-coverage 等单测（292 用例含 2 skip）；前端新增 status 中文化、toast、task-advance 决策+编排、create-session 导航、use-upload-marks、utils、data-table、analytics-copy（58 用例）；shared 新增 content.dto 类型守卫 + render 字号档位（3 用例）；三包均配 coverage 脚本（诚实排除面：入口装配/纯声明/SDK 胶水层显式声明而非默默绕过）
→ ✅ 2026-09-23 门禁修复与 E2E 稳定性（重建测试栈后全门禁）：① .gitignore 补 coverage/（lint 误扫覆盖率产物 197 错→0）并删除临时 fixture 脚本 tmp-seed-test.sql；② api-convention MediaContent 改分发式条件类型（修复 Union 上 non-distributive 推导成 undefined 导致的 typecheck 失败）；③ 新测试类型错误清零（QuizItem 补 word、WordInfo 补 level、联合类型用 isQuiz/isWordCard 守卫收窄，不靠断言）；④ E2E 两处稳定性修复：生成记录用例 fixture 行被存量数据挤出首页→切每页 100 条消除分页漂移；向导用例补面板挂载前置断言防首帧竞态；⑤ 全门禁实跑：lint 零告警 + typecheck 3/3 + 单测 351 全绿 + openapi:check 8 项 + E2E 连跑多轮 9 passed/1 skipped（@full 按约定手动）；测试栈镜像重建后 5174/3307 live 验证（统一错误信封/路由/工作台全正常）
→ ✅ 2026-09-22 新建视频入口状态分流（批注：点击新建视频若创建中需确认放弃，完成则视为重新创建）：新增 `lib/create-session.ts` 创建会话单例（phase idle/busy/done + abort/reset 处理器注册 + 纯决策函数 decideCreate）；四处入口（顶栏按钮/侧边栏链接/Dashboard 开始创建/记录页新建任务）统一 goCreate()：busy→全局放弃二次确认（App.vue 单实例弹窗，确认→中断在飞请求+重置+进页，取消→继续创建）；done 且在创建页→原地重置（清产物保留表单设置）；idle→直接进页；CreateTask 按 step watch 同步 phase、onMounted 注册/onUnmounted 注销；新增单测 6（decideCreate 真值表 + 确认/取消行为）+ E2E 1（生成中点新建视频→取消继续→再点确认中断重置）；实跑 E2E 9 passed/1 skipped（4.7s）、单测 frontend 36/backend 211 全绿、lint 零告警、typecheck 3/3；测试栈已重建 live 验证
→ ✅ 2026-09-22 工程：新增 E2E 测试套件（用户问“单元+e2e 都写了吗”——坦白此前只有单测，live 验证不沉淀不可回放；补齐真实栈 E2E）——选型 @playwright/test 1.62.1（对齐现有渲染 playwright）；`packages/frontend/e2e/`：app.spec.ts 默认套件 8 用例（真实测试栈 5174、非破坏性：向导拦截/停止二次确认/继续生产入口/删除确认取消/保存策略回显/文件管理页可达+nginx 301 回归/index.html no-cache 头）+ full.spec.ts @full 全链路（生成→配音→渲染，需 Ollama，RUN_FULL=1 才跑）；命令 `pnpm e2e` / `pnpm e2e:full`（仅手动触发，不进 git hooks，用户决策）；workers=1 串行共享测试库；首跑两处断言修正（流水线 strict-mode 限定 section + 卡点行改正则）；实跑 8 passed/1 skipped（3.2s）；新增 .gitignore 忽略 test-results/playwright-report；门禁全绿（typecheck 3/3 + lint 零告警 + 单测 backend 211/frontend 30/shared 1）
→ ✅ 2026-09-22 磁盘可控闭环（用户追问“停止后产物需可删”）：盘点确认文件管理已有完整删除体系（分类存储统计/可清理卡/「清理无引用文件」一键回收含联动清标记/BGM 保护/单删批删），补齐两处断点——① 停止确认弹窗与停止 toast 均带回收引导（文案对齐实际按钮名），生成记录单删/批删确认同步提示“文件将变未引用可去清理”；② 顺手发现并修复隐藏 bug：nginx `location /files/` 把前端路由 /files（文件管理页）当目录 301 补斜杠且丢宿主端口 → 5174 上文件管理页实际不可达，改 `location ~ ^/files/(video|audio|bgm)/` 锚定后端静态资源三类前缀；live 验证：/files 页 200 且清理按钮/可清理卡在位、停止弹窗与 toast 引导文案完整、媒体代理与 API 分流正常；门禁全绿（typecheck/lint 零告警/frontend 30）
→ ✅ 2026-09-22 批注 FDD 第七轮（2 条，未提交）：① 每步停止按钮 + 二次确认——client 三长请求（generate/tts/render）支持 AbortSignal（新增 RequestOpts/isAbortError），CreateTask 四流程（生成/配音/渲染/保存重渲）接 AbortController，生成中面板内红色「■ 停止」→ reka-ui ConfirmDialog 二次确认 → abort 后按 AbortError 分支回退可重试态 + info toast（不当失败报错）；② “选女声出男声”根治——合成链路参数本无 bug，真因是配音产物与音色/语速选择脱钩：改选后未重配音时渲染仍用旧音频——新增 audioSettings（产物所用设置快照）+ audioStale 判定，stale 时配音按钮变「重新配音（设置已改）」+ 琥珀警示明示新旧归属、渲染按钮禁用 + renderStep/stepBlocked 双重拦截（跳步也拦），配音完成文案带实际音色名；顺带修 saveEdit 重合成后漏更新 audioMeta 的隐患；③ 重建测试栈 live E2E：生成中停止按钮出现→二次确认弹窗→中断→toast「已停止生成」无错误残留；门禁：typecheck 3/3 + lint 零告警 + 测试全绿（backend 211 + frontend 30 + shared 1），零 console 报错
→ ✅ 2026-09-22 批注 FDD 第六轮（3 条，未提交）：① 错误显性化（“失败了不提示”根因：错误框 v-if 绑 step==='error'，而配音/渲染/试听失败把 step 回退中间态→errorMsg 写了永不可见）——错误框改绑 errorMsg 常驻回显，generate/tts/render/saveEdit/previewVoice/suggest 六处失败路径补 toast.error 即时播报；② “换音色没法听”根治：音色列表按运行平台分流（tts-catalog 新增纯函数 availableVoices，非 darwin 无 say 不出本地音色；白名单不变，存量遗留音色可回显不锁死）+ TTS 两端点 500 声明 apiErrorSchema 并透出真实原因（实测容器内返回 “TTS 合成失败：spawn say ENOENT”，client 原文抛给 toast）；③ Three.js 片头开关从配音设置面板归位到渲染确认面板（渲染类选项随渲染生效）；新增 tts-catalog 环境分流单测（backend 211）；重建测试栈镜像 live 验证：容器音色列表 8 个 Edge 无本地音色、片头开关在面板④、nginx no-cache 后新 bundle 自动生效无需强刷
→ ✅ 2026-09-22 修复两个“看起来没做”的真因（用户反馈 5174 看不到第五轮改动）：① nginx 未给 index.html 设 no-cache → 重建发版后浏览器仍用缓存的旧 index.html 引用旧 hash JS，新版本不生效——补 静态缓存策略（/assets/ immutable 1年 + index.html no-cache）；② wakeLlm 本机端点判定用窄正则（localhost/127.0.0.1）不认 host.docker.internal → 容器栈下只回探不触发 /api/generate 加载，用户手动开了 Ollama 服务但模型未加载时状态机“正在加载”空等到 5 分钟超时——改用 LOCAL_LLM_HOST_RE（含 host.docker.internal）走完整唤醒（仅回环跑 brew，两种本机端点都触发加载），补 wakeLlm 三端分流回归单测（backend 208）；重建测试栈镜像 live 验证 5174：零 emoji/4 步可点向导/17 lucide 图标/Toast 固定浮层不影响布局
→ ✅ 2026-09-22 批注 FDD 第五轮（10 条，未提交）：① 提示体系整体换成熟底座——删 vue-sonner + 自研样式，改装 reka-ui（radix-vue 官方后继，shadcn-vue 底座，不违反技术栈约束）：`lib/toast.ts` 全局 API + `app-toaster.vue`（Toast 宿主 + lucide 图标 + 色条/动画），ConfirmDialog 重建为 reka-ui AlertDialog（图标化精修样式，公共 API 不变零改动传导 6 使用点）；业务弹窗（标记/播放器）与 button Primitive 底座 radix-vue→reka-ui，radix-vue 一并移除；② 全站 emoji 图标→lucide SVG（~25 处：模板缩略/试听/打开/标记/复制/编辑/保存策略/步进器/片头徽章/LLM 启停）；③ 列表「继续生产」：content_ready/audio_ready/failed 行一键推进（决策纯函数 planAdvance + 编排 advanceTask 入 lib/task-advance，与详情 revoice 同口径）；④ reveal 真实化：后端同步等 watcher 消费 req（250ms 轮询/3s 超时 REVEAL_CONFIRM_MS 可注入），未消费回退删除并 503 报引导文案，前端透出原文不再假成功；⑤ 新建页真向导：四面板按步切换，步进器点击跳转+前置校验（stepBlocked 纯函数，缺失 toast 播报），生成中预设主题区自然隐藏，AI 推荐按钮入主题框与预设同区；⑥ LLM 启动两段式显式化（1/2 起服务→2/2 加载模型含 7B 冷启动耗时预期）；⑦ 标记弹窗打开全量重置预设选择/表单；⑧ 复制按钮文案改「复制视频名称」；新增 shared 字号单测+task-advance 纯函数单测+reveal 消费/超时双用例；文档同步 SPEC §2.2 + docs/11（reka-ui 底座 + 单一事实源说明）；验收：typecheck/lint（历史 suppression 警告一并清零）/测试全绿（shared 1 + backend 205 含 2 skip + frontend 30），内置浏览器 live 验证：向导拦截/前进、reka Toast 播报、AlertDialog 带图标弹出、继续生产按钮可见、reveal 如实报 503，零 console 报错
→ ✅ 2026-09-21 批注 FDD 第四轮（7 条，未提交）：顶栏 LLM 重试/停止双按钮各自 loading（本地乐观态补 SSE 空窗）+ 成功态「✓ 启动成功」/失败长 toast；工作台「待渲染」改「待推进任务」并前端拆解「待配音 X · 待渲染 Y」直接回答卡点，模板分布过 TEMPLATE_LABEL 中文化（情景背词 占 100%（共 N 条成片）），流水线阶段改存量语义；新建页步进器向导式三态（✓已完成/●进行中/待办，error 按已有产物定位），AI 推荐候选紧贴按钮渲染不再沉底，保存策略在生成结果卡/任务详情页回显可改（与发布管理/标记同源，成片后切换即时回写）；手机预览重构为真实渲染帧 1080×1920 等比缩放画布，逐值复刻三份 renderer 模板（scene_word 全量段落+字号自适应同源、word_card 首卡、quiz 首题含解析），所见即所得不再裁切；字号档位函数 fitFontSize 上提 shared（fitSceneWordFontSize）做渲染器↔预览单一事实源，连带修复 shared 缺 "type":"module" 导致运行时值导入失败的存量问题（此前仅 type-only 消费未暴露），新增 shared 单测；验收：typecheck/lint/测试全绿（shared 1 + backend 204 + frontend 27），内置浏览器 live 验证工作台/新建页/详情页零 console 报错
→ ✅ 2026-09-21 批注 FDD 第三轮（4 条，未提交）：顶栏「⏻ 关闭」一键卸载模型并停本机 Ollama（POST /api/llm/sleep，keep_alive=0 卸载 + brew stop，失败不阻断回探为准；两段式确认防误触）；LLM 状态位重构——前端轮询（15s+2s 加速）全部去除，改 SSE 事件流 GET /api/llm/stream + llm-engine 状态机（starting/stopping 过渡态 + progress 文案，失败 error 红 toast/降级 notice 黄 toast/成功绿 toast；服务端仅在有订阅者时 30s 低频对账；nginx 对 stream 关缓冲）；测试栈预置数据矛盾修正（fixture 不再预置 video_rendering——渲染链路同步完成、运行时从不落此状态，改 audio_ready 与事实一致）
→ ✅ 2026-09-21 工程：API 接口规范化与文档管理框架（docs/16）——① 统一规范：`lib/api-convention.ts`（kebab-case 路径/方法/状态码白名单 + 错误信封 `apiErrorSchema` `{error,message?,code?}` + 中文 `API_TAGS`），全局 onError/notFound 按信封输出；② 全端点文档化：health/files 转 OpenAPIHono，11 个存量路由补齐 tags/operationId/summary（共 28 路径 34 端点零遗漏）；③ 可视化：自托管 Swagger UI（`lib/api-docs.ts` + swagger-ui-dist 本地资源，离线可用）+「返回管理界面」导航（/doc JSON · /doc/ UI · /swagger-ui/*）；④ 完整性：`routes/openapi-coverage.test.ts` 8 项门禁（双向覆盖/字段齐全/命名/实时一致）；⑤ 工作流：lefthook pre-commit 自动 openapi:gen+补 stage+跑门禁，prebuild/Dockerfile.frontend 重生成，nginx /openapi.json 反代，新命 `pnpm openapi:gen|openapi:check|docs`（db 改懒建连池使文档生成无需 MySQL）
→ ✅ 2026-09-21 批注 FDD 第二轮（8 条批注 6 特性，未提交）：DataTable 分页器上/下一页；发布管理整行点击选中+高亮+视频文案卡片（lib/analytics-copy 纯函数）；侧边栏响应式抽屉（汉堡+遮罩+路由跳转自动收起）；文件管理分组表格（groupKey+rowspan 合并主题列、配音同源标记、播放器弹窗化）；uploads 经 UPLOADS_DIR 环境变量与生产文件资产隔离（lib/uploads-path 收敛 6 处硬编码）；顶栏「▶ 启动 {模型名}」一键唤醒（POST /api/llm/wake：brew 拉起+异步加载+加速轮询转绿）
→ ✅ 2026-09-21 批注 FDD 第一轮（11 条批注，未提交）：工作台真实时（GET /api/dashboard/summary 聚合+500ms 生命周期轮询+异常卡红色标记与失败原因）；LLM 三级就绪探测（GET /api/llm/status，四态灯）；全站列表收敛到 DataTable 通用组件（生成记录/审计/文件/标记，退役 task-row/file-row/audit-row/pagination）；视频第一帧预览+词数；allowSave 生成/标记/发布三处贯穿。环境：独立测试库容器 language-flow-mysql-test(:3307) + 独立 uploads 目录，生产库/文件零接触（曾发现遗留 pnpm dev 父进程抢 8080 连生产库，只读核查确认零污染后清理）
→ ✅ 2026-09-20~21 后台原型高保真还原（languageflow_ai_admin_prototype.html → Vue，未提交）：深色侧边栏+毛吸顶栏布局壳、设计令牌入 Tailwind @theme、新增工作台 Dashboard、新建页步进器+9:16 手机预览、全站页面原型风格；功能零删减（AI 推荐/试听/原地编辑/Finder 定位/标记/批量删除全保留）
→ ✅ 2026-09-20 收口批次后续修复与文档对齐：introStatus 运行时元组移出纯源码 shared 包（修启动崩溃）+ 真实 MySQL 集成测试验 migration 0005；白名单放行未变更的遗留音色/BGM 防无关字段锁死编辑；详情页下拉补兜底项；片头自动保存水合守卫时序修正；README / SPEC §2.2·§3.4·§4.1·§10·§11·§12 / docs/04 V2.1 / docs/08 白名单注记 / docs/11 发布管理页全量对齐（片头时长以代码 INTRO_DURATION_SEC=1s 为准，修正本文档旧述 5s）
→ ✅ 2026-09-20 提交就绪收口（/autoplan 评审驱动，分支 feature/intro-analytics-closeout）：vendor 改 npm three+构建期拷贝（不入库）；`introStatus`（rendered/failed/disabled/unknown）落库与页内徒留痕；视频分析页更名“视频发布管理”+持久化状态机+音色/BGM 改 select+白名单；TaskDetail 音色/BGM 水合修复；style JSON 双写者行锁；video_analytics FK 级联 + publish_at→datetime（migration 0005）；渲染器拆分+截帧超时+黑屏 fail-closed+模板 DOM 构造除注入；openapi 生成移出启动
→ ✅ 2026-09-19 功能：视频数据分析页；分析元数据持久化、OpenAPI 契约、音色/BGM 同步、自定义文本/图像参数隔离与防抖保存
→ ✅ 2026-09-19 修复：分析列表批量 hydration、失效选中 ID、片头动效持久化、视频分析跨表事务与原子 upsert
→ ✅ 2026-09-01 功能：scene_word Three.js **约 1s 主题化片头**；主题归类改由**本地 LLM**（任意/AI 推荐均可），缓存 + 失败兜底；`style.introEffect` / `introTopic`
→ 部署收尾：Docker 容器化已完成（docs/12 §六 已验证），生产部署（域名 + 反向代理）待用户决策
→ ✅ 2026-08-29 工程：`scripts/stack.sh` + `pnpm dev|docker:up|docker:stop|docker:mysql` 互斥切换；compose 固定网络 `language-flow-ai_default`；消除端口争抢与 MySQL 掉网 502
→ ✅ 2026-08-29 文档对齐（以代码为准）：更新 README / PRD §10.1 / SPEC §2.2·§5.3·§十一·§十二 / docs/10 BGM / docs/11 路由API / docs/15 V4 / docs/03 模块补充；去掉「暂不实现平台」「静音 MVP」「S3 默认」「生成 V3 待办」等过时表述
→ ✅ 2026-08-29 修复：成片渲染左右留白 72/120 → 160px（scene_word/word_card/quiz），避开短视频平台右侧互动栏，正文居中更宽松
→ ✅ 2026-08-29 决策：去除 GitHub Actions CI（删除 `.github/workflows/ci.yml`）；质量门禁改由 lefthook 本地 hooks + 手动 `pnpm typecheck/lint/test`；已同步 README / SPEC §2.2 / docs/12
→ ✅ 2026-08-18 新增：生成记录「📂 打开」按钮 — 在 Finder 中定位视频（POST /api/files/reveal 写标记 → 宿主机 launchd 脚本 open -R；uploads 挂载宿主机 ~/language-flow-uploads）
→ ✅ 2026-08-19 新增：视频上传标记机制（upload_marks 表 + /api/upload-marks CRUD + 共享弹窗组件）— 嵌入生成记录/详情/文件管理/视频资产/审计管理；视频资产移除重命名（语义误导）改标记入口 + 全部/已上传/未上传过滤；文件管理新增「清理未引用」；删文件联动清标记
→ ✅ 2026-08-19 优化：标记备注预设（6 模板文案 + 自定义）；新建页默认音色云健/BGM free-04-piano-iix + BGM 试听按钮；代码抽离：三模板编辑器/三个列表行组件/audit-panel/word-chips/use-audio-preview/use-upload-marks（TaskList 298 / AuditList 258 / Files 317 行，CreateTask 723 / TaskDetail 661 保留核心流程）
→ ✅ 2026-08-20 优化：已上传/未上传文案统一为已标记/未标记（生成记录/视频资产/行徽章）；文件管理删除确认按类型加固（BGM/配音素材强确认，清理未引用明确仅视频）；修复审计管理表格空白（无指令 <template> 被编译为真实元素致 tr 进入 template.content）；试听状态机单例化（音色/BGM 互斥播放、按钮 UI 跟随点击，+5 单测）；容器栈加固（mysql healthcheck 走 TCP、backend entrypoint 探测超时退出）
→ ✅ 2026-08-20 一致性：上传标记按任务归属（upload_marks 加 task_id + 迁移回填 + 创建自动反查绑定），重新渲染后标记不丢失，任务/视频/审计三页面口径统一；本地 dev 限流解除（仅生产启用）；uploads 目录软链统一（本地与容器共享 ~/language-flow-uploads）；docs/12 更新开发/部署双模式说明
→ ✅ 2026-08-29 优化：① `GET /api/upload-marks/overview` 一览 API（关联视频标题/模板/等级/词数/时长 + platform/keyword）；前端 `/marks` 改走该接口；② 故事主题扩至 8 分类约 44 个预设
→ ✅ 2026-08-29 体验：① 视频播放器手机端收窄居中（max-w 240/280px + 两侧留白），生成页/详情/视频资产；② 故事主题分组扩充 + AI 推荐按钮；③ 新增「上传标记」一览页 `/marks`
→ ✅ 2026-08-23 修复：用户反馈 5 问题（方案见 .trae/documents/问题解决方案.md V2）—
  ① scene_word 生成重构 V4.2：删 NARRATIVE_WORDS 死列表，改混合词表（主题词+随机补足120）+ 两段式生成（LLM 选词 → 内联必用清单写故事）+ 代码全池注入；**修复隐藏根因**：词库释义词性前缀（n./vt.）致义项注入匹配失败；验收下限 5→8（SCENE_MIN_WORDS_PER_CONTENT），真机 4 主题实测成功率 4/4、词数 9~14；
  ② 上传标记弹窗打开时清空 marks/editingId/pendingDeleteId（旧文件数据闪现）；
  ③ 文件管理清理未引用改为全局范围（含配音音频，BGM 不动），type 逐项透传 + 文案同步；
  ④ 问题4「修改文字入视频」暂缓待诊断（TTS 反替换假设为主，诊断 SQL 已记录在文档）；
  ⑤ 新增 ui/spinner.vue，CreateTask 5 处 / TaskDetail 2 处异步按钮加 loading 动画；
  ⑥ 排查生成 500：V4 标注元任务在 qwen2.5:7b 真机不可行 → 两段式 + 词性前缀修复解决

---

## 三、下一步（优先级顺序）

### 阶段 1：工程地基（✅ 全部完成）

| # | 任务 | 状态 |
|---|------|------|
| 1 | 创建 AGENTS.md 行为约束 | ✅ 完成 |
| 2 | 创建 PROGRESS.md 进度文件 | ✅ 完成 |
| 3 | 配置 biome.json | ✅ 完成 |
| 4 | 配置 lefthook.yml | ✅ 完成 |
| 5 | 配置 commitlint | ✅ 完成 |
| 6 | 初始化 pnpm workspace + tsconfig | ✅ 完成 |
| 6a | 创建 .gitignore | ✅ 完成 |
| 6b | 创建 .env.example | ✅ 完成 |
| 6c | 创建 tsconfig.base.json + 3 个子包 tsconfig.json | ✅ 完成 |
| 6d | 创建 3 个 vitest.config.ts + shared 补 test 脚本 | ✅ 完成 |
| 6e | ~~创建 .github/workflows/ci.yml~~ → 2026-08-29 已去除 CI | ✅ 已废弃 |
| 6f | 引入 pino 日志库 + logger.ts | ✅ 完成 |
| 6g | 健康检查端点 + CORS + Rate Limiting | ✅ 完成 |
| 6h | Drizzle ORM schema + drizzle.config.ts | ✅ 完成 |

### 阶段 2：shared 类型包（✅ 全部完成）

| # | 任务 | 状态 |
|---|------|------|
| 7 | packages/shared/src/enums.ts | ✅ 完成 |
| 8 | packages/shared/src/content.dto.ts（含 isSceneWord/isWordCard/isQuiz 类型守卫） | ✅ 完成 |
| 9 | packages/shared/src/request.dto.ts | ✅ 完成 |
| 10 | packages/shared/src/response.dto.ts | ✅ 完成 |
| 11 | packages/shared/src/index.ts（统一导出） | ✅ 完成 |
| 12 | packages/shared/package.json（补 exports） | ✅ 完成 |

### 阶段 3：后端 API

| # | 任务 | 状态 |
|---|------|------|
| 13 | packages/backend 项目骨架（Hono + tsconfig） | ✅ 完成 |
| 14 | Drizzle ORM schema（cet_words + contents 表） | ✅ 完成 |
| 15 | POST /api/cet/validate-words + 测试（13 用例：service 6 + route 7） | ✅ 完成 |
| 16 | POST /api/cet/random-words + 测试（11 用例：service 4 + route 7，高频池 200 随机抽样） | ✅ 完成 |
| 17 | POST /api/tts/generate（Edge TTS 配音 + 本地文件存储） | ✅ 完成 |
| 17a | GET /files/audio\|video/:filename 静态文件服务（防路径穿越） | ✅ 完成 |
| 17b | POST /api/tts/from-content（ContentArray 拼接 + 合成 + ffprobe 时长） | ✅ 完成 |
| 17c | tts 测试补齐（拼接纯函数 5 + 路由 8，共 13 用例） | ✅ 完成 |
| 18 | POST /api/video/render（Playwright 截图 + FFmpeg 合成，三个模板 renderer）+ 测试（时长分配 7 + 路由 9 用例） | ✅ 完成 |
| 19 | @hono/zod-openapi → openapi.json 自动生成（6 API 全收录，/doc Scalar UI，启动时写入 src/openapi.json） | ✅ 完成 |

### 阶段 4：AI 内容生成（2026-08-17 架构变更：去 Dify，后端直连 LLM）

| # | 任务 | 状态 |
|---|------|------|
| 20 | llm.service（OpenAI 兼容调用，Agnes/Ollama 环境变量切换）+ content.service（生成 story + 词库校验）+ POST /api/content/generate + 测试（14 用例：llm 3 + service 4 + route 7） | ✅ 完成 |
| 21 | 生成策略 V3：两阶段（主题词→故事）+ 代码注入（中文词义→英文词）+ 主题回显验收 + 反馈重试 ×3（2026-08-17 实测：科技创业 4 词/美食探店 2 词，主题 100% 正确、文案自然） | ✅ 完成 |
| 22 | 端到端：content/generate → tts/from-content → video/render 串联验证（实测：森林探险 12.12s MP4，1080×1920 h264+aac） | ✅ 完成 |

> 原 #20-24（Dify Workflow YAML）已废弃：docs/05 标注废弃，由 docs/15 取代。

### 阶段 5：Vue 前端

| # | 任务 | 状态 |
|---|------|------|
| 25 | packages/frontend 项目骨架（Vite + Vue 3 + Tailwind） | ✅ 完成 |
| 26 | openapi-typescript 生成 schema.d.ts（592 行，6 API 全收录） | ✅ 完成 |
| 27 | openapi-fetch 客户端封装（src/api/client.ts，类型安全） | ✅ 完成 |
| 28 | 新建任务页（CreateTask.vue，单页全流程：生成→配音→渲染→播放） | ✅ 完成 |
| 29 | 任务列表页（TaskList.vue） | ✅ 完成（2026-08-17，配合 tasks API） |
| 30 | 任务详情页（TaskDetail.vue）+ 视频播放 | ✅ 完成（2026-08-17） |

### 阶段 6：集成验证

| # | 任务 | 状态 |
|---|------|------|
| 31 | 端到端流程验证（generate → 落库 → TTS → render → 回写 → 详情） | ✅ 完成（多次实测） |
| 32 | 读取情景词汇阅读视频模板设计规范，实现 HTML 模板 | ✅ 完成（renderer/templates 早已实现，2026-08-18 核对） |

### 阶段 7：Docker 部署（2026-08-18 完成）

| # | 任务 | 状态 |
|---|------|------|
| 33 | Dockerfile.backend（Node 24 + ffmpeg + 中文字体 + Chromium，npmmirror 下载） | ✅ 完成 |
| 34 | Dockerfile.frontend（gen-api → vite build → nginx:alpine，同源部署 VITE_API_BASE_URL=""） | ✅ 完成 |
| 35 | entrypoint.sh（等 MySQL → migrate → seed → 启动，tsx 运行时）+ src/db/migrate.ts | ✅ 完成 |
| 36 | docker-compose.yml 三服务编排（mysql healthcheck / backend / frontend 反向代理） | ✅ 完成 |
| 37 | 实测：health / 前端页面 / 音频视频文件 / 容器内渲染 1080×1920 MP4 全部通过 | ✅ 完成（2026-08-18） |
| 38 | 环境处理：OrbStack registry-mirrors（Docker Hub 不通）+ 旧库 34 条记录迁移 + uploads 拷贝 | ✅ 完成（2026-08-18） |

### 阶段 7a：生产版本双轨与三轨端口解耦（2026-09-21）

| # | 任务 | 状态 |
|---|------|------|
| 39 | docker-compose.yml 去 `build:` 改 `image: ${APP_VERSION}`；版本与端口入 `deploy/prod.env`（tag + PROD_UI_PORT） | ✅ 完成 |
| 40 | 发布/回滚/版本命令：`docker:release`（工作树→打 `v<git SHA>`→切版本）/ `docker:rollback` / `docker:version`；`docker:up` 不再构建 | ✅ 完成 |
| 41 | 生产 UI 改到 `127.0.0.1:15173` 且后端不映射宿主 8080；`pnpm dev` 不再停生产容器（三轨可并行） | ✅ 完成 |
| 42 | `stack.sh free_ports` 改为只杀本仓进程（不再误 `kill` OrbStack 主进程） | ✅ 完成 |
| 43 | 生产栈去掉 `NODE_ENV=production`（该 tag 无只读端点限流豁免，开着必 429） | ✅ 完成 |
| 44 | 防误连生产库：`dev`/`db:*`/`openapi:gen` 默认值指 :3307；`requireSafeWriteTarget()` 护栏（回环 :3306 需 `DB_ALLOW_PROD=1`） | ✅ 完成 |
| 45 | 文档同步：docs/12 §二/§三/§六 + 更新记录、AGENTS.md §零、README 快速开始 | ✅ 完成 |
| 46 | 切换动作（镜像打 tag + 生产栈 recreate）：属基础设施操作，交用户执行 | ⏳ 待用户执行 |
| 47 | Finder 定位桥：`reveal-watcher.sh` 改扫 `~/language-flow-uploads*/.open-requests`（原本只覆盖生产目录，测试栈/本地 dev 的定位请求无人消费）+ 目标缺失 60s 宽限丢弃 | ✅ 完成（2026-09-21，沙箱内三场景用例验证） |

---

## 四、已完成

- [x] 项目定位与需求（PRD.md）
- [x] 技术选型（SPEC.md §2.2）
- [x] ContentDTO 数据结构设计（04 文档）
- [x] Dify Workflow 节点设计（05 文档，已废弃，由 docs/15 取代）
- [x] 系统模块划分（03 文档）
- [x] API 接口契约定义（SPEC.md §五）
- [x] 模板设计规范（情景词汇阅读视频模板设计规范）
- [x] README 项目概览
- [x] AGENTS.md 行为约束
- [x] Git 自动化方案确定（lefthook + commitlint + Biome + Vitest）
- [x] 分支策略确定（main + feature/*，PR 自审）
- [x] tsconfig 配置文件（base + 3 个子包）
- [x] .gitignore + .env.example
- [x] Vitest 测试基础设施配置
- [x] ~~GitHub Actions CI 流程~~（2026-08-29 已去除，改 lefthook 本地门禁）
- [x] pino 日志方案集成
- [x] 后端骨架：健康检查 + CORS + Rate Limiting
- [x] Drizzle ORM schema 定义（contents + cet_words 表）
- [x] Backend serve() 启动 + 错误处理 + 请求日志中间件
- [x] db/index.ts 数据库连接初始化
- [x] POST /api/tts/generate：Edge TTS WebSocket 合成 MP3 + 本地文件存储（2026-07-29）
- [x] GET /files/audio|video/:filename 静态文件服务（校验路径穿越）
- [x] POST /api/tts/from-content：拼接 + 合成 + ffprobe 时长探测，TTS 契约唯一化（2026-08-16）
- [x] 文档冲突修复：TTS 契约统一（SPEC §5.2 双端点/§7.3、docs/05 全链）、空 segment 丢弃、wordList 转换、清单类对齐（2026-08-16）
- [x] shared 类型包：enums + ContentDTO + Request/Response DTO + 类型守卫（2026-08-16）
- [x] POST /api/cet/validate-words：词库精确匹配（Drizzle inArray + level 过滤）+ 13 用例测试（2026-08-16）
- [x] 数据库对接：MySQL 8.4 容器（arm64v8/mysql:8.4）+ drizzle migration 建表（cet_words + contents）（2026-08-16）
- [x] 文档全面完善：新增 08-12 五份设计文档（TTS/词库/渲染/前端/部署），修订 README + SPEC §5.2 音色契约（2026-08-16）
- [x] Frontend 入口文件（vite.config.ts / index.html / main.ts / App.vue）
- [x] Tailwind CSS 4 Vite 插件接入
- [x] .nvmrc + .node-version（Node 24）
- [x] docker-compose.yml（MySQL 8.4）
- [x] .editorconfig
- [x] 审计档案（audit 列 + 候选词来源/重试历史/修改日志 + 详情/管理页展示）（2026-08-18）
- [x] 审计管理界面：搜索/批量删除/分页/行展开（2026-08-18）
- [x] 视频资产页：播放/重命名/删除（PRD 10.1.5）（2026-08-18）
- [x] 词库补齐高中基础词 3920→5999 + 抽词池修复（功能词过滤/全表洗牌）（2026-08-18）
- [x] 导航栏 shadcn 组件化（Button + Pagination + ConfirmDialog + Toaster）（2026-08-18）
- [x] word_card 单词卡片模板全链路（生成→配音→渲染→详情）（2026-08-18）
- [x] quiz 选择题模板全链路（代码构造答案 + 题干代码化）（2026-08-18）
- [x] 选择题音画对齐：逐题合成 + 1s 缓冲 + 提示音 + 0.8s 题间间隔（2026-08-18）
- [x] TTS 混合音色（Edge 8 + Mac 本地 3，按 voice 分发引擎）+ 语速调整（rate 0.5-2）（2026-08-18）
- [x] 词性不朗读（word_card/quiz 释义前缀剥离）+ 拼接上限 2000 字符（2026-08-18）
- [x] 生成页 BGM/语速可选 + 三步拆分（生成/配音/渲染独立可重试）（2026-08-18）
- [x] Docker 容器化部署：三服务编排 + 自动 migrate/seed + 容器内渲染实测（2026-08-18）

---

## 五、关键决策记录

| 日期 | 决策 | 理由 |
|------|------|------|
| 2026-07-28 | 前端选 Vue 不选 React | 开发者更熟 Vue |
| 2026-07-28 | 技术栈：Hono + Drizzle + Vue 3 + shadcn-vue | 轻量 TS 全栈，与 Dify Code 节点语言统一 |
| 2026-07-28 | API 管理：@hono/zod-openapi → openapi-typescript → openapi-fetch | 编译期类型安全，零手动同步 |
| 2026-07-28 | typecheck 放 pre-push 不放 pre-commit | commit 高频不应卡，push 是聚合检查点 |
| 2026-07-28 | commitlint 强制 | 保证历史可读，后续自动化 changelog |
| 2026-07-28 | 分支策略：main + feature/*，PR 自审 | solo 开发够用，不重 |
| 2026-07-28 | 代码检查：Biome 替代 ESLint + Prettier | 一个工具替代两个，速度快 30-50x |
| 2026-07-28 | 日志方案：pino + pino-pretty | Node.js 最快结构化日志，Hono 原生支持 |
| 2026-07-28 | 限流方案：hono-rate-limiter | 轻量，按 IP 限流，无需 Redis |
| 2026-07-28 | ~~CI/CD：GitHub Actions~~ | 2026-08-29 决策去除；质量检查改 lefthook + 手动命令 |
| 2026-08-29 | 去除 GitHub Actions CI | 本仓库不跑远程 CI；文档与 README/SPEC 已同步 |
| 2026-09-21 | 生产与开发代码版本双轨：生产跑 `deploy/prod.env` 锁定的镜像 tag，测试栈/dev 跑工作树 | 共用工作树构建时，任何一次 `docker:up`/`docker:test` 都会覆盖生产镜像；实测还因 dev/生产同占 5173+8080 导致新 UI 打到老后端（404/429）与成片误写生产库 |
| 2026-09-21 | 生产 UI 换到 15173、后端不映射宿主端口，而非把本地 dev 换端口 | 5173/8080 已写进 AGENTS.md/README/docs 与用户习惯；改动面限制在生产侧，compose + docs/12 即可 |
| 2026-09-21 | 生产栈限流改用配置层关闭（不设 NODE_ENV）而非改代码 | 用户要求“老版本不更新”；限流豁免只存在于未提交工作树，改代码等于提前发布 |
| 2026-09-21 | `db:*`/`dev` 脚本默认值指 :3307 + 写库护栏，`.env` 仍保留生产连接串 | Node 的 `--env-file` 不覆盖已导出 env，默认值可安全兼底；容器内主机名是服务名 `mysql`，不误伤发布迁移链路 |
| 2026-09-21 | API 文档可视化选 Swagger UI（自托管）而非 Scalar/CDN | 项目本地/离线优先，Docker 运行时无外网保证；swagger-ui-dist 本地静态资源 + 覆盖度门禁 + lefthook 自动生成 |
| 2026-09-21 | db 由单连接改为 createPool（懒建连） | 文档生成 openapi:gen / 覆盖度测试导入路由时不要求 MySQL 在线；MySQL 重启旧连接失效由池自愈 |
| 2026-07-28 | 测试框架：Vitest 3 | 与 Vite 共享配置，backend=node / frontend=jsdom |
| 2026-08-17 | 去 Dify：后端直连 LLM（/api/content/generate） | 简化架构，少一个部署依赖，env 切换模型 |
| 2026-08-17 | 模型：纯本地 Ollama qwen2.5:7b（不用 Agnes） | 完全免费离线；质量不足可换 14b 或接免费云 API |
| 2026-07-28 | Node 版本：24 | 最新 LTS，与 pnpm 11 配套 |
| 2026-07-28 | Tailwind 4 Vite 插件 | 替代 PostCSS，零配置启动 |
| 2026-07-28 | 本地数据库：Docker Compose | MySQL 8.4，一键启动 |
| 2026-08-16 | 背景图方案：暂用纯白背景（background 固定 "white"），不做预设图片库 | 最小可用，视觉方案后续再扩展 |
| 2026-08-16 | shared 类型包落地：TS 字面量联合 + const 对象（satisfies）替代 TS enum | 值仍为 snake_case 字符串，编译期可穷尽检查，无 enum 运行时开销 |
| 2026-07-29 | TTS 方案：Edge TTS（微软公开 WebSocket 接口）而非 Azure SDK / 云服务 | 零成本、零密钥，中文女声质量高；无需新依赖，ws 直连 |
| 2026-08-16 | TTS 音色：VoiceConfig.id 抽象 ID（female_01 等）→ Edge TTS 音色映射表（SPEC §5.2）；tts 接口直接收 Edge 音色名 | Mac 本地 say 不可作生产方案（仅 macOS、音色少、不可部署），按用户决定直接用 Edge TTS |

---

## 六、阻塞项

无

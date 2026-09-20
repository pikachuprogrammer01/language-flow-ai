# TODOS — 评审延后项收集

> 来源：/autoplan 评审流水线（2026-09-19，CEO/Design/Eng 三阶段延后裁定）。
> 各项均经"超出本批 blast radius / 属独立批次"理由筛出，非遗漏。

## 战略 / 产品

- [ ] **平台指标回流表 + 学习闭环**（播放/完播/互动快照 → 变体对比 → 选题配方）
  - 走 PRD → SPEC → docs → 代码流程（AGENTS §6.3），入口建议 `/office-hours`
  - 来源：CEO 阶段 NOT-in-scope 裁定；现状"数据分析"页零真实指标
- [ ] **产品定位/客群聚焦重估**（CapCut/Canva 同质化 vs 教学内容 moat）
  - 来源：CEO Codex 通道 10x 建议，不阻塞收口批

## 工程 / 基建

- [ ] **E2E 浏览器测试基建**（Playwright test runner + 键盘导航/移动端布局用例）
  - 本批以单测 + `pnpm test:integration`（真实 MySQL）+ 手动 QA 清单替代
  - 来源：Eng TX14 defer（基建扩建超本批半径）
- [ ] **1080P WebGL 渲染性能优化**
  - 无实测性能问题，出现后再立项；来源：初始评审不做清单
- [ ] **片头黑屏探针多点采样**（当前 t=0.3 单点，动态主题可能漏检）
  - 来源：CEO H2；本批仅修"缺失=-1 放行"路径

## 数据治理

- [ ] **渲染产物过期策略**（改 voice/BGM/片头设置后旧 MP4 的失效标记）
  - 本批仅 UI 提示"更改只影响下一次渲染"；来源：Eng NOT-in-scope
- [ ] **全仓时间列统一 datetime(UTC) 治理**（本批仅 video_analytics.publish_at 一列）
  - 来源：Eng E13 范围收敛
- [ ] **upload_marks.task_id 同族孤儿行评估**（与 video_analytics FK 同类风险）
  - 来源：Eng E4 关联发现，本批只修 video_analytics

## 仓库卫生

- [ ] `packages/.DS_Store` 解除跟踪 + `.gitignore` 补条目（存量，单独 1 行 commit）

## DX / 上手体验（autoplan Phase 3.5 延后）

- [ ] **一键 setup/doctor**（`pnpm setup` 校验 Node/pnpm/Docker/ffmpeg/Ollama/Chromium + 建 env + 迁移 seed + 打印下一步；`pnpm doctor` 诊断）
  - 本批仅做"零谎言档"（.env.example 纠偏 + README 步骤补全）；TTHW 目标 15min → <5min
- [ ] **Golden-path contributor 页**（setup→run→加路由→加渲染器→gen 契约→测试→文档，9 段全 copy-paste 示例）
  - 来源：DX X8；现 README"添加模板"3 步过于概念化
- [ ] `scripts/stack.sh` 端口强杀行为收敛（仅杀本仓进程/交互确认），本批先在 README 声明行为

# BMAD + AOCI 适配协议（bmad-aoci-protocol）

> owner：ADAPTER
> 版本：v1.0（2026-09-30，按 2026-09-28 用户已批准的低侵入适配方案创建）
> 定位：本文件是 BMAD（TO-BE 工作流）与 AOCI（AS-IS 仓库认知）两套第三方工具链在本仓的**唯一协调层**。
> 约束力：所有新增规则均标注 owner；第三方 runtime 文件（`_bmad/` 根部与模块区、`.qoder/skills/`、`aoci.txt` 工具区）禁止直接修改，定制一律进 `_bmad/custom/` 与 `docs/ai-adapters/`（owner：ADAPTER）。

---

## 一、S0–S4 任务路由表（owner：ADAPTER，映射到官方 BMAD skills，owner：BMAD）

按任务复杂度择低路由，禁止跳级重型化；`bmad-help`（owner：BMAD）用于路由不确定时的官方问询入口。

| 级别 | 场景 | 入口 skill（官方名） | 说明 |
|------|------|---------------------|------|
| S0 | 只读问答 / 代码查询 / 状态核验 | **不进入 BMAD 工作流** | 按 AGENTS.md AOCI 合同取认知（不可用则走 §四 fallback），直接回答 |
| S1 | 小改动 / bug 修复（≤3 文件） | `bmad-spec`（oneshot 路线）或直改 | 直改时仍遵守 AGENTS.md §五 范围限制 |
| S2 | 单功能交付 | `bmad-spec` → `bmad-build` | spec 为唯一事实源；build 内含 review |
| S3 | 多故事 / epic 级特性 | `bmad-create-epics-and-stories` → `bmad-build` / `bmad-build-auto` | 规划产物落 `bmad-output/` |
| S4 | 项目级未知领域 / 大型重构 | `bmad-deep-recon` / `bmad-brainstorming` / `bmad-prd` → S3 链路 | 需用户确认后启动 |

路由表外的官方 skill（agent 人格、`bmad-ux`、`bmad-architecture` 等，owner：BMAD）按需由用户显式调用，适配层不自动派发。

## 二、生命周期门禁（owner：ADAPTER）

任何 S2+ 任务必须按下列顺序流经门禁；「 Implementation」之前的三道门禁缺一不可：

```
BMAD Planning → Coding Agent → AOCI Context → Implementation → Verification → AOCI Alignment → BMAD Review
```

1. **BMAD Planning**（owner：BMAD）：`bmad-spec`/规划产物成形，明确验收标准。
2. **Coding Agent 指派**（owner：ADAPTER）：规划完成后显式指派实现角色（默认 `bmad-agent-dev` 人格或本 Agent），禁止规划与实现身份混淆。
3. **AOCI Context**（owner：AOCI）：动手写码前取得当前仓库认知——`aoci_rules` → 需要全貌时 `aoci_overview`；认知不可用时执行 §四 fallback，**不得静默跳过这一步**。
4. **Implementation**（owner：PROJECT）：按 AGENTS.md §一~§五 架构边界与代码规范实施。
5. **Verification**（owner：PROJECT）：`pnpm typecheck` + `pnpm lint` + 相关测试；新增 API 配新增测试（AGENTS.md §七）。
6. **AOCI Alignment**（owner：AOCI）：受管理对象达到**最终稳定状态后**调用一次 `aoci_maintain`；有语义候选则按合同创作并经 `aoci_update_entry` 提交。中间提交不逐次对齐。
7. **BMAD Review**（owner：BMAD）：`bmad-build` 内置 review 层或单独 `bmad-review`/`bmad-code-review` 收口。

## 三、所有权矩阵（owner：ADAPTER）

| 资产 | owner | 写权限归属 |
|------|-------|-----------|
| `AGENTS.md` / `PROGRESS.md` / 业务代码 / `docs/*.txt` / `SPEC.md` | PROJECT | 按 AGENTS.md §一 既有规则；BMAD/AOCI installer 均不得改写 |
| `aoci.txt` / `aoci.meta.txt` / `aoci.code.txt` / `.aoci/` | AOCI | 仅 AOCI 工具链按其合同维护 |
| `_bmad/`（custom/ 除外）/ `.qoder/skills/` | BMAD | 仅官方 installer/update 维护，运行时只读 |
| `docs/ai-adapters/` / `_bmad/custom/` | ADAPTER | 本适配层定制唯一落点，随仓库提交 |
| `bmad-output/` | BMAD（产物区） | 规划/实现产物；不入 Git（见 §六） |

**冲突裁决**：BMAD skill 输出若与 AGENTS.md / docs 设计文档冲突，以 PROJECT 侧为准；AOCI 认知与源码冲突，以源码为准并走 AOCI 维护修正认知。

## 四、Fallback 规则（owner：ADAPTER，硬规则，写死于本文件）

1. **AOCI 不可用**（MCP 未注册 / 工具调用失败 / 索引不可靠）→ 按序退化：SearchCodebase/Grep 语义检索 → Read 直读相关源码与 `docs/` 设计文档 → 在交付说明中声明「本次未使用 AOCI 认知」。禁止因 AOCI 不可用而阻塞任务。
2. **BMAD 不可用**（`.qoder/skills/` 被移除 / installer 缺失）→ 回到 AGENTS.md 既有流程：PROGRESS.md 驱动 + docs/ 先读后写 + Verification 门禁照常执行。项目 build/test 对 BMAD 零依赖。
3. **两者同时不可用** → 纯 AGENTS.md + 源码路径继续工作，本文件退化为纯文档。
4. `persistent_facts`（见 `_bmad/custom/bmad-build.toml`，owner：ADAPTER）把规则 1 注入 `bmad-build` 全程上下文，保证实现子代理同样受约束。

## 五、Model Router 预留插槽（owner：ADAPTER）

当前**未启用**任何模型路由绑定（硬约束：禁止硬编码绑定具体模型）。预留插槽：

- 插槽 A：规划类 skill（`bmad-spec`/`bmad-prd`/`bmad-deep-recon`）→ 由 ADAPTER 在 `_bmad/custom/<skill>.toml` 的 handoff/recipe 覆盖中声明，未来可绑定强推理模型。
- 插槽 B：实现类（`bmad-build` 的 `implementation_handoff`，owner：BMAD 提供表面）→ 覆盖写在 `_bmad/custom/bmad-build.toml`，未来可绑定编码特化模型。
- 启用条件：用户明确决策 + 本文件升版；绑定关系只允许出现在 custom/ 覆盖与本章插槽说明中。

## 六、安装 / 更新 / 卸载与版本控制（owner：ADAPTER）

- **安装**：官方 npm 包 `bmad-method` 的 installer（`node tools/installer/bmad-cli.js install --yes --modules core,bmm --tools qoder --output-folder bmad-output`）。目标平台 Qoder → `.qoder/skills/`；BMAD 运行时 → `_bmad/`。
- **更新**：重跑 installer 并携 `--action update`（或 `quick-update`）；installer 会重写 `_bmad/` 与 `.qoder/skills/`，但**从不触碰** `_bmad/custom/`、`_bmad/custom/config*.toml` 与本目录。
- **卸载**：官方 `bmad uninstall`（installer 自带 uninstall 命令）移除 `_bmad/` 与平台 skill 目录；适配层文件（本目录 + custom 覆盖）保留亦无害，删除即完全脱钩。
- **Git 策略**（owner：PROJECT，与 §STEP 6 方案一致）：`_bmad/` 整体忽略、反向豁免 `!_bmad/custom/`；`.qoder/skills/` 与 `bmad-output/` 忽略（第三方产物与个人输出不入库）；`docs/ai-adapters/` 与 `_bmad/custom/` 入库——换机器重跑 installer 后定制即生效。

## 七、既有治理关系（owner：ADAPTER）

- AGENTS.md 的 AOCI 合同（`aoci:begin` 区块）与治理规则**不受本方案影响**，优先级高于本文件。
- 适配层在 AGENTS.md 中仅以 `<!-- bmad-aoci:start/end -->` 托管块存在（约 10 行指引），块内只指向本文件，不复述细节。
- PROGRESS.md 进度职责归 PROJECT；BMAD 的 sprint 产物落 `bmad-output/`，**不得接管** PROGRESS.md。

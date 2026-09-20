# DSH 的 RSI 案例与插件：按可见热度的真实排名

**核查时间：2026-09-18（UTC+8）。一句话结论：DSH 的“插件目录”很大（README 实数 3,852 条，站点 badge 报 3,836 条），但可证明有 DSH 接入的高热度 RSI 主要来自少数跨-runtime 上游项目；真正 DSH-native、自称 self-evolving 的头部只有 317★/217★/199★，两份同名 `dsh-evolve` 仅 11★ 与 8★。**

这里的“第三方痕迹”严格采用老板指定的可量化代理：star、fork、公开 issue；它证明外部注意/协作，不证明插件安装量、效果或安全。`活` 的定义是核查日往前 14 天内有 push；`缓` 是超过 14 天，**不等于项目已死**。所有星数是当日 GitHub REST 元数据快照，仓库链接就是复核入口。

## 先把生态水分挤掉

* curated README 自称只收 `dsh plugin add` 可安装、且声明 `dsh.bundle` 的项目；原文：> “each declares a `dsh.bundle` manifest”。[名单 README](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。本轮逐段读取 `BEGIN PLUGINS` 到 `END PLUGINS`，实际条目数 **3,852**；同日 [计数 badge](https://awesome-dsh-plugin.com/count.json) 返回 `"message":"3836"`。数字不一致，所以不能假装有一个精确的官方总数。
* 它的类别分布本身说明为什么不能把全目录当 RSI：UI 656、Tools 515、Development & Runtime 290、Sessions 244、Workflow 232、Usage 209、Models 179、Memory 179、Skills 154、Just for Fun 116；只有“AGI Architecture Exploration” 9 条。上述 README 也明确说列表“不 rank plugins or judge their quality”。
* GitHub topic 搜索补网得到 **15,287** 个 `topic:dsh-plugin` repo，且头部含与 DSH 无关的简历工具、图床等。因此它只能用于发现候选，不能当“DSH 插件数”或排名依据。搜索结果中官方 `deepseek-harness` 是 228,415★，但它是宿主不是插件，已排除。
* 未认证 GitHub Code Search 对 `"dsh.bundle" filename:package.json` 返回 `Requires authentication`；故本报告不伪造“全 GitHub 无遗漏”。curated list 的准入声明是 native-bundle 的可验证基线，额外发现的 repo另列为 integration。

## 热度榜 A：确有 DSH integration 的 RSI / 长期学习上游项目

这些仓库在 curated list 中确有 DSH 的 plugin/config 子目录或 DSH 描述，但其大星数**通常是整个上游项目**的星，不是 DSH adapter 的安装数。这一栏回答“DSH 用户能接入什么成熟 RSI 能力”，不能用来宣称“DSH native 插件有这么多用户”。

| 排名 | 项目（核查日） | 一句话是什么 | RSI 相关性 | 第三方使用痕迹 | 最近活动 / 状态 |
|---:|---|---|---|---|---|
| 1 | [OpenViking](https://github.com/volcengine/OpenViking/tree/main/examples/dsh-memory-plugin) — **37,935★**, 2,938 forks, 728 open issues | 上游自称 “Self-evolving Context Database”；其 curated DSH bundle 做 pre-step auto-recall、profile injection、session capture 和 memory tools。名单原文：> “OpenViking memory and context bundle for DeepSeek Harness”。 | **高**（memory/RAG/skill 统一；不是自改 DSH loop） | **有（很强）**：stars/forks/issues；但均为上游项目级 | 2026-09-18 push，活 |
| 2 | [Ouroboros](https://github.com/Q00/ouroboros/tree/main/integrations/dsh-plugin) — **6,015★**, 605 forks, 103 open issues | “Agent OS”；DSH 侧是 config-only MCP bundle，开放 36 个 interview/seed/execution/evaluation/evolution tools。名单原文：> “Config-only bundle … evolution workflow tools in DSH”。 | **高**（有 staged evaluation、budgeted evolution loop；外部 runtime） | **有（强）**：项目级 stars/forks/issues | 2026-09-15 push，活 |
| 3 | [MemSearch](https://github.com/zilliztech/memsearch/tree/main/plugins/dsh) — **2,623★**, 251 forks, 252 open issues | 共享 Markdown + Milvus persistent memory；DSH adapter 做 auto-capture、pre-step injection、recall、memory→skill evolution review panel。名单原文：> “memory-to-skill self-evolution through a review panel”。 | **高**（记忆沉淀到 skill；非 self-modifying harness） | **有（强）**：项目级 stars/forks/issues | 2026-09-18 push，活 |
| 4 | [dsh-context](https://github.com/bowenliang123/dsh-context) — **1,429★**, 44 forks, 0 open issues | DSH 原生 context lifecycle dashboard/browser：composition、compaction/injection 与 evolution trend 的可视化。GitHub 描述原文：> “context statistics, composition, breakdown, evolution details”。 | **低**（观察/管理 context，不会自行学习或改造） | **有**：stars/forks | 2026-09-18 push，活 |
| 5 | [graph-memory](https://github.com/adoresever/graph-memory) — **626★**, 91 forks, 19 open issues | DSH/OpenClaw graph-memory：从对话抽 triples，让跨 session 经验可复用。GitHub 描述原文：> “enables cross-session experience reuse”。 | **中**（记忆，不等于自动改进） | **有**：stars/forks/issues | 2026-09-09 push，活 |
| 6 | [dsh-mnemon](https://github.com/omdsh-dev/dsh-mnemon) — **383★**, 32 forks, 7 open issues | DSH 的可组合、view-based 三层 memory。 | **中**（长期记忆基础设施） | **有**：stars/forks/issues | 2026-09-18 push，活 |

来源与限定：OpenViking、Ouroboros、MemSearch 的 DSH 接入均由 [curated README](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 明列；GitHub project descriptions 分别为 > “Self-evolving Context Database for AI Agents”、> “the agent gets smarter on its own”、> “persistent, unified memory layer … DSH”。这些是作者/项目声明，不是 DSH adapter 的独立 benchmark。

## 热度榜 B：DSH-native、RSI 味道够重的项目

排名只按当天 star，明确过滤掉纯 UI、宠物、主题、普通工具。这里的“高”= 自动从轨迹/回合生成、评审、沉淀或替换 harness state；“中”= durable memory/continuation/agent team；“低”= 仅可视化或一次性辅助。每行都包含最近 push，以免用死仓库骗老板。

| 排名 | 项目（URL；stars / forks / open issues） | 一句话是什么（源码/名单原文摘要） | RSI | 第三方使用痕迹 | 最后 push；判定 |
|---:|---|---|---|---|---|
| 1 | [csyangwen/dsh-memory-evolve](https://github.com/csyangwen/dsh-memory-evolve) — **317 / 31 / 3** | “跨会话长期记忆 + 后台自我进化”：五轨 memory、turn 内 self-review、skill self-evolution/manager、COI scheduler；无需 core patch。 | **高** | **有**：317★、31 forks、3 issues | 2026-09-15；活 |
| 2 | [FuRongJun-1999/dsh-memory](https://github.com/FuRongJun-1999/dsh-memory) — **217 / 15 / 1** | 白箱 AGI 探索：metacognition loop、continual learning knowledge flywheel、world model、bootstrap self-improvement。 | **高**（声明强；需独立 eval） | **有**：217★、15 forks、1 issue | 2026-09-18；活 |
| 3 | [GraySilver/dsh-evolve-modes](https://github.com/GraySilver/dsh-evolve-modes) — **199 / 10 / 1** | 可组合、可审查的 task controls 与 isolated human-reviewed self-evolution。 | **高** | **有**：199★、10 forks、1 issue | 2026-09-14；活 |
| 4 | [modusensus/dsh-mneme](https://github.com/modusensus/dsh-mneme) — **112 / 13 / 15** | “memory that dreams”：跨 session memory，idle `autoDream` consolidation、冲突冻结供人审、audit trail。 | **高**（自整合 memory，不改 loop） | **有**：112★、13 forks、15 issues | 2026-09-18；活 |
| 5 | [Phant0Meow/dsh-meow-memory](https://github.com/Phant0Meow/dsh-meow-memory) — **107 / 10 / 7** | 七层 SQLite memory；keyword recall 和 idle-window “dream” consolidation。 | **中** | **有**：107★、10 forks、7 issues | 2026-09-10；活 |
| 6 | [HsiangNianian/dsh-auto-continue](https://github.com/HsiangNianian/dsh-auto-continue) — **101 / 9 / 3** | 非人为中断后自动“继续”，具 error classification、adaptive backoff、idempotency/loop guards。 | **中**（自动续跑，不学习） | **有**：101★、9 forks、3 issues | 2026-09-12；活 |
| 7 | [PerryLink/dsh-memento](https://github.com/PerryLink/dsh-memento) — **102 / 3 / 2** | bounded/layered/approval-gated/auditable cross-session memory，typed `ctx.memory` seam。 | **中** | **有**：102★、3 forks、2 issues | 2026-09-16；活 |
| 8 | [diqierjia/StrataGate-AgentMemory](https://github.com/diqierjia/StrataGate-AgentMemory) — **92 / 6 / 2** | six-layer、time-decaying memory + knowledge graph，自动 capture 和 evidence-gated recall。 | **中** | **有**：92★、6 forks、2 issues | 2026-09-18；活 |
| 9 | [Aik358/dsh-auto-memory](https://github.com/Aik358/dsh-auto-memory) — **71 / 7 / 0** | zero-prompt recall、三层自动 consolidation、skill crystallization、handoff/PLAN 跨 context-window。 | **高**（记忆→skill 的真实机制描述） | **有**：71★、7 forks | 2026-09-16；活 |
| 10 | [wowyuarm/dsh-agent-team](https://github.com/wowyuarm/dsh-agent-team) — **30 / 8 / 1** | 持久 agent team：成员有私有 memory/notes/skills，跨 session 用 channels/tasks 协作。 | **中**（组织与持久状态） | **有**：30★、8 forks、1 issue | 2026-09-18；活 |
| 11 | [quqxui/dsh-memgas](https://github.com/quqxui/dsh-memgas) — **26 / 1 / 2** | 四通道融合检索 + “记忆演化闭环”，引用 MemGAS 方法。 | **高**（但小样本、无公开 eval 证据） | **有（弱）**：26★、1 fork、2 issues | 2026-09-05；活 |
| 12 | [ZK-Andy/dsh-continual-evolve](https://github.com/ZK-Andy/dsh-continual-evolve) — **18 / 0 / 0** | versioned/auditable/rollback-safe harness state，以 session trajectory 及 benchmark validation loop 精炼。 | **高**（最贴近 RSI 表述） | **无**：0 forks、0 issues；18★仅注意信号 | 2026-09-04；活 |
| 13 | [Co-Engram](https://github.com/Co-Engram/Co-Engram/tree/main/packages/dsh-plugin) — **12 / 0 / 0** | plain Markdown/git 的 self-evolving team memory：reinforcement、decay、sleep consolidation。 | **高** | **无**：0 forks、0 issues | 2026-08-22；**缓** |
| 14 | [william-jin-cmu/dsh-evolve](https://github.com/william-jin-cmu/dsh-evolve) — **11 / 0 / 2** | session 内 agent 写 ESM Cordis plugin、`evolve_add/remove/list` 热挂/卸载/恢复。 | **高**（唯一直接“自己长工具/钩子”） | **有（弱）**：11★、2 issues；0 forks | 2026-08-13；**缓** |
| 15 | [jasen215/dsh-continual-harness](https://github.com/jasen215/dsh-continual-harness) — **9 / 1 / 0** | 号称 continual learning、persistent memory、review/refine、automatic rollback。 | **高**（作者声明；没有结果证据） | **有（弱）**：9★、1 fork | 2026-09-10；活 |
| 16 | [chenzheshushi-commits/dsh-evolve](https://github.com/chenzheshushi-commits/dsh-evolve) — **8 / 0 / 2** | memory + skill lifecycle：deterministic recall、reinforcement、skills crystallize/refine/archive/rollback。 | **高** | **有（弱）**：8★、2 issues；0 forks | 2026-09-17；活 |
| 17 | [skepsun/dsh-engram](https://github.com/skepsun/dsh-engram) — **6 / 1 / 4** | zero-LLM auto-capture、symbolic index、evidence/task protocol，含 offline recall eval。 | **中** | **有（弱）**：6★、1 fork、4 issues | 2026-09-14；活 |
| 18 | [bycall/dsh-answer-reviewer](https://github.com/bycall/dsh-answer-reviewer) — **2 / 0 / 0** | 每个 final answer 由独立 LLM 打 1–100；低分 steer 回去重做。 | **高**（self-critique，但没有长期学习） | **无**：0 forks、0 issues | 2026-09-15；活 |
| 19 | [CAI-MH/dsh-quality-review](https://github.com/CAI-MH/dsh-quality-review) — **1 / 0 / 1** | completed turn 独立 reviewer 审核，最多两轮修复。 | **高**（self-critique） | **有（极弱）**：1 issue；0 forks | 2026-09-10；活 |
| 20 | [Dayi-Z/dsh-learn-wiki](https://github.com/Dayi-Z/dsh-learn-wiki) — **1 / 0 / 0** | 重复失败时后台限流联网、distill 入 staging、双阶段 commit 才可 recall。 | **高**（学习闭环设计） | **无** | 2026-09-18；活 |

说明：B 榜的 star 中位数为 **48.5★**（20 条；第 10/11 名 30 与 26 的中点）；若只取直接 self-evolve / self-critique 的 11 条，头部是 317★，其余迅速跌至两位/个位数。这个陡降就是生态真实体量：**“RSI 叙事”很多，独立使用痕迹很薄。**

## 两份 dsh-evolve 与 DeepDeck：时间线和证据强弱

### `william-jin-cmu/dsh-evolve`（原问题的那个；不是 `dsh-external` org）

* 2026-08-06 创建；最后代码 push **2026-08-13**；当日 **11★、0 fork、2 open issues**。GitHub 仓库的 `dsh-external/dsh-evolve` URL 会重定向到这个个人仓库。
* 最新 commit [37462647](https://github.com/william-jin-cmu/dsh-evolve/commit/37462647f896) 的原文非常重要：> “agent/step and agent/settled … do not exist in mainline: listeners … never fire”，随后改为 `agent/pre-step` 和 `agent/turn-stopping`。这不是想象的风险，是作者亲自修过的 event-surface 失配。
* 两条公开 issue 是第三方失败痕迹，标题分别为 > “git 安装后无法运行: 无构建产物且连 build 脚本都没有” 与 > “安装后启动崩溃”。[Issues](https://github.com/william-jin-cmu/dsh-evolve/issues)。结论：**概念最直接，工程信号不够好；别作为生产 RSI 基座。**

### `chenzheshushi-commits/dsh-evolve`（同名、不同项目）

* 2026-08-23 创建，最新 push **2026-09-17**；**8★、0 fork、2 open issues**。它不是任意 ESM self-mount，而是 memory/skill lifecycle。
* 最新 [5d3ca01](https://github.com/chenzheshushi-commits/dsh-evolve/commit/5d3ca01e22c9) 自审称旧测试 “4/4 pass”、326 tests 全绿、四套 E2E 全过，但 config snapshot defect 仍漏掉；README release notes 也承认此前声称检查到了它其实没有。这个是罕见的**作者自揭测试假阳性**，应加分于诚实，不该当成第三方验证。
* 其公开 issue 包含 > “Retrieval precision: a single shared 2-gram recalls unrelated records”。[Issues](https://github.com/chenzheshushi-commits/dsh-evolve/issues)。结论：**活跃、重治理，但使用信号仍近零。**

### [DeepDeck](https://github.com/jo32/DeepDeck)

* 2026-08-17 创建、最后 push 2026-09-17；**26★、1 fork、1 open issue**。它是 macOS desktop workspace，用 DSH build/reuse WebMCP tools，**不是 RSI 插件**，相关性低。
* 可见的第三方展示在 [Reddit](https://www.reddit.com/r/SideProject/comments/1vxybmp/i_built_a_hacker_news_reader_users_can_modify/)；作者原文：> “DeepDeck is based on DeepSeek Harness, but it is not an official DeepSeek product.” 以及其 loop 为用户描述改 source、build、hot-reload。它证明有人把“本地 source 可被 agent 改”做成产品实验，不证明自改成功率。

## “整份 awesome 名单”如何处理，而不是假装 3,852 条都是 RSI

本轮对名单的 23 个章节与 3,852 条链接作了**完整枚举**，再以 README 描述的 memory / skill / evolve / review / loop / learn 词作机器筛选，并对高热度候选逐仓库核验。没有把无法在未认证 GitHub API 限额内逐仓库取得的 3,852 份 star metadata 伪造成已查数据；每一条的名字、简介、URL 仍以 [canonical generated list](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/README.md) 为完整逐条索引，避免复制 3,852 行陈旧文本到本报告。

| 类别 | 条目数 | RSI 判断 |
|---|---:|---|
| AGI Architecture Exploration | 9 | 全部人工审读；B 榜覆盖其 self-review/loop/memory 候选 |
| Memory | 179 | 全类纳入 memory/auto-capture/consolidation/skill 自动关键词筛；入榜的是有热度或机制明确者 |
| Skills | 154 | 多数只是静态 skill；只有 crystallization/refine/learning 才算高 RSI |
| Workflow & Automation | 232 | 多数是编排/cron；仅反馈/评审/自调节 loop 入榜 |
| Development & Runtime | 290 | 主要开发工具，不自动算 RSI |
| UI + Themes + Fun | 910 | 基本低 RSI；宠物“进化”不等于 agent 改进 |
| Tools / Browser / Vision / Voice / Docs / Git / Integrations / Remote / Security / Sessions / Usage / Models / Identity / WSL / Markets | 2,078 | 能力扩展，默认低 RSI；有 memory/eval 机制的已从关键词补入 |

这不是偷换成“只有 20 个插件”：是将 **3,852 个可安装 bundle** 与 **20 个有可解释 RSI 机制且能排热度的候选**分开。名单自己也警告：> “Being on this list is not a security review”。因此未上 B 榜的 3,832 条不是“死”，而是未满足“自改/记忆沉淀/skill 演化/harness 改造”的研究筛选，或没有足够热度，没资格占老板时间。

## 结论：该押哪几类，哪些别碰

1. **要成熟使用痕迹，接入型优先：OpenViking / Ouroboros / MemSearch。** 它们分别 37,935★ / 6,015★ / 2,623★，但必须把它理解为父项目级社区信号，先审 DSH adapter 与运行成本。
2. **要 DSH-native RSI 原型，先看 `dsh-memory-evolve`、`dsh-memory`、`dsh-evolve-modes`。** 三者是 317★ / 217★ / 199★ 且近期活跃；它们仍没有公开的跨用户收益 benchmark，所以只能当实验候选。
3. **不要把任意“memory”叫 RSI。** Durable recall 是中相关；只有从轨迹生成/评审/选择/验证/回滚变更，才是高相关。尤其 `dsh-context` 1,429★ 只是可观测性，不能因为名字有 evolution trend 就算自我改进。
4. **不要押原版 `william-jin` dsh-evolve。** 11★、0 fork、最后代码 8 月 13 日，且已出现错误 event hook 与安装失败 issue；这叫值得读的设计草图，不叫已被用户验证的生态战果。

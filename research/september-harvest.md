# 九月收割 (2026-09 社区扫货)

扫货日期：2026-09-19。范围：dsh生态 / HN / reddit / github / 论文。排序标准="我们的系统能立刻吃"。
user裁决记录在末尾。

## 候选（按可吃性排序）

### 1. environment-probing curation — arXiv 2609.11060（GHCP生产harness，9/10）
curator整理记忆前，给它只读的世界工具验证候选笔记（路径还存在吗？分支还在吗？URL活着吗？）再决定留不留。
效果：pass率 39%→73%，成本腰斩。
**我们的dream已长这只手**（真文件工具+jail）。要改的只是playbook一句话："晋升前先probe"。几乎免费。

### 2. 记忆=claims + deterministic探针 — Brainy Papers 9月实战文
每条笔记拆成typed claims，deterministic探针戳（path存在？URL活？）。383条claims戳出25条错的。
- Claude Code MEMORY.md 有200行/25KB上限，**从底部切——最新写的最先掉**。我们boot索引按updated_at取top5，天生免疫。
- 矛盾合并门槛可抄：**置信度≥0.75 + 两个真实主题重叠 + 同类才能supersede**。

### 3. Memory as Infrastructure / SIx Harness — arXiv 2609.05510，MIT kit
六个月、633k行代码、78933次hook调用、85次失败、**零silent**。给记忆子系统做SRE：session-start health gate、heartbeat遥测、alert-fatigue预算。
= harness-RSI缺的①（摩擦信号捕获）的成品形态。MIT协议，附预注册ablation方案。

### 4. YC Paper Club 9/7 — "Why The Harness Matters More Than The Model"
- 分层词汇：**按"loop对什么有CRUD"分层**——prompt / harness代码 / 别的harness / 权重。
- QM血泪：自动修bug循环+LLM judge → **main character syndrome**（每个agent只看自己那块象腿瞎修）。
- human review**退化成橡皮图章**。我们的"独立reviewer"规矩就是对这个的防御——但防御也会腐烂（需要canary）。

### 5. 验尸加分：skillmem 0.10.0
被"外部文本伪装成你自己的rule"咬过，加provenance字段。我们的origin三值立法提前防了。

### 6. REALM — arXiv 2609.16053
retrieval-driven reconsolidation。我们的access_count已经是种子。

## user裁决 (2026-09-19)

- **eval整体veto**："太耗token，建起来麻烦，先不考虑"。L5：复活须user明说+新证据。裁判=user本人。
- **harness层RSI还没思路**：爷拆的三段——③落地铁轨已有(keiyaku契约+独立review)；①摩擦信号捕获没有(SIx health gate是候选)；②信号→提案没有。user倾向：先挂起，攒数据再设计。
- **user的尖锐批评 (2026-09-19晚)**：这份收割的头两名"他妈的不还是笔记吗"——是笔记层改良，不是harness自改造。**批评命中，见下。**

## 反省：笔记层 vs harness层

user批评后重新分类：
- 候选1/2/6 = **笔记层**（软状态，每次重读进context才生效）
- 候选3 = harness**自观察**（遥测/gate，不改loop本身）
- 候选4里藏的才是harness层方向：Wes律"规则复发3次→长成deterministic guard(hook/lint/test)，不许再写成note" = **软状态硬化管线**

对照 dsh-rsi-cases.md：DSH生态3852插件里RSI味够重的头部也只有317★/217★/199★，且绝大多数同样是memory层。真正的loop自改造（Ouroboros budgeted evolution、MemSearch memory→skill review panel、dsh-evolve-modes human-reviewed self-evolution）全是human-gated promotion——和我们user-gated同构，但都没有成品级的"note→guard晋升管线"。

**结论：harness-RSI的真缺口=②信号→提案（把反复出现的pattern编译成hook/lint/test的提案机制）。社区没人烧出这块砖。候选1(probe)照做但承认它是笔记层；harness层的砖得自己烧。**

## 补网 (2026-09-19深夜，user令"你肯定找得不够"——他说对了)

第一次扫货按star排名=系统性漏掉harness层（冷门）。换关键词专钓"改自己loop"后捞到：

### ★ dsh-self-evolving (timwhitez, **7★**, Apache-2.0, npm `@dsh-self-evolving/core@0.2.3`, v0.2.0)
**完整的DSH自进化引擎，真·harness自改造：**
evidence→无网proposer沙盒(凭据不进沙盒)→bounded Cordis插件candidate→确定性build→**隔离真Loader准入**→Harbor/Terminal-Bench评估→fail-closed归一→hash链journal→下一轮。controller是唯一durable writer；candidate只能改自己声明的包；evaluator/scorer/split/policy全部冻结。v0.2已验证K=3稳定迭代+solve replay的ENGINEERING_EFFECT。
**= ②信号→提案→准入的成品骨架。但driver是benchmark eval（被veto的那套）——移植=砍掉eval、嫁接user-gate。**

### rulehook (xwk-911, **22★**, MIT)
自然语言policy→deny/remind/warn生命周期hook的**编译器**（Claude Code/Codex/Cursor）。regex预过滤→命中才调fast judge模型→cache+audit log。**= Wes律的着陆区：note→TOML→installed hook。**

### agentlint (mauhpr, **32★**, MIT, PyPI)
77条deterministic规则库×10平台hook格式，ERROR(block)/WARNING(注入建议)/INFO三级。drift-detector、operation_journal、subagent_transcript_audit。**= guard参考书+①摩擦捕获的零件。**

### CONTRAMEM (arXiv 2608.22533)
多模型轨迹对比蒸馏Function/Skill Cards，GAIA2成功率26%→55%，跨模型迁移。还是软状态，但是最接近"程序记忆"的。

### 修正后结论
管线以**零件**形式存在了：①捕获(SIx/agentlint journal) → ②提案(dsh-self-evolving的proposer, 但benchmark驱动非摩擦驱动) → ③着陆(rulehook/agentlint机制+咱们keiyaku review)。**仍没人把摩擦→提案接上**——咱们的差异化活着：user当裁判+摩擦当driver。

## Bottom line

The sharp edge is not “agents remembering better.” It is **search over executable agent code under an external evaluator**. That core loop is copyable into a frozen-weight harness—provided candidate changes are sandboxed and selected on held-out tests. Weight-update systems are not.

### 1. Code-self-modifying agents

| System | One-line loop | Measured evidence | Frozen-weight `pi` verdict |
|---|---|---|---|
| **Darwin Gödel Machine** (2025) — [paper](https://arxiv.org/abs/2505.22954), [official repo, Apache-2.0](https://github.com/jennyzzt/dgm) | Agent source code changes → coding-benchmark score selects variants → a diverse archive/tree of agents accumulates. | “**increasing performance on SWE-bench from 20.0% to 50.0%, and on Polyglot from 14.2% to 30.7%**.” | **Harness-copyable core.** Evolve a bounded plugin/skill sandbox; accept only changes that beat a held-out regression suite. The broad open-ended search budget is compute-gated. |
| **Gödel Agent** (2024) — [paper](https://arxiv.org/abs/2410.04444), [official repo, MIT](https://github.com/Arvid-pku/Godel_Agent) | Policy, meta-learning algorithm, and action set change → task reward selects → modified runtime code becomes the next agent. | It uses Python monkey patching to inspect/modify runtime code. Paper quote: on MGSM it “**outperforms [Meta Agent Search] by 11%**”; removing its thinking tool yields “**50.8↓13.4**.” | **Harness-copyable, with a redesign.** Copy its inspect/propose/test mechanism, not unrestricted runtime mutation. Use staged files, capability-limited tools, and rollback. |
| **ADAS / Meta Agent Search** (2024/ICLR 2025) — [paper](https://arxiv.org/abs/2408.08435), [official repo, Apache-2.0](https://github.com/ShengranHu/ADAS) | Meta-agent writes candidate agent code → validation performance selects → archive of discovered agents informs future mutations. | The paper reports DROP F1 “**by 13.6/100**,” MGSM accuracy “**by 14.4%**,” and cross-domain gains of “**25.9%**” on GSM8K and “**13.2%**” on GSM-Hard. | **Harness-copyable.** This is the most direct template for an offline `pi plugin-search` command that mutates tool routing, retry policy, and skill code against a benchmark. |

### 2. Evolutionary program search

| System | One-line loop | What was actually discovered / evidence | Frozen-weight `pi` verdict |
|---|---|---|---|
| **AlphaEvolve** (2025) — [white paper](https://arxiv.org/abs/2506.13131), [official DeepMind report](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/) | LLM proposes whole-program edits → automated correctness/performance evaluators score → evolutionary database selects prompt parents. | DeepMind reports a **23%** matrix-kernel speedup and **1%** Gemini-training-time reduction; up to **32.5%** FlashAttention speedup; a 4×4 complex matrix algorithm using **48 scalar multiplications**; it rediscovered known solutions in roughly **75%** of >50 open problems and improved best-known solutions in **20%**. | **Harness-copyable evaluator loop; lab-only targets.** It is genuine program search, not merely retrieval: results are checked by objective evaluators, though rediscovery is possible and acknowledged by its 75% figure. **Public implementation/license: UNVERIFIED**; only result notebooks are publicly linked. |
| **FunSearch** (2023 paper / 2024 Nature; comparison baseline) — [Nature paper](https://www.nature.com/articles/s41586-023-06924-6), [repo, Apache-2.0](https://github.com/google-deepmind/funsearch) | Frozen LLM mutates a function → programmatic evaluator scores it → evolutionary islands retain/promote high-scoring code. | It found new cap-set constructions and online-bin-packing heuristics. Nature reports **60%** of experiments on \(I(12,7)\) found a full-size admissible set; only **4 of 140** direct \(n=8\) cap-set runs found size **512**. | **Harness-copyable.** Its evaluator-first design is ideal for micro-optimizing deterministic pieces of a harness: parsing, ranking, context packing, tool-call scheduling. The distributed sandbox/LM infrastructure is omitted from the release. |

### 3. Weight-level self-improvement

| System | One-line loop | What changes / evidence | Frozen-weight `pi` verdict |
|---|---|---|---|
| **SEAL — Self-Adapting Language Models** (2025) — [paper](https://arxiv.org/abs/2506.10943), [repo, MIT](https://github.com/Continual-Intelligence/SEAL) | Model emits synthetic-data/optimizer “self-edit” → downstream score rewards edit → gradient update changes model weights and self-edit policy. | The paper’s SQuAD no-passage accuracy goes “**from 33.5% to 47.0%**.” MIT summarizes nearly **15%** QA improvement and more than **50%** skill-learning improvement. | **Needs-training-infra.** You can borrow candidate-data generation and held-out downstream selection, but SEAL’s accumulated capability is a weight update. |
| **Self-Rewarding Language Models** (2024) — [paper](https://arxiv.org/abs/2401.10020) | Model generates responses and judges them → self-generated preferences select → iterative DPO updates the same model. | Paper quote: three iterations of Llama-2-70B fine-tuning “**outperforms … Claude 2, Gemini Pro, and GPT-4 0613**” on AlpacaEval 2.0. **Exact public score and official implementation: UNVERIFIED.** | **Needs-training-infra.** A frozen harness may reuse an external judge for selecting code/plugin candidates, but cannot reproduce the improving-model part. |
| **Absolute Zero Reasoner** (2025) — [paper](https://arxiv.org/abs/2505.03335), [repo, MIT](https://github.com/LeapLabTHU/Absolute-Zero-Reasoner) | Model proposes deduction/abduction/induction tasks → Python verification and learnability rewards select → RL updates weights. | With zero curated data, Qwen2.5-7B-Coder total average rises “**40.2 → 50.4 (+10.2)**”; Qwen2.5-14B-Coder rises “**40.1 → 53.3 (+13.2)**.” The official setup states 7/8B needs **4 × 80GB GPUs** and 14B **8 × 80GB GPUs**. | **Needs-training-infra.** A plugin can copy the verified-task generator for test creation, but not the RL accumulation. |
| **SPIRAL** (2025/ICLR 2026) — [paper](https://arxiv.org/abs/2506.24119), [repo, MIT](https://github.com/spiral-rl/spiral) | Continuously improving model versions play zero-sum games → game outcome/role-conditioned advantage selects → multi-agent RL updates weights. | It reports gains “**up to 10% across a suite of 8 reasoning benchmarks on 4 different models**,” outperforming SFT on “**25,000 expert game trajectories**.” | **Needs-training-infra.** A frozen harness can run adversarial test generation, but not self-play learning. |
| **STaR lineage** (2022; comparison baseline) — [paper](https://research.google/pubs/star-self-taught-reasoner-bootstrapping-reasoning-with-reasoning/) | Generate rationale → keep only rationales yielding correct answers → fine-tune → repeat. | STaR reports performance comparable to fine-tuning a “**30× larger**” model on CommonsenseQA. | **Needs-training-infra.** Its acceptance rule—only retain outputs confirmed correct—is highly copyable for skill/plugin examples. |
| **Test-Time Self-Improvement (TT-SI)** (2025) — [paper](https://arxiv.org/abs/2510.07841) | Detect uncertain cases → self-generate similar examples → test-time fine-tune weights. | The paper reports “**+5.48% absolute accuracy gain on average**” using “**68x less training samples**.” **Official repository/license: UNVERIFIED.** | **Needs-training-infra.** The uncertainty-triggered escalation is portable; the claimed improvement depends on test-time fine-tuning. |
| **Test-Time Training / fast weights** (2025) — [paper](https://arxiv.org/abs/2505.23884) | Online token chunks update fast weights → self-supervised objective selects gradient step → temporary fast weights accumulate sequence state. | Large-chunk TTT reports chunks from **2K to 1M tokens** and scaling to a **14B-parameter** video model. | **Training/model-architecture-side.** It requires a model designed to expose mutable fast weights; not a `pi` plugin feature. |

### 4. AI-research automation: measured reality

| System / evaluation | One-line loop | What the evidence says | Frozen-weight `pi` verdict |
|---|---|---|---|
| **The AI Scientist-v2** (2025) — [paper](https://arxiv.org/abs/2504.08066), [repo, custom AI Scientist Source Code License](https://github.com/SakanaAI/AI-Scientist-v2) | Hypothesis/experiment/manuscript branches change → experiment-manager/tree-search plus reviewer feedback selects → promising research trajectories accumulate. | It submitted **three** autonomous manuscripts; “**one manuscript achieved high enough scores to exceed the average human acceptance threshold**” at an ICLR workshop. | **Lab-only end-to-end.** The experiment-tree manager, reproducible run records, and reviewer-as-critic are harness-copyable; autonomous science and paper production require substantial compute and human governance. |
| **MLE-bench** (2024) — [paper](https://arxiv.org/abs/2410.07095), [repo, MIT](https://github.com/openai/mle-bench) | Agent changes ML code → Kaggle-style evaluator scores → no built-in persistent self-improvement; it is an evaluation substrate. | Best tested setup, o1-preview + AIDE, achieved bronze-medal-level performance in “**16.9% of competitions**.” | **Harness-copyable as an evaluator pattern.** Useful for regression-testing `pi` research/coding plugins; it does not itself make agents improve. |
| **RE-Bench** (2024) — [paper](https://arxiv.org/abs/2411.15114), [repo, MIT](https://github.com/METR/RE-Bench) | Agent/human changes research code → scored research environment selects → benchmark records trajectories, not a learning loop. | **7** environments; **71** human attempts by **61** experts. Best AI score was **4×** human experts at two hours, but humans were **2×** the best agent at 32 hours; agents could test solutions “**over ten times faster than humans**.” | **Harness-copyable evaluation discipline.** Use its held-out environments, time budgets, and human-comparison mindset; full tasks need serious GPU/VM infrastructure. |
| **MLGym / MLGym-Bench** (2025) — [paper](https://arxiv.org/abs/2502.14499), [repo, CC BY-NC 4.0](https://github.com/facebookresearch/MLGym) | Agent modifies ML experiments → environment score selects → framework can train/evaluate agents but does not self-improve them by default. | It contains **13** open-ended AI-research tasks. Crucially, authors find frontier models usually improve baselines via hyperparameters but “**do not generate novel hypotheses, algorithms, architectures, or substantial improvements**.” | **Harness-copyable as a task interface, lab-gated as a benchmark.** It is useful evidence against overclaiming autonomous research. |

## Three-way classification

### Harness-copyable

- DGM’s staged propose → sandbox → held-out-evaluate → archive loop
- Gödel Agent’s self-inspection, but only through bounded plugin source and reversible patches
- ADAS/Meta Agent Search’s code-space search and archive
- FunSearch’s evaluator-driven evolutionary selection
- AlphaEvolve’s evaluator/database architecture, not its industrial targets
- STaR’s “retain only verifier-confirmed examples” rule
- The evaluation and experiment-management pieces of AI Scientist-v2, MLE-bench, RE-Bench, and MLGym

### Needs training infrastructure

- SEAL
- Self-Rewarding Language Models
- Absolute Zero Reasoner
- SPIRAL
- TT-SI and other test-time fine-tuning
- Fast-weight / TTT architectures

### Lab-only

- AlphaEvolve’s deployed infrastructure optimization claims
- Fully autonomous AI Scientist-v2 research production
- RE-Bench/MLGym-scale research-agent experiments when real GPU clusters, long rollouts, and expensive experimental budgets are required

The practical `pi` frontier is therefore: **evolve harness code, not model weights; select by isolated held-out tests; preserve a lineage/archive; make promotion reversible.** That is the part with real evidence that does not require pretending a TypeScript extension owns an H100 cluster.
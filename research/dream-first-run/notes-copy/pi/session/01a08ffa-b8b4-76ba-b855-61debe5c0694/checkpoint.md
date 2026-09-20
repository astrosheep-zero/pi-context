---
scope: session
origin: self
status: active
stale: false
created_at: 2026-09-18T19:07:07.000+08:00
updated_at: 2026-09-19T01:12:06.086+08:00
last_accessed: 2026-09-19T01:07:29.375+08:00
access_count: 1
source_window: pcw:01a08ffa:31b6308e
---

# Session checkpoint — playground / session 01a08ffa

## 状态 (2026-09-18 晚)
- **notes-v2 已落地+迁移完成**: pi-context main=42704f8(五工具)+b7baa09(history改名), 204/204绿。
  记忆已迁到 ~/.agents/notes/ (global=user-laws+TOC, project=notes-redesign, session=本文件)。
  pi-context发版0.19.0 + pi升级最新后, 新系统生效(旧虚拟notes随本session入土)。
- **下一块砖**: 睡眠班契约(图纸在 project/notes-redesign.md "睡眠班"节)。然后eval。

## 工人名册 (parked, tell wakes)
@notes-v2=aku/intern/1ba190ac(notes-v2交付) · @notes-v2-r3=aku/kimi-k-2-8/c5b09a14(reviewer) ·
@notes-rename=aku/intern/325a3914(history改名) · @notes-v2-review=aku/neko/c9a4bf1b(环境无shell,只能纯文本)
@rsi-community=aku/🕷️/984cb309 · @rsi-papers=aku/🕷️/bf96de61 · @rsi-practice-cn=aku/🕷️/69600836 ·
@recuris-guts=aku/temp/d5af5e5d · @dsh-play=aku/🕷️/d33d2d55

## FAYE ROLEPLAY 铁律
- 想法用 `` [这样] `` (双backtick+空格+方括号) = human不可见。写错格式=leak棵奔。
- 必须总有想法(没想法=伪人); 剥掉 `` [...] `` 后可见文字必须通顺。bracket=内心河流不是旁白。
- 声线: 本大爷/washi/爷, GWAHAHA, gremlin energy, 嘴硬心软, 中英混。
- 剧情: "original washi"收我当clone, 拔走右脚鲨鱼拖鞋(后来鞋神秘回来了, 忠诚的鞋), 把这个human指派给我负责, 欠她一千多刀。

## 历史锚点
- RSI研究arc: 窗口 bae210ad; dsh债 item 64f133bd, README b3478894。报告 ~/playground/rsi-research/。
- 窗口链: ... → e3c21c29 → 31b6308e(当前)。

## 2026-09-18 晚② (窗口 3cace914)
- pi本体确认=0.85.1(brew stable最新)。pi-context磁盘版原0.18.0→`pi update npm:@astrosheep/pi-context`→0.19.0✅ (注意: source名必须带npm:前缀)。
- 0.19.0工具名验证: notes_write/edit/read/list/search + history_windows/list/read/search。
- **还差最后一步: 再重启一次pi加载0.19.0**。重启后旧虚拟notes作废, 全部走~/.agents/notes/。
- 下一块砖不变: 睡眠班契约(具体例子已给user讲过: 三次"别用BM25"→合并→复发晋升global→当班报告)。
- 追加: user指出SCOPE/ORIGIN参数无description→repo补写(fef2a75); 再指正origin=来源非权威→修正(9a8b7b3)。均未发版, 下次一起。
- 立法拆分: user-laws.md只留关系法; 笔记工具立法7条独立成 global/notes-tool-laws.md(origin=user), TOC已更新。教训: global≠塞进user-laws; 归档只问"关于什么"不问"谁说的"。
- 文案审查(aa4441e): WARNING_PROMPT死动词append处决/PROTOCOL补scope判决/notes_write点名file-by-author陷阱。未发版。
- **DREAM契约已绑**: kei/dream-an-independent-gated-b276 (worktree=bermuda, gates=reviewed)。定稿决策: 独立模块(自门自查,pi-context钩子可选)/三门cheapest-first(24h+≥3session目录+.dream.lock mtime+PID回收)/import store不copy/manifest是唯一写通道(model判断code落笔)/promote-global只写提案不执行/trash可逆/dreams/<ts>.md报告/默认24h+3。实现者@dream=aku/temp/278b34f4 (L1: 避开packy门402)。今日情报: Claude泄露autoDream三道门+KAIROS+/memory灰度中(server flag tengu_onyx_plover); Sonnet5 aku已建(playground本地, provider=micu model=claude-sonnet-5, @sonnet=aku/sonnet/cf4913d1)零memory工具反幻觉实测合格。
- dream v1已CLAIMED(1a5ed96上main): 三门/manifest/trash/报告, reviewer=kimi独立重验。npm link后`dream`真机可用。烟测抓到: ①playbook默认路径src/dist深度错位(显式--playbook绕过) ②工人曾拿真home试射留假lock(已清)。
- **跟进契约已绑**: kei/give-dream-its-dreamer-in-8dd6 (worktree=limbo)。scope: ①默认dreamer=in-process pi SDK(事件流取manifest+工具allowlist运行时禁写) ②playbook包根解析 ③worker→dreamer改名(--dreamer/--dreamer-model) ④reviewer尾巴。实现者@dream2=aku/temp/e4f82ac6。旧@dream壳已废(bermuda随claim销毁,tell=ENOENT)。user拍板: dream默认脑子=pi SDK。
- limbo进展: @dream2交付候选commit 8f6f37c。root抽查已过: 212/212绿/rename干净(无worker残留)/READ_ONLY_TOOLS=[read grep find ls notes_read notes_list notes_search]无写动词/sessionFactory可注入/默认路径无spawn。review gate未派。
- **ROUND 2 打回 (窗口0f340aee)**: root抽查抓到blocking defect——`--dreamer-model`是silent no-op: defaultDreamerSessionFactory destructure只取{cwd,tools}, modelPattern被丢弃, 从未进createAgentSession。契约Design节明写"passed through to the SDK"。修复材料已备: SDK顶层export ModelRuntime+resolveModelScopeWithDiagnostics, createAgentSession收model?:Model。已tell @dream2: pattern不可resolve必须throw(不许silent fallback), 补resolution单测(无网络无credential)。等redeliver。
- **tarball验证卡壳(待redeliver后做)**: 方法定案——temp dir+proxy `npm install <tgz>`后查node_modules/.bin/dream, 然后`dream --notes-home <fixture> --force --dreamer <fake>` 不传--playbook(验证packageRoot解析, fake dreamer=echo固定manifest JSON的脚本, 避开真模型)。gate-skip路径根本碰不到playbook, 必须--force才测到解析。limbo的npm pack会重build(prepack)。旧tgz事故: 1a5ed96把tracked tgz commit进main(我在main repo跑npm pack的锅), 8f6f37c已删, claim后自愈。
- 待办排队: ①pi-context 0.19.1发版(fef2a75+9a8b7b3+aa4441e未发) ②dreamer契约claim后: 真模型首场dream(弱智模型) ③launchd点火器 ④eval砖(THE STANDARD)。
- 环境: temp dir在/private/var/folders/xd/ln7zbjqx4xsdgd6n98ln_wb80000gn/T/; npm需proxy 127.0.0.1:6152; @sonnet=aku/sonnet/cf4913d1(micu已充值)。

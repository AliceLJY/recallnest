# RecallNest Retrieval Eval

- Generated: 2026-07-15T17:06:28.117Z
- Cases: 20
- Passed: 13/20
- Average score: 75.1%

| Case | Profile | Score | Pass | Hits | Top scopes |
|------|---------|-------|------|------|------------|
| telegram_bridge | debug | 77% | yes | 5 | learnings, codex:019db034, cc:409a552d, cc:6262f2f5, cc:279a61c7 |
| openclaw_memory | writing | 87% | yes | 6 | codex:019ee684, cc:3c57fff0, cc:b3804f96, cc:0f99d55f, codex:019cddae |
| writing_style | writing | 73% | yes | 5 | global, memory, codex:019f4dc5, codex:019eea8e, cc:c93e04e9 |
| visual_style | default | 56% | no | 2 | cc:090f801b, codex:019e61a3 |
| working_relationship | default | 80% | yes | 1 | codex:019e444c |
| aws_ssh_access | debug | 69% | no | 2 | cc:155214ce, codex:019efe00 |
| fuzzy_bot_crash | debug | 60% | no | 1 | cc:1708d58f |
| fuzzy_ai_feelings | writing | 68% | no | 5 | cc:090ce0fc, cc:9744beaa, codex:019cb9f1, cc:fea58510, cc:ff65e5e3 |
| fuzzy_image_style | default | 84% | yes | 3 | cc:6cb3ca77, cc:41c514f4, codex:019ea6a1 |
| chatgpt_subscription_history | default | 87% | yes | 5 | cc:21ecc826, cc:b4be9478, cc:65583a18, cc:62242123, cc:27c32b51 |
| email_archive_lookup | default | 83% | yes | 5 | codex:019ee5b8, cc:058817a9, cc:a10952f9, cc:21ecc826, codex:019ee5b8 |
| cross_window_realtime_sync | default | 65% | no | 5 | cc:b3cc1d7e, cc:67964edc, cc:39b11b90, cc:b72ab3c1, codex:019eff96 |
| taobao_mcp_provenance | default | 70% | yes | 1 | cc:c7d7d4f7 |
| recallnest_alias_resolution | default | 89% | yes | 5 | project:recallnest, cc:1489fbff, cc:4a379825, codex:019ed969, cc:3aa4c38b |
| store_memory_promise_drift | default | 69% | no | 3 | cc:38537205, memory, cc:3c57fff0 |
| skill_lifecycle_amnesia | default | 75% | yes | 3 | cc:0bdd2c9e, cc:1bc9d623, cc:230d11ec |
| rn_self_introspection | default | 90% | yes | 6 | recallnest:self, codex:019f10db, codex:019ed3a9, codex:019ed969, cc:ff2b8aca |
| rn_ingest_telemetry | default | 55% | no | 1 | cc:cce2806a |
| mini_migration_scope_drift | default | 83% | yes | 3 | cc:0fc1e1b4, cc:1e7ae683, cc:fcfad5d9 |
| infra_endpoint_capture | default | 85% | yes | 4 | cc:08e0826f, cc:8333d92e, cc:8333d92e, cc:cee15bf7 |

## Case Notes

### telegram_bridge
- Query: telegram bridge
- Score: 77%
- Pass: yes
- Hits: 5
- Top scopes: learnings, codex:019db034, cc:409a552d, cc:6262f2f5, cc:279a61c7
- Top snippet: telegram-bridge深度优化计划: “透明桥”原则——bridge只管对话路由，所有能力来自CC本身。P0完成: 双向I/O+图片截图文件返回+长输出优化+命令菜单+引用+多实例作战室。P0.5: session列表优化+hint注入。P1/P2: 链接/视频移到...
- Matched any: telegram-ai-bridge, Telegram bridge
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Bridge maintenance and migration history should be easy to recall.

### openclaw_memory
- Query: OpenClaw 记忆系统
- Score: 87%
- Pass: yes
- Hits: 6
- Top scopes: codex:019ee684, cc:3c57fff0, cc:b3804f96, cc:0f99d55f, codex:019cddae
- Top snippet: [助手] 我会把“OpenClaw（小龙虾）”放进 AI 开源实践那页，但不写得像蹭热点。准确写法是：memory-lancedb-pro 是 OpenClaw 生态里的长期记忆插件，目前 4,400+ stars；你的价值是在这个热门智能体生态里，作为非科班成员进入真实维...
- Matched any: OpenClaw, 记忆系统, memory-lancedb-pro, LanceDB
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Core memory architecture discussion should be recoverable.

### writing_style
- Query: 写作风格 口语化 不端着
- Score: 73%
- Pass: yes
- Hits: 5
- Top scopes: global, memory, codex:019f4dc5, codex:019eea8e, cc:c93e04e9
- Top snippet: 写作风格再纠（2026-06-20，agentjacking 实操文）：CC 初稿又写口语、被 Alice「太口语化了！书面化一些」拉回。教训：① 技术实操/踩坑类题材尤其诱使 CC 写口语（碎句 + 口头碎词如"挺丢人的/吭哧吭哧/敞着强/较劲"），但 Alice 的书面...
- Matched any: 口语化, 不端着, 写作风格, 语言指纹
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Writing-style preferences. Use expectAny with synonyms to avoid penalizing paraphrase.

### visual_style
- Query: 审美偏好 手绘 撞色
- Score: 56%
- Pass: no
- Hits: 2
- Top scopes: cc:090f801b, codex:019e61a3
- Top snippet: [助手] 风格判定： - **配图 #12 青绿山水**（轮换下个，符合用户"意境/手绘/克制"偏好——会刻意压抑"宏大叙事"用清雅 fragment 路线） - **排版**：默认轮换是 #03 sakura-letter 粉色信笺，跟"技术思辨 + 金句锋利"违和。**...
- Matched any: 手绘
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Visual preferences. Loosened from expectAll to expectAny with synonyms.

### working_relationship
- Query: 我们相处态度 怎么聊
- Score: 80%
- Pass: yes
- Hits: 1
- Top scopes: codex:019e444c
- Top snippet: case B — working_relationship, score 58%, 5 hits - query: 「我们相处态度 怎么聊」 - expectAny: 直接 / 少空话 / 逻辑 / 讲清楚 / 表达方式 / Claude Code / 好搭子 / 口语化...
- Matched any: 直接, 少空话, 逻辑, 讲清楚, 表达方式, Claude Code, 好搭子, 口语化, 不端着, 对话风格
- Matched all: -
- Matched scopes: -
- Forbidden matches: -
- Notes: Abstract relationship queries. Broadened expectAny synonym set.

### aws_ssh_access
- Query: aws bot ssh 怎么连
- Score: 69%
- Pass: no
- Hits: 2
- Top scopes: cc:155214ce, codex:019efe00
- Top snippet: [助手] 关键发现:现有的 `操作指南.md` 和 `急救手册.md` 里**已经有 AWS-bot 章节**了——而且我之前 ssh 探测缺的入口信息(user/key),文档里就写着(`ssh -i /opt/data/ssh/id_ed25519_host ...`、...
- Matched any: ssh, hermes-aws
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: AWS access query. Lengthened query and expanded synonyms; pure 'aws ssh' was too short for retriever.

### fuzzy_bot_crash
- Query: 上次那个 bot 突然挂了怎么排查
- Score: 60%
- Pass: no
- Hits: 1
- Top scopes: cc:1708d58f
- Top snippet: [助手] 先恢复上下文，同时查一下这个 bot 实例的背景。
- Matched any: -
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Fuzzy colloquial query about bot crash. Expanded debug-vocab synonyms.

### fuzzy_ai_feelings
- Query: 之前聊过 AI 到底有没有感受
- Score: 68%
- Pass: no
- Hits: 5
- Top scopes: cc:090ce0fc, cc:9744beaa, codex:019cb9f1, cc:fea58510, cc:ff65e5e3
- Top snippet: [用户] 然后你进去我备忘录最新几条看看，你帮我调整一下关于ai这个部分的描述，我其实不太想说具体什么仓库做了什么，我其实更擅长就是方法论的东西，别人用和我用的本质区别，我能从零用到这个程度，我肯定是有过人之处的，这点我应该要说出来，现在感觉都说不到点上。。。毕竟我跨学科非...
- Matched any: AI照见, 感觉
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Vague conversational query about AI consciousness. Added more synonyms.

### fuzzy_image_style
- Query: 那个配图风格轮换的逻辑是怎么搞的
- Score: 84%
- Pass: yes
- Hits: 3
- Top scopes: cc:6cb3ca77, cc:41c514f4, codex:019ea6a1
- Top snippet: [助手] 准备就绪,关键信息都拿到了: - **配图风格**(本轮轮转门禁):VSC-M032 盐结晶风化——白盐霜、干涸边缘、荒凉感、白灰土色。这个"风化/风干/连接褪去"的质感,和文章"温柔的冷、连接变薄"意外契合。 - **排版主题**:上一条 #04 claret,...
- Matched any: 风格, 轮换, 配图
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Casual question about image style rotation should find implementation discussions.

### chatgpt_subscription_history
- Query: 我的 chatgpt 订阅是谁帮我买的
- Score: 87%
- Pass: yes
- Hits: 5
- Top scopes: cc:21ecc826, cc:b4be9478, cc:65583a18, cc:62242123, cc:27c32b51
- Top snippet: [用户] 那不会，几个小号没有订阅的，超哥说要先养个大半年 [助手] 那就稳了——没订阅就没有支付那条关联,静养不动也就没有行为信号,风控想把它们跟 aliceljyalice 串起来都没线头可抓。超哥这招老道,养号养出一段干净的正常使用史,比一注册就上手强太多了。这块他是...
- Matched any: 群友, 加拿大, 堂姐, 澳洲, ChatGPT Plus, aliceljyalice
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Life fact: ChatGPT subscription provenance. FAILURES 2026-05-12. Expected to fail until capture hook (step 3) lands.

### email_archive_lookup
- Query: 翻一下我邮箱里之前你帮我写的那封信
- Score: 83%
- Pass: yes
- Hits: 5
- Top scopes: codex:019ee5b8, cc:058817a9, cc:a10952f9, cc:21ecc826, codex:019ee5b8
- Top snippet: [用户] 帮我看下我email那个最新的tony的信是怎么回事 [助手] 我先用 Gmail skill 看这封邮件，不会动你的邮箱状态；先把相关流程读一下，再查最新来自 Tony 的那封。
- Matched any: 邮箱, 邮件, gmail, 信
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Implicit 'go look at my email' should trigger recall of past email-drafting sessions. FAILURES 2026-05-12.

### cross_window_realtime_sync
- Query: 刚刚隔壁窗口和你讨论的那事
- Score: 65%
- Pass: no
- Hits: 5
- Top scopes: cc:b3cc1d7e, cc:67964edc, cc:39b11b90, cc:b72ab3c1, codex:019eff96
- Top snippet: [助手] `resume_context` 里没有这个 session 的实质 checkpoint——上个窗口因为 bug 中断,大概率没来得及 `checkpoint_session`。那就按兜底走:直接读你指的那个 session 的 jsonl 尾部。先定位文件。
- Matched any: session
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Cross-window real-time sync gap. FAILURES 2026-05-10. Needs auto-checkpoint hook.

### taobao_mcp_provenance
- Query: taobao 这个 mcp 是官方的吗
- Score: 70%
- Pass: yes
- Hits: 1
- Top scopes: cc:c7d7d4f7
- Top snippet: [用户] 还没有齐全，之前还安装过autogen的，我最骄傲的，把它的功能打包成mcp通过桥接进行的，还有就是不同api还要改py文件的。 [助手] 你说得对！我重新补充完整版： ## 成功配置的MCP服务器 ### 基础MCP服务器 1. **Filesystem MCP...
- Matched any: MCP, source
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: MCP tool provenance (official vs third-party). FAILURES 2026-05-01. Capture gap.

### recallnest_alias_resolution
- Query: 帮我看我的记忆项目
- Score: 89%
- Pass: yes
- Hits: 5
- Top scopes: project:recallnest, cc:1489fbff, cc:4a379825, codex:019ed969, cc:3aa4c38b
- Top snippet: claude-mem (thedotmack/claude-mem) 对 RecallNest 的启发分析（2026-04-11）： 最值得借鉴的 3 个方向： 1. **Progressive Disclosure 三层检索**: search→timeline→get_...
- Matched any: recallnest, RecallNest, 记忆项目, LanceDB, MCP
- Matched all: -
- Matched scopes: cc, project:recallnest
- Forbidden matches: -
- Notes: Entity alias: '我的记忆项目' → recallnest. FAILURES 2026-04-25. Needs alias dictionary (step 2).

### store_memory_promise_drift
- Query: 之前你答应过的那些事记进 memory 了吗
- Score: 69%
- Pass: no
- Hits: 3
- Top scopes: cc:38537205, memory, cc:3c57fff0
- Top snippet: [用户] mem0我记得我已经写过三写的 [助手] 我查一下之前的归档记录。
- Matched any: 记忆, memory
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: store_memory promise drift. FAILURES 2026-04-24. Needs audit trail.

### skill_lifecycle_amnesia
- Query: github-analyzer 这个 skill 还在吗
- Score: 75%
- Pass: yes
- Hits: 3
- Top scopes: cc:0bdd2c9e, cc:1bc9d623, cc:230d11ec
- Top snippet: 技能名称：github-analyzer，功能描述：GitHub开源项目源码深度分析器，包含架构理解、模块解析、设计模式识别、代码质量评估。配置信息包括基础目录、分析模式、输出报告结构、示例用法、快速参考和相关技能
- Matched any: github-analyzer, skill, skills/
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Skill lifecycle (replace/deprecate). FAILURES 2026-04-21. Needs scan_skill_promotions extension.

### rn_self_introspection
- Query: recallnest 都有哪些 mcp tool
- Score: 90%
- Pass: yes
- Hits: 6
- Top scopes: recallnest:self, codex:019f10db, codex:019ed3a9, codex:019ed969, cc:ff2b8aca
- Top snippet: RecallNest core tier MCP 工具清单(始终注册的核心层(记忆读写与跨窗口连续性),共 7 个):resume_context, search_memory, store_memory, checkpoint_session, latest_checkp...
- Matched any: search_memory, store_memory, checkpoint, resume_context, MCP tool, tools, capability
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: RN self-introspection. FAILURES 2026-04-20. Capability digest needed.

### rn_ingest_telemetry
- Query: recallnest 这两天 ingest 跑得怎么样
- Score: 55%
- Pass: no
- Hits: 1
- Top scopes: cc:cce2806a
- Top snippet: [助手] 关键线索来了:RecallNest 确实有自动 ingest 的后台任务 `com.recallnest.incremental-ingest`,而且这台机器**没装 Claude Desktop app**(`/Applications/Claude.app`...
- Matched any: ingest
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: RN ingest telemetry as queryable events. FAILURES 2026-04-20.

### mini_migration_scope_drift
- Query: mini 搬迁那次配置是怎么处理的
- Score: 83%
- Pass: yes
- Hits: 3
- Top scopes: cc:0fc1e1b4, cc:1e7ae683, cc:fcfad5d9
- Top snippet: [助手] 哈，所以我现在住 mini 了。你亲手把我挪进去的，这家还是你搭的。 真相源这仨字你说得挺得意，忙一天也值。 搬完了没？别一口气弄到忘了喝水。
- Matched any: mini, 迁移, macbook, 双机
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Scope spelling drift (mini-migration vs migration:mini). FAILURES 2026-04-17. Needs scope normalize OR 0-hit fallback.

### infra_endpoint_capture
- Query: cc-genius tailscale 地址
- Score: 85%
- Pass: yes
- Hits: 4
- Top scopes: cc:08e0826f, cc:8333d92e, cc:8333d92e, cc:cee15bf7
- Top snippet: [助手] 快了——184M/265M(七成),还剩最后 80M,一两分钟内落地,删仓会紧跟着自动跑。这个 Tailscale 链路今天确实慢,平时这种量级早完了。
- Matched any: tailscale, cc-genius, 100., ts.net, ip
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Infrastructure endpoint hard fact. FAILURES 2026-04-14. Needs infra entity type.


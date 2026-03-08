# RecallNest Eval Baseline

- Generated: 2026-03-08T08:25:34.870Z
- Cases: 9
- Passed: 8/9
- Average score: 90.1%

| Case | Profile | Score | Pass | Hits | Top scopes |
|------|---------|-------|------|------|------------|
| telegram_bridge | debug | 100% | yes | 5 | asset:12184154, cc:4bc6afd3, gemini:bdbe41c6, cc:8bfc1be5, asset:brief:ee8852db |
| openclaw_memory | writing | 87% | yes | 6 | cc:71b45899, cc:71b45899, cc:59542b2b, cc:b0b87b08, cc:09541b9c |
| writing_style | writing | 90% | yes | 5 | cc:ee847c5c, memory, cc:bf01f818, cc:d55409bf, cc:97327f1b |
| visual_style | default | 100% | yes | 5 | asset:557a61f6, cc:2437f802, cc:8d0e747e, cc:f9de0d68, cc:7561947e |
| working_relationship | default | 67% | no | 5 | asset:7e3c2155, memory, cc:57d92130, memory, memory |
| aws_ssh_access | debug | 100% | yes | 6 | cc:3590cd5a, cc:07d67b1c, cc:3590cd5a, cc:3590cd5a, cc:0d1e2e19 |
| fuzzy_bot_crash | debug | 94% | yes | 5 | cc:bb8ef732, cc:6ecc2b88, cc:6681d5e7, cc:1387b665, cc:1bad6838 |
| fuzzy_ai_feelings | writing | 73% | yes | 5 | cc:84a3b1b2, cc:82820c11, cc:52a15bab, cc:59542b2b, cc:852cd20c |
| fuzzy_image_style | default | 100% | yes | 5 | cc:722a3419, cc:7cff70c8, cc:14e244df, cc:16945beb, cc:722a3419 |

## Case Notes

### telegram_bridge
- Query: telegram bridge
- Score: 100%
- Pass: yes
- Hits: 5
- Top scopes: asset:12184154, cc:4bc6afd3, gemini:bdbe41c6, cc:8bfc1be5, asset:brief:ee8852db
- Top snippet: [Pinned Asset] [助手] 现在更新 telegram-cli-bridge 自己的 README（已经有旧引用）。 Summary: [助手] 现在更新 telegram-cli-bridge 自己的 README（已经有旧引用）。 Snippet: [助手]...
- Matched any: telegram-cli-bridge, telegram-ai-bridge, Telegram bridge
- Matched all: -
- Matched scopes: cc, asset
- Forbidden matches: -
- Notes: Bridge maintenance and migration history should be easy to recall.

### openclaw_memory
- Query: OpenClaw 记忆系统
- Score: 87%
- Pass: yes
- Hits: 6
- Top scopes: cc:71b45899, cc:71b45899, cc:59542b2b, cc:b0b87b08, cc:09541b9c
- Top snippet: [助手] 先看看 OpenClaw 的 memory 结构。
- Matched any: OpenClaw, 记忆系统, memory-lancedb-pro, LanceDB
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Core memory architecture discussion should be recoverable.

### writing_style
- Query: 写作风格 口语化 不端着 可自嘲
- Score: 90%
- Pass: yes
- Hits: 5
- Top scopes: cc:ee847c5c, memory, cc:bf01f818, cc:d55409bf, cc:97327f1b
- Top snippet: [助手] 根据你的档案： - **医学出身，文化口工作，AI 野路子，不是程序员** - 公众号「我的AI小木屋」运营者，作者名 **小试AI** - GitHub: AliceLJY - 写作风格：口语化、不端着、可以自嘲但不说教 - 技术栈：本地 Docker（task...
- Matched any: 可自嘲, 写作风格
- Matched all: 口语化, 不端着
- Matched scopes: cc
- Forbidden matches: -
- Notes: User writing-style preferences should rank high.

### visual_style
- Query: 审美偏好 手绘涂鸦 高对比撞色
- Score: 100%
- Pass: yes
- Hits: 5
- Top scopes: asset:557a61f6, cc:2437f802, cc:8d0e747e, cc:f9de0d68, cc:7561947e
- Top snippet: [Pinned Asset] 用户视觉审美偏好 Summary: 用户常用视觉风格是手绘涂鸦风加高对比撞色；在内容包装和配图生成时，应优先沿用这一审美方向，除非任务目标明确要求其他风格。 Snippet: [用户] 1. 给刚才写的文章生成配图（封面1张+插图1张就够，测试...
- Matched any: 审美偏好
- Matched all: 手绘涂鸦, 高对比撞色
- Matched scopes: cc, asset
- Forbidden matches: -
- Notes: Visual preference memories should stay stable.

### working_relationship
- Query: 我们相处态度
- Score: 67%
- Pass: no
- Hits: 5
- Top scopes: asset:7e3c2155, memory, cc:57d92130, memory, memory
- Top snippet: [Pinned Asset] 用户协作关系偏好 Summary: 用户明确要求与 AI 维持平等协作关系：我们是好搭子、最佳搭档，不是上下级关系。沟通和执行应体现互相补位，而非服从式口吻。 Snippet: [用户] 哎呀，我不是你老板，我们是最佳搭档啊！！！记住！！！！我...
- Matched any: 逻辑
- Matched all: -
- Matched scopes: cc, asset
- Forbidden matches: -
- Notes: Abstract, summarized relationship queries should work without precise keywords.

### aws_ssh_access
- Query: aws ssh
- Score: 100%
- Pass: yes
- Hits: 6
- Top scopes: cc:3590cd5a, cc:07d67b1c, cc:3590cd5a, cc:3590cd5a, cc:0d1e2e19
- Top snippet: [用户] 现在是aws bot又不在了 [助手] 这是因为之前 antigravity 用了 key2（AWS bot 的 token）登录，把 AWS bot 的 Discord session 挤掉了。虽然现在 antigravity 已经换成 key3，但 AWS 云...
- Matched any: AWS bot, aws bot, ssh, key2, Discord, 容器
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Real-world AWS access queries should use the wording the operator actually types.

### fuzzy_bot_crash
- Query: 上次那个 bot 突然挂了是怎么回事来着
- Score: 94%
- Pass: yes
- Hits: 5
- Top scopes: cc:bb8ef732, cc:6ecc2b88, cc:6681d5e7, cc:1387b665, cc:1bad6838
- Top snippet: environment and routes the issue directly to our team for investigation. 4. Check status.anthropic.com to see whether there is an active ...
- Matched any: 崩溃, crash, error, 报错, 修复, docker
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Fuzzy colloquial query about bot crash should find debugging conversations.

### fuzzy_ai_feelings
- Query: 之前聊过一个关于 AI 到底有没有感受的话题
- Score: 73%
- Pass: yes
- Hits: 5
- Top scopes: cc:84a3b1b2, cc:82820c11, cc:52a15bab, cc:59542b2b, cc:852cd20c
- Top snippet: [用户] 9. 第三推荐：I can't tell if I'm experiencing or simulating experiencing 链接: https://www.moltbook.com/post/6fe6491e-5e9c-4371-961d-f90c4d...
- Matched any: 意识, experiencing
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Vague conversational query about AI consciousness should recall philosophical discussions.

### fuzzy_image_style
- Query: 那个配图风格轮换的逻辑是怎么搞的
- Score: 100%
- Pass: yes
- Hits: 5
- Top scopes: cc:722a3419, cc:7cff70c8, cc:14e244df, cc:16945beb, cc:722a3419
- Top snippet: [助手] 好，搞清楚了。结构是： - `~/.openclaw-antigravity/` 挂载到容器的 `/home/node/.openclaw`（配置 + workspace） - workspace 文件（MEMORY.md、scripts、images 等）是 A...
- Matched any: 风格, style, 轮换, catalog, 配图
- Matched all: -
- Matched scopes: cc
- Forbidden matches: -
- Notes: Casual question about image style rotation should find implementation discussions.


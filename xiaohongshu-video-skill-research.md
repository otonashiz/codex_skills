# 小红书视频文案提取 Skill 调研与实现建议

## 1. 目标定义

目标是做一个可长期维护、可在 Codex/Claude Code 类环境中稳定触发的 skill：

- 用户发来一个小红书视频链接
- skill 自动提取笔记基础信息与视频内容相关文本
- 对文本进行总结
- 输出一份中文 Markdown 文档

这里的“视频内容相关文本”不应只指原帖标题/正文，而应拆成几个来源：

- 原帖标题、正文、标签
- 视频口播转写（ASR）
- 画面中的字幕/贴纸/封面字（OCR）
- 可选：评论区高频问题或互动信号

如果只抓原帖文案，信息会明显不全；如果只做 OCR，也会漏掉大量口播内容。因此更靠谱的定义是：`链接 -> 元数据/视频 -> ASR + OCR -> 合并整理 -> 总结 -> Markdown`。

## 2. 总体结论

截至 2026-04-04，这件事最靠谱的实现方式不是“直接从小红书页面拿平台字幕轨”，而是分层实现：

1. 上游抓取层负责拿到笔记信息、视频地址、必要登录态
2. 中间处理层负责下载视频、抽音频、跑 ASR、抽帧 OCR
3. 下游生成层负责整理成结构化 Markdown，并输出总结

我没有找到成熟、稳定、广泛使用的“直接提取小红书平台字幕轨”的公开方案。这个判断不是平台官方结论，而是基于现有 GitHub 项目与 skill 生态能力边界做出的推断。

## 3. 调研结果整理

### 3.1 现有小红书项目里，比较成熟的是“抓取层”

调研下来，最值得关注的几类项目如下。

#### A. XHS-Downloader

项目链接：

- https://github.com/JoeanAmier/XHS-Downloader/

它的价值在于：

- 覆盖小红书作品信息获取、作品文件下载、图文/视频处理
- 支持从浏览器读取 Cookie
- 支持 API/MCP 方式调用
- 明确面向“小红书链接 -> 作品信息/文件”的场景

适合作为：

- skill 的上游抓取 backend
- 或者至少作为实现思路参考

局限也很明显：

- 它本身不是“视频文案提取”工具
- 没有把 ASR/OCR/总结 这一整条链路打通
- 如果未来小红书改风控或页面结构，仍要依赖维护者跟进

结论：适合当“抓取层依赖”或参考实现，不适合直接等同于最终 skill。

#### B. ReaJason/xhs

项目链接：

- https://reajason.github.io/xhs/

这个项目更偏“请求封装/逆向接口接入”能力，适合研究：

- 小红书网页端数据请求如何组织
- Cookie 与签名服务如何参与请求
- 接口调用的能力边界

它的优点：

- 适合做研究和工程封装
- 对理解小红书数据层有帮助

它的缺点：

- 对签名、接口逆向、环境配置更敏感
- 更像底层能力库，不像一套“拿来就稳定跑”的 skill
- 不适合作为首版唯一依赖

结论：适合做研究样本或二号 backend，不建议作为首版核心唯一路线。

#### C. RedNote-MCP

项目链接：

- https://github.com/iFurySt/RedNote-MCP

它说明了一件很重要的事：对于小红书这类平台，“本地浏览器 + 登录态持久化 + 面向 AI 工具的接口层”是一条现实可行的路。

可借鉴点：

- 适合 AI agent / MCP 环境调用
- 强调登录态管理
- 更贴近“把平台能力接进 AI 工作流”

不足：

- 重点仍然是笔记/评论访问，不是视频 ASR/OCR 文案提取
- 需要浏览器与登录态配合

结论：非常值得借鉴“AI 工具接入方式”和“登录态策略”。

#### D. xiaohongshu-ops-skill

项目链接：

- https://github.com/Xiangyu-CAS/xiaohongshu-ops-skill

这个仓库不是做视频转写的，但它是一个很有价值的“skill 组织方式”样本，尤其说明：

- 小红书 skill 很适合做成“浏览器登录 + 本地持久化 + Markdown 输出”
- skill 不一定只负责抓数据，也可以负责把结果整理成知识库式文档

结论：它更像组织方式参考，不是直接可复用的转写方案。

### 3.2 我没有看到成熟的“小红书平台字幕轨直取”方案

我专门检索了“小红书字幕提取/小红书 transcript/caption extraction/rednote subtitle”相关开源方案，没有看到一个成熟的、以“小红书平台公开字幕轨提取”为核心能力的项目。

这意味着：

- 小红书公开视频页并不像 TikTok 那样，公开生态里已经形成较稳定的平台字幕抓取路径
- 如果要做“视频内容文案提取”，不能把希望放在平台字幕上
- 首版应该默认依赖本地 ASR，而不是等待平台给字幕

## 4. 与现有 Codex/TikTok skill 的对应关系

本地现有的 TikTok skill 很值得借鉴，尤其是下面这些原则：

- 用浏览器自动化而不是纯文本解析
- 先拿结构化数据，再用页面可见字段兜底
- 输出有明确的 Markdown 合同
- 失败时要明确说明原因
- 能部分成功就不要整体失败

参考文件：

- `/Users/otonashic./.codex/skills/tiktok-caption-extractor/SKILL.md`
- `/Users/otonashic./.codex/skills/tiktok-caption-extractor/scripts/extract_video.mjs`
- `/Users/otonashic./.codex/skills/tiktok-video-analyzer/SKILL.md`

其中最值得直接继承的思想是：

- skill 只定义工作流、输入输出、失败策略
- 复杂且脆弱的抓取逻辑交给脚本
- 让“摘要生成”和“数据提取”分层

这非常适合迁移到小红书场景。

## 5. 推荐实现架构

### 5.1 推荐的总架构

推荐实现成一个主 skill，内部拆分多个脚本：

```text
xiaohongshu-video-analyzer/
├── SKILL.md
├── scripts/
│   ├── extract_note.mjs
│   ├── transcribe_audio.py
│   ├── ocr_frames.py
│   └── analyze_video
└── references/
    ├── output-format.md
    └── risk-guardrails.md
```

职责建议如下：

- `SKILL.md`
  - 定义触发条件
  - 定义输入输出
  - 定义失败策略
  - 指导 Codex 先跑脚本，再做摘要

- `extract_note.mjs`
  - 处理小红书链接规范化
  - 支持短链跳转
  - 处理浏览器登录态
  - 获取笔记元数据
  - 获取视频下载地址或本地缓存文件

- `transcribe_audio.py`
  - 从视频中抽音频
  - 调用本地 ASR
  - 输出逐段文本和合并文本

- `ocr_frames.py`
  - 对视频抽帧
  - 提取字幕、贴纸、封面字、片中说明文字
  - 对 OCR 文本去重和时间片聚合

- `analyze_video`
  - 串联以上步骤
  - 生成最终 Markdown
  - 输出必要的中间产物

### 5.2 最稳的 backend 策略：可插拔

建议 skill 内部不要把“小红书抓取实现”写死成单一路线，而要做 backend 适配层：

- `XhsDownloaderBackend`
- `PlaywrightBackend`

推荐优先级：

1. 优先尝试成熟抓取 backend
2. 失败后切到本地 Playwright 持久化登录模式
3. 再失败则输出明确 blocker

这样做的好处：

- 平台变动时，修复面更小
- skill 不会被某一个抓取实现彻底绑死
- 更利于后续维护

## 6. ASR 与 OCR 的推荐选型

### 6.1 ASR：首推 faster-whisper

项目链接：

- https://github.com/SYSTRAN/faster-whisper
- https://github.com/openai/whisper

推荐 `faster-whisper` 的原因：

- 比原版 Whisper 更适合本地批量或重复调用
- 速度和资源占用更友好
- 更容易作为 skill 的稳定依赖

对于这个场景，ASR 是刚需，因为很多小红书视频并没有可靠的公开字幕轨。

### 6.2 OCR：首版推荐 RapidOCR，复杂场景可加 PaddleOCR

项目链接：

- https://github.com/RapidAI/RapidOCR
- https://github.com/PaddlePaddle/PaddleOCR

我的建议是：

- 首版默认 `RapidOCR`
- 后续如遇到复杂排版、花字、字幕条、竖排字等问题，再加 `PaddleOCR` 作为增强选项

原因：

- `RapidOCR` 更轻，适合 skill 环境快速部署
- `PaddleOCR` 更强，但更重

## 7. 输出格式建议

我建议最终 Markdown 固定为类似结构：

```md
# 小红书视频内容分析

## 基本信息
- 作者
- 笔记链接
- 发布时间
- 点赞/收藏/评论（如可得）

## 原帖文案

## 视频口播转写

## 画面文字提取

## 合并整理稿

## 内容总结

## 关键信息点

## 风险与缺失说明
```

几个关键原则：

- 不要把所有文本都混成一个“文案”
- 要区分来源，方便后续校验
- 即使 ASR/OCR 失败，也要保留已提取内容与失败说明

## 8. 首版最重要的工程策略

### 8.1 一定要支持“部分成功”

首版千万不要把成功条件卡得过死。建议策略：

- 拿到原帖文案，ASR 失败：仍输出 Markdown
- ASR 成功，OCR 失败：仍输出 Markdown
- 只有链接失效、风控拦截、视频拿不到时才整体失败

这样用户体验会好很多，也更利于真实使用。

### 8.2 一定要保留中间产物

建议在执行时保留：

- 抓取到的原始 JSON
- 规范化后的 note metadata JSON
- 音频文件
- ASR 结果 JSON/TXT
- OCR 结果 JSON/TXT

这样未来平台变动或结果不对时，才好 debug。

### 8.3 一定要把“风控/登录态”写进 skill 规则

小红书场景里，风控不是偶发问题，而是实现的一部分。建议在 `SKILL.md` 中明确：

- 优先单链接、低频、用户触发式使用
- 遇到登录或验证码时，优先提示用户配合浏览器态
- 不做批量爬取式默认行为

## 9. 不推荐的路线

### 不推荐路线 1：只抓原帖正文

这样做虽然最简单，但拿不到视频真正的内容表达，价值太低。

### 不推荐路线 2：只做 OCR，不做 ASR

很多视频没有完整硬字幕，只靠 OCR 会漏信息。

### 不推荐路线 3：首版完全依赖逆向接口签名

这类方案研究价值高，但维护成本也高。首版最好不要把整个 skill 的稳定性押在签名链路上。

### 不推荐路线 4：匿名 extractor 作为唯一通道

公开社区已经能看到小红书 extractor 因页面状态或 CAPTCHA 出现失败案例。匿名通道可以保留，但不应该是唯一依赖。

相关案例：

- https://github.com/yt-dlp/yt-dlp/issues/13578

## 10. 最终建议

如果目标是做一个真正“能长期用”的 skill，我建议的首版路线是：

1. 用现成成熟项目或 Playwright 持久化浏览器解决“链接 -> 笔记元数据/视频”
2. 用 `faster-whisper` 解决口播转写
3. 用 `RapidOCR` 解决画面文字提取
4. 用固定模板生成 Markdown
5. 允许部分成功，并保留中间产物

一句话概括：

> 最靠谱的不是“赌小红书页面上刚好有可提取字幕”，而是把抓取、转写、OCR、总结拆成稳定的流水线，再由 skill 编排起来。

## 11. 参考链接

### 小红书相关项目

- XHS-Downloader: https://github.com/JoeanAmier/XHS-Downloader/
- ReaJason/xhs: https://reajason.github.io/xhs/
- RedNote-MCP: https://github.com/iFurySt/RedNote-MCP
- xiaohongshu-ops-skill: https://github.com/Xiangyu-CAS/xiaohongshu-ops-skill
- yt-dlp issue #13578: https://github.com/yt-dlp/yt-dlp/issues/13578

### 转写 / OCR

- faster-whisper: https://github.com/SYSTRAN/faster-whisper
- OpenAI Whisper: https://github.com/openai/whisper
- RapidOCR: https://github.com/RapidAI/RapidOCR
- PaddleOCR: https://github.com/PaddlePaddle/PaddleOCR
- video-subtitle-extractor: https://github.com/YaoFANGUK/video-subtitle-extractor

### Skill 组织方式参考

- OpenAI Skills: https://github.com/openai/skills
- Claude Code Skills 文档: https://code.claude.com/docs/en/skills
- AI-Media2Doc: https://github.com/hanshuaikang/AI-Media2Doc

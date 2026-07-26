# Business Communication Knowledge

用于 IM 会话、消息明细、客服诊断、买家回复、知识问答、深度研究。候选域：`communication`、`icbu.icbu-reception-mcp-service`、`member`、`cco`、`cogito`、`default`。

## IM 会话顺序

1. 解析时间窗口，确认毫秒/秒单位和工具窗口限制。
2. 先查会话列表，再按会话 ID 查消息明细。
3. 多个会话 ID 的消息明细、卡片详情、文件详情互不依赖时，用 `workctl batch call` 并行查；先用小 limit 控制上下文。
4. 卡片、文件、语义化消息需要按 schema 参数开启对应描述字段。
5. 输出会话摘要、异常点、买家状态和后续动作。

### 会话消息游标 SOP

- `workctl icbu tm list-conversation-msg` 首次以默认 `forward=false` 向历史查询时可以省略 `--limit-time-stamp`；CLI 自动注入执行时的当前 Unix 毫秒时间戳。
- 返回 `hasMore=true` 后，下一页必须显式传上一页返回的 cursor/`nextTimeStamp`，不要再次省略游标，否则会重新读取第一页。
- `forward=true` 用于从既有时间点向新增方向读取，必须显式传 `--limit-time-stamp`；CLI 不猜增量起点。
- 不要用 `--time last-7d` 代替首次消息游标；通用时间 preset 会映射窗口起点，不等价于当前时间。

## 客服诊断顺序

1. 店铺维度看整体服务表现和行业对比。
2. 账号维度看员工/子账号表现。
3. 质检明细看已读未回、超时回复、重复回复等异常。
4. 店铺、账号、质检、经营补充数据可以在同一时间窗下 batch 并行读取；需要先拿账号/会话 ID 的步骤除外。
5. 可联动经营数据判断询盘质量或转化影响。

## 买家回复顺序

1. 查询买家基本信息、卖家基本信息、商品知识、商家知识库；这些只读上下文优先 batch 并行获取。
2. 根据买家 query 检索知识库。
3. 生成回复建议；需要发送消息时展示接收人、内容、domain、附件并确认。
4. 超过 30 天流失买家只在工具允许时调用对应挽回回复能力。

### 沉寂时长输入 SOP

- 单个买家使用 `workctl workflow chat-analysis calc-silence --timestamp-ms <毫秒时间戳>`。
- 多个买家统一使用 `calc-silence --stdin`，从 stdin 传入“买家名称到毫秒时间戳”的 JSON 对象；不要创建临时 `silence_input.json`。
- `calc-silence` 不接受 `--input-file`。`--timestamp-ms` 与 `--stdin` 两种模式互斥。
- `--output` 会自动创建父目录，调用方不需要预创建 seller_reply 输出目录。

## 知识问答和深度研究

1. 国际站后台、规则、物流、结算等知识优先用 `cco` 知识切片。
2. 外部市场研究、竞品、公开资料用 `cogito` 或 web/search 类能力。
3. 深度研究、网页检索、长摘要若是异步/长任务，优先 `--wait` 或 `--async` 后 `task wait`，不要手写轮询。
4. 业务账号态数据不要用泛搜索替代。
5. 输出需要区分“知识库依据”和“公开网页依据”。

## 注意事项

- IM 历史窗口、时间戳格式、分页方向必须以 schema/help 为准。
- 发送消息/文件是写操作，必须确认。
- 不要暴露内部工具名给最终商家用户；可说明“根据会话数据/知识库/公开资料”。
- 子账号、买家 ID、会话 ID 必须来自工具返回或用户输入。

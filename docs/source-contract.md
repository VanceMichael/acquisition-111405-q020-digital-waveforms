# 来源与既有应用契约

## 新来源

GET /waveform 返回runId、chunks按顺序URL和sealed。内容为VCD本地子集，支持$scope module NAME $end、$upscope $end、$var wire WIDTH CODE NAME $end、$timescale N UNIT $end、$enddefinitions $end、#整数时标、标量0/1/x/z+CODE、向量bBITS CODE、$dumpvars/$dumpoff/$dumpon及$end。UNIT为s/ms/us/ns/ps，统一输出timePs整数十进制字符串；标量大小写x/z归小写。code可对应多个全路径声明，宽度必须兼容；向量短值按最高位为x/z则同符号扩展，否则补0。dumpoff后的观测status=suspended，dumpon只有明确给出的值恢复observed，不补造期间变化。输出runId、signalPath、code、timePs、bits、status、sourceSpan。

本地来源只实现以上明确子集，不要求补全同类公开标准。未声明的字段与语法不得自动解释成有效业务事实。样本中的所有人员、账户、样本、设备与文件内容均为合成资料，无生产访问凭据。

## 接收接口

既有调用是 `collect({baseUrl, archive, mode})`。`mode` 默认为 `legacy`；新增来源使用 `source`。返回 `{records, complete, issues, evidenceCount}`：`records` 为本次业务结果，`complete` 表示本次领取及解释是否有未决缺口，`issues` 为带来源位置的可复核问题，`evidenceCount` 为实际接收的原文数。新结果可增加字段，示例不是封闭 schema。

`source` 模式另返回 `runId`。记录按每次观察生成，包含 `runId`、`signalPath`、`code`、`timePs`、`bits`、`status`、`sourceSpan`、`declaration` 与 `aliases`。同一短代码声明多个别名时，每个别名各有一条记录，`aliases` 列出全部声明；宽度不兼容时整段不解释并留下 `alias-width-conflict`。`sourceSpan` 给出观察在原文中的 `{url, chunk, offset}` 起止与字节长度，`declaration.sourceSpan` 指向该别名的 `$var` 声明。

解释规则：

- 分块按索引次序到达，边界落在词法单元中间时保留字节，等后续分块闭合后再解释；本次接收结束时仍未闭合的片段记为 `incomplete-fragment`，不产生记录。
- `#N` 与 `$timescale` 均按整数精确换算为 `timePs` 十进制字符串，不经浮点。
- 未知（`x`）与高阻（`z`）原样保留；向量短值最高位为 `x`/`z` 时同符号扩展，否则补 `0`。
- `$dumpoff` 之后所有观测 `status=suspended`，直到 `$dumpon`；`$dumpon` 只恢复明确给出的值，不补造期间变化，也不为静默区间生成观测。
- 声明之前的值、未声明的短代码、宽度溢出、不支持的语法，均不转为业务记录，而是留下带来源位置的 `issues` 并把 `complete` 置为 false。
- 来源未封存（`sealed=false`）或任一分块未取到时，已收到的独立部分照常归档，但 `complete` 为 false。

每个落库记录的 `id` 必须非空且稳定，由业务身份决定；业务所需的多身份关系不能都压缩进 `id`。`archive.commit` 接受 `records`、`exchanges` 与 `issues`；原文在 `raw/` 以 SHA-256 寻址，索引引用原文与记录修订。既有归档索引 schema=1 可以扩展，但旧摘要记录必须仍可读取。重复领取同一来源不会重复写入同一记录修订或同一条问题。

应用不得伪造原文，也不能把摘要模式当成新来源成功。HTTP 相对链接基于来源 origin 解析，不能访问其他站点。错误状态、缺数据和空的有效结果应区分。来源解释未决时 `complete=false`，已收的安全独立部分可以保留。

## 可运行资料

`fixtures/scenarios.json` 提供来源响应及预期业务片段；`expected`/`forbidden` 只供回归断言，采集代码不得读取该文件。来源用真实 HTTP 发送数据，二进制夹具由 `$hex` 或 `$octets` 编码，接收方不会看到这些包装键。`/__requests` 是本地测试用请求审计接口，不是资料源。

连续相同 method/path 响应可按数组次序变化，最后一次响应保持；`after` 表达来源步骤先后，`once` 为单次凭证。POST 搜索会按来源能力拒绝不支持的条件。接收端不需要实现来源服务，也不得删改来源限制来通过测试。

上述契约和题面决定功能范围。公开回归提供正常与有冲突/缺口的样例，并未穷举所有组合；应补充与实际设计相符的边界验证。运行与演示不连接新闻站点或其他线上服务。

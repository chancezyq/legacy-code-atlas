# TheDailyPlan 验证记录

## 样本

- 仓库：[VHAINNOVATIONS/TheDailyPlan](https://github.com/VHAINNOVATIONS/TheDailyPlan)
- 固定 commit：`e3571c8c3b1ee99e38f056f00d2189e9533f9cba`
- 下载 archive SHA-256：`e60fe2983735a1e50e2886043938c58559bc1e797ed90e0216118ab50bb00749`
- 代码年代：仓库中的 SQL Server schema 脚本来自 2010 年；仓库最后一次提交为 2017 年。
- 架构：Struts 2、JSP、Java、iBATIS 2、SQL Server。
- 关键文件：`LegacyApp/tdpWeb/src/main/resources/struts.xml`、`LegacyApp/tdpWeb/src/main/resources/sqlmaps/EventSQL.xml`、`LegacyApp/tdpWeb/src/test/resources/net.sourceforge.jtds-schema.sql`。

## 下载与边界

下载后先只列出 tar 路径，确认没有绝对路径、`..` 穿越或符号链接，再解压到临时目录。Atlas 只读源码和配置；没有运行项目、Java、JSP、SQL、procedure，也没有连接 SQL Server。生成的 index 与源码一样按敏感数据处理，验证结束后应删除临时目录。

## 扫描结果

仓库物理 inventory 与 Atlas 默认扫描边界：

```text
仓库 inventory（Java/JSP/XML/SQL）：758 files / 84,169 newline records
默认忽略 build/target：4 generated files / 69 newline records
实际扫描输入：754 files / 84,100 newline records
Graph：6,650 nodes / 7,678 edges
冷缓存 analyze：约 1.06 s（本机 Node.js v25.9.0，单次测量）
docs：约 0.32 s，31 use cases / 37 pages / 4 modules
routes：37 total / 31 selected as use cases
整体截断：否
```

节点类型包含 1 个 procedure、71 个 iBATIS statement、37 个 route、47 个 Spring bean 和 11 个 table。关系类型包含 24 个 `dispatches_to`、25 个 `maps_to`、1 个 `calls_procedure`、27 个 `uses_statement` 和 27 个 `writes_to`。

## 人工核验

1. `struts.xml:134` 的 `definitions` action 使用 `struts.action.extension=html`，Atlas 生成 `/admin/definitions.html`，并连接到 `DefinitionAction.list` 和 `definitionList.jsp`。
2. `struts.xml:128` 的 `class="userAction"` 通过 `applicationContext-struts.xml:10` 解析为 `UserAction`，并连接到 `UserAction.list`；`searchAction` 和 `printPreviewAction` 采用同一规则。
3. 下游方向经 Graph edge 逐段确认：`DocumentEventDaoiBatis.generateReportId -> EventSQL.genReportId -> dbo.get_next_sequence -> dbo.sequence`，对应 `uses_statement -> calls_procedure -> writes_to`。`EventManagerImpl.generateReportId` 和 `ReportManagerImpl.generateReportId` 是经接口关系连接的上游调用方，不能把整条链反向书写。
4. UCS 没有静态资源或直接 JSP use case；`/admin/printPreviewDisplay.html` 不存在，唯一配置的 `/printPreviewDisplay.html` 被保留。`clickstreams.jsp:53` 的动态 query 会保留静态 pathname `/admin/viewstream.jsp`，把 `sid` 值记录为未知，但该 navigation route 不会进入 UCS。JSP 的静态 DMI `uploadFile!upload` 对齐到 `/uploadFile.html`，request hint 保留 `dispatchMethod=upload` 并解析到 `FileUploadAction.upload`；Graph/UCS 中不存在重复的 `/uploadFile!upload.action`。31 个 use case 中没有整体截断。
5. 固定样本共有 53 个带 outcome metadata 的 Struts 配置 edge：52 个 `configured-candidate`，1 个 `code-confirmed`。唯一确认项是 `/uploadFile.html` 的 `cancel` result，证据为 `FileUploadAction.upload` 在 `FileUploadAction.java:29` 的直接字面量 `return "cancel";`；通过 `SUCCESS` 常量返回的结果仍是 candidate。
6. `userForm.jsp` 中仅带静态 Struts 2 `key` 的字段已进入 UIS；`pickList.jsp` 的两个运行时字段名被省略并各自报告源码行 warning。`${...}`、`%{...}` 和嵌套 tag 输出均未被写成静态默认值。

## 本次优化

- Struts2 parser 读取 `struts.action.extension`；未配置时维持 `.action` 默认行为。
- `redirectAction` 沿用 action extension；JSP Struts2 tag 会用显式 namespace 区分同名 action，未提供 namespace 时仅在 action 名全局唯一时对齐。静态 `action!method` 会对齐到配置 route，并把 method 作为 evidence-scoped request hint 交给 resolver；多个 method hint 保持歧义，不会任选一个升级 outcome。
- Struts2 `class` 为 Spring bean id 时，resolver 通过 bean 的 class 解析 Java Action；外部类或缺少源码的 entry 仍报告 warning。
- XML parser facts 版本升至 `1.3.4`，确保旧 cache 不会复用缺少 extension 字段的结果。
- 只有具备后台入口证据的 route 才成为 UCS use case；静态资源、直接 JSP 和未解析 markup 仍保留为页面导航或 warning。
- 相对 native form 会与唯一配置的 Struts 2 route 对齐，避免从 arrival context 复制出错误 namespace。
- Struts outcome edge 使用 `data.outcome.framework/name/classification/codeEvidence` 区分配置候选和代码返回可能性；`confidence` 只描述配置提取，不承载该 modality。旧索引缺少或包含非法 metadata 时统一回退为 candidate。
- 代表性主流程之外会保留有不同 Java/page/route/statement/procedure/table 的备选分支，并为每条分支独立显示 confidence；图中未展开的聚合表访问使用带 `aggregated` 标签的虚线。
- 动态 JSP 字段名不会作为字面字段或搜索词进入 Graph；如果属于可提交表单，请求会保留 `hasDynamicParameterNames` 与 `parametersComplete=false`，且不会借用同页另一表单的字段。静态 Struts 2 `key` 可作为输入绑定名，动态字段值不会冒充静态默认值。
- Java parser facts 版本升至 `1.4.7`，JSP parser facts 版本升至 `1.5.10`，避免复用缺少返回证据、规范类型信息、方法可见性或包含旧 markup/字段误判的 cache。
- `fmt:message` 等通用 taglib resource key 目前不会作为独立 evidence 进入 UIS，这是已知限制；运行时标签仍需结合 JSP 与资源文件复核。

## 结果

固定 commit 仓库根目录的 real-project release gate 已完成；上面的 Graph、文档统计和 required/forbidden assertions 均来自本次根目录冷缓存重建，而不是此前 `LegacyApp/tdpWeb` 子目录的探索结果。

fresh benchmark（500 组 fixture、3 samples）结果为 baseline 中位数 `16,048.205625 ms`、candidate 中位数 `977.367958 ms`、speedup `16.419819673482685x`，超过项目要求的 `3x` 门槛。

Windows PowerShell 5.1 的真实 junction 场景不能由本次 macOS 验证替代。当前 installer release gate 仍需在 Windows 上运行 `npm run test:installer:windows` 并达到 `91 pass, 0 skip`。

该样本有 8 条可解释 warning：`pickList.jsp` line 4/31 的两个动态字段名、1 个二进制 JavaScript 文件、缺少源码的 `PdfServlet`、两个 `ActionSupport` 入口，以及外部 DWR/CXF servlet。它们明确保留外部依赖或运行时不确定性，没有被强行连成已证明的业务关系。

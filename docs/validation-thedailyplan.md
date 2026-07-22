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

冷缓存首次全量扫描：

```text
源码文件（Java/JSP/XML/SQL）：758
源码行数：84,169
Graph：7,186 nodes / 8,213 edges
首次扫描耗时：约 1.06 s（本机 Node.js v25.9.0，单次测量）
```

节点类型包含 1 个 procedure、71 个 iBATIS statement、37 个 route、47 个 Spring bean 和 11 个 table。关系类型包含 24 个 `dispatches_to`、25 个 `maps_to`、1 个 `calls_procedure`、27 个 `uses_statement` 和 27 个 `writes_to`。

## 人工核验

1. `struts.xml:134` 的 `definitions` action 使用 `struts.action.extension=html`，Atlas 生成 `/admin/definitions.html`，并连接到 `DefinitionAction.list` 和 `definitionList.jsp`。
2. `struts.xml:128` 的 `class="userAction"` 通过 `applicationContext-struts.xml:10` 解析为 `UserAction`，并连接到 `UserAction.list`；`searchAction` 和 `printPreviewAction` 采用同一规则。
3. `EventSQL.xml:131` 的 `<procedure id="genReportId">` 调用 `get_next_sequence`，Atlas 连接到 `dbo.get_next_sequence`。
4. SQL Server procedure 定义位于 `net.sourceforge.jtds-schema.sql:451`，其 `INSERT INTO dbo.[sequence]` 被识别为 `writes_to table:dbo.sequence`。
5. `DocumentEventDaoiBatis.generateReportId` 的 `queryForObject("genReportId", ...)` 连接到 statement，再经 interface implementation 和 service 调用链到 procedure。

## 本次优化

- Struts2 parser 读取 `struts.action.extension`；未配置时维持 `.action` 默认行为。
- `redirectAction` 沿用 action extension；JSP Struts2 tag 在 action 名唯一时对齐到带 namespace 的真实 route，多 namespace 同名时不猜测。
- Struts2 `class` 为 Spring bean id 时，resolver 通过 bean 的 class 解析 Java Action；外部类或缺少源码的 entry 仍报告 warning。
- XML parser facts 版本升至 `1.3.4`，确保旧 cache 不会复用缺少 extension 字段的结果。

## 结果

本次兼容性回归验证：`528 tests, 468 pass, 0 fail, 60 Windows-only skip`。冷 benchmark（500 组 fixture、3 samples）结果：baseline 中位数 `16,081.13 ms`，candidate 中位数 `946.29 ms`，speedup `16.99x`，超过项目要求的 `3x` 门槛。当前 Windows 安装器套件共 `70` 项；真实 Windows 安装器场景仍需在 Windows PowerShell 5.1 上达到 `70 pass, 0 skip`，这里的 macOS 结果不能替代该门禁。

该样本仍有 7 条合理 warning，主要来自没有源码的 `com.opensymphony.xwork2.ActionSupport`、外部 DWR/CXF servlet、注释中的脚本引用，以及没有请求方法提示的 `PdfServlet`。这些 warning 已人工区分为外部依赖或不确定运行时行为，不把它们强行连成业务关系。

# Legacy Code Atlas

[English](README_EN.md) | 简体中文

在公司的 OpenCode 桌面客户端中，用 `/understand` 理解 JSP、Struts、Java、iBATIS 和 SQL Server 老项目。

```text
JSP / JavaScript
-> URL
-> Struts / Servlet / Spring XML
-> Action / Service / DAO
-> iBATIS statement
-> SQL Server 表
```

它不连接数据库，也不调用另一套模型。OpenCode 继续使用公司已经配置的模型；分析器只读取下载到本机的源码并生成本地索引。

## 三步开始使用

### 1. 下载并解压

下载这个仓库的源码压缩包，解压后进入 `legacy-code-atlas` 目录。

电脑需要：

- Windows 10/11 或 Windows Server
- Windows 自带的 Windows PowerShell 5.1
- Node.js 20 或更高版本，可先运行 `node --version` 检查
- OpenCode 1.14.49 或更高版本，或者支持 Agent Skill 和 plain JSON Schema 自定义工具的公司 OpenCode fork

公司 fork 的版本号可能不同，关键是它能从用户目录加载 Agent Skill 和自定义工具。

### 2. 安装到 OpenCode

在解压后的目录打开 Windows PowerShell，执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

不需要管理员权限。安装脚本只复制已下载的文件，不联网，也不运行 `npm install`。看到“安装完成”后，完全关闭再重新打开 OpenCode。

### 3. 分析后再提问

先进入公司老项目目录并启动 OpenCode。第一条消息只输入下面这一行，不能在后面附加问题：

```text
/understand
```

等项目分析完成后，下一条普通消息不要带斜杠，直接提问。例如每次发送其中一条：

```text
退款审核功能在哪里？
```

```text
URL /order/audit.do
```

```text
statement order.updateStatus
```

```text
表 dbo.T_ORDER
```

```text
procedure dbo.usp_OrderAudit
```

源码发生变化后，再单独发送一次：

```text
/understand
```

分析完成后继续用普通消息提问。日常使用不需要执行 PowerShell 或 Node.js 命令。

## 能查什么

- 按业务描述查页面、URL、Action、Service、DAO、iBATIS statement 和表。
- 按 URL 追踪 Struts/Servlet 映射和后续 Java 调用。
- 按完整 iBATIS statement ID 找 SQL 和调用方。
- 按 SQL Server procedure 名称反查 iBATIS/Java 调用方、嵌套 procedure 和读写表。
- 按 SQL Server 表名反查读写位置和上游入口。

结果会附源码文件和行号。配置或源码直接证明的关系可信度较高；启发式关系、动态 URL、反射和缺失源码需要打开引用文件复核。不要把低于 `0.95` 的关系直接当成事实。

## 安装位置

默认安装到当前 Windows 用户目录：

```text
%USERPROFILE%\.legacy-code-atlas\
%USERPROFILE%\.agents\skills\understand\SKILL.md
%USERPROFILE%\.config\opencode\tools\legacy_atlas.ts
```

Agent Skill 的位置固定在 `%USERPROFILE%\.agents\skills\understand\SKILL.md`。如果首次安装时设置了 `OPENCODE_CONFIG_DIR`，只有 OpenCode tool 会安装到该配置目录的 `tools\legacy_atlas.ts`；否则使用上面的默认位置。

首次选择的 OpenCode 配置目录会作为 manifest 的 `configDir` 保存在 `%USERPROFILE%\.legacy-code-atlas\.legacy-code-atlas-owner.json`。以后更新和卸载始终使用保存的 `configDir`，之后改变 `OPENCODE_CONFIG_DIR` 不会迁移现有安装。

旧的 `commands\understand.md` Markdown command 已移除；当前入口是全局 Agent Skill。

## 更新和卸载

更新时下载并解压新版源码，在新版目录重新执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

更新会复用 manifest 保存的路径。任何安装器拥有的 Skill 或 tool 被修改后，更新都会拒绝覆盖；先按[详细恢复说明](docs/opencode.md)确认文件来源并备份，不要直接删除冲突文件。

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

SHA-256 匹配才删除、修改后保留的规则，只适用于 runtime 之外的 Agent Skill 和 OpenCode tool。公司项目和共享 OpenCode 配置目录不会被删除。

`%USERPROFILE%\.legacy-code-atlas\` 是安装器私有 runtime；卸载时始终递归删除它的整个目录，包括额外新增和已经修改的文件。不要把自己的文件放进 `%USERPROFILE%\.legacy-code-atlas\`。

## 本地缓存

每次 `/understand` 或 CLI `analyze` 会在项目的 `.legacy-code-atlas\cache.json` 保存经过 fingerprint 校验的单文件解析结果。下一次扫描仍会读取文件并计算 SHA-256；内容未变化且 parser schema/version 相同的文件会直接复用，源码、parser 版本或缓存格式变化会自动重新解析。

缓存写入使用同目录临时文件和原子替换。缓存文件缺失、损坏、路径非法或条目不完整时只按 cache miss 处理；缓存写入失败会记录诊断，但不会丢弃已经生成的 Graph。不要手动把机器绝对路径或自定义对象写进缓存；需要彻底重建时删除项目下的 `.legacy-code-atlas` 目录后再次运行 `/understand`。

## 大项目建议

当前目标规模是少于 5 万个文件、200 万行源码。第一次可以从熟悉的业务模块试用，并准备 5 到 10 个已知答案，核对页面、Action、DAO、statement 和表能否连通。

在项目根目录创建 `.legacy-code-atlasignore`，排除备份、生成物、第三方库和无关测试数据：

```gitignore
backup/**
generated/**
tmp/**
WebRoot/vendor/**
web/js/lib/**
src/test/**
```

扫描器还会忽略 Git、IDE 文件、依赖目录、编译输出、二进制文件、符号链接和大于 5 MiB 的文件。不要在忽略文件中排除需要追踪的 Struts/iBATIS XML 或 procedure 源文件。

## 当前限制

- SQL Server procedure 支持 `CREATE/ALTER PROCEDURE`、参数、嵌套 `EXEC`、读取/写入表，并可从 iBATIS `<procedure>` 或包含静态 `CALL/EXEC` 的通用 `<statement>` 追踪到 procedure；通用 `<statement>` 中的多条 DML 会合并读写表，不会连接数据库或执行 procedure。
- Struts 2 支持 package namespace、action、method、result 到 Java 方法和 JSP 页面；Struts 1 仍按 `struts-config.xml` 规则解析。
- Struts 2 会读取 `struts.action.extension`，因此配置为 `html` 的项目会生成实际的 `.html` route；`redirectAction` 会沿用同一扩展名并生成 `redirects_to` route。
- Struts 2 的 `class` 如果是 Spring bean id，会通过 Spring bean 的 `class` 属性解析到 Java Action；同名 bean 或缺失源码仍会保留 warning。
- Struts 1 forward 指向 Tiles definition 时会生成 `uses_tile`。
- Tiles 支持 definition 跨 XML 文件继承、template 和 put 页面关系；动态运行时组合仍需打开原始 JSP/XML 复核。
- 动态拼接 URL、运行时反射和缺失源码可能产生未解析关系。
- Java 调用会按当前 Java 文件、类型和方法解析成员字段、局部变量，以及当前类或父类中无参方法的返回类型（例如 `getPetStore().insertOrder(...)`）；同名重载按规范化参数类型签名隔离（旧 facts 没有签名时回退到参数个数）。带参数的工厂调用、限定对象的多段调用链、反射和未声明的动态对象仍需人工复核。
- JSP 支持原生表单/链接以及常见 Struts 1 `html:*` rewrite/link/form、Struts 2 `s:*` form/link/url 标签；静态 `page`/`href` 和 URL 标签中的 `value` 会建路由，Struts `s:a value` 仅作为显示文本，动态 action、namespace、EL/OGNL 和 JavaScript 拼接 URL 不会建路由，需要打开源码人工复核。

## 真实项目验证

使用公开仓库 [VHAINNOVATIONS/TheDailyPlan](https://github.com/VHAINNOVATIONS/TheDailyPlan)，固定 commit `e3571c8c3b1ee99e38f056f00d2189e9533f9cba` 做了离线静态验证。该项目包含 Struts 2、JSP、Java、iBATIS 2 和 SQL Server procedure 源码：

- `LegacyApp/tdpWeb/src/main/resources/struts.xml` 配置 `struts.action.extension=html`，并声明 `definitions`、`saveDefinition` 等 Action。
- `LegacyApp/tdpWeb/src/main/resources/sqlmaps/EventSQL.xml:131` 的 iBATIS `<procedure>` 调用 `get_next_sequence`。
- `LegacyApp/tdpWeb/src/test/resources/net.sourceforge.jtds-schema.sql:451` 定义 `dbo.get_next_sequence`，并写入 `dbo.sequence`。
- `LegacyApp/tdpWeb/src/main/webapp/WEB-INF/applicationContext-struts.xml` 把 `userAction`、`searchAction`、`printPreviewAction` 绑定到真实 Java Action 类。

冷缓存首次扫描统计为 758 个 Java/JSP/XML/SQL 源文件、84,169 行，生成 7,186 个节点和 8,213 条关系。人工核验的结果包括：`/admin/definitions.html -> DefinitionAction.list -> definitionList.jsp`，以及 `dbo.get_next_sequence -> EventSQL.genReportId -> DocumentEventDaoiBatis.generateReportId -> EventManager/ReportManager -> dbo.sequence`。扫描器没有运行 Java、JSP、SQL、procedure，也没有连接 SQL Server。

这次真实样本促成了三项回归：读取 Struts2 action extension、redirect/JSP route 使用实际扩展名，以及通过 Spring bean id 解析 Action 类。剩余 warning 主要是仓库中没有源码的 `ActionSupport`、外部 DWR/CXF servlet、注释里的脚本引用和无 HTTP 方法提示的 servlet，不能据此推断为业务链路缺失。详细过程见 [TheDailyPlan 验证记录](docs/validation-thedailyplan.md)。

## 性能基准

开发者可以在仓库目录运行冷缓存 benchmark：

```powershell
$env:ATLAS_BENCH_FILES = 500
$env:ATLAS_BENCH_SAMPLES = 3
npm run benchmark
```

它生成可重复的 JSP/Java/iBATIS/Struts fixture，分别运行冻结的 `0.1.0` baseline 和当前候选，运行前删除两边的 `.legacy-code-atlas`，并先验证两份 Graph 字节完全一致。默认门槛是候选中位数至少比 baseline 快 `3.00x`；可以用 `ATLAS_BENCH_MIN_SPEEDUP` 做本地诊断，但发布前不要降低门槛。真实公司项目仍需单独记录文件数、源码行数、机器配置和冷/热缓存结果。

`ATLAS_BENCH_FILES=500` 表示 500 组生成 fixture，每组会生成多种源码文件；它用于稳定比较 baseline 和 candidate，不代表已经在 5 万个真实文件或 200 万行公司源码上完成容量验证。

当前版本的缓存只复用逐文件解析结果，不会跳过目录扫描、文件 fingerprint、Graph materialize 或关系解析；因此它主要降低重复分析的解析 CPU 和 worker 时间，不能替代首次全量扫描 benchmark。

## 数据安全

- 不运行公司项目、JSP、Java、SQL 或 procedure。
- 不连接或修改 SQL Server。
- 不把普通问题拼接进 Shell 命令。
- 不加载 XML 外部实体。
- 项目源码是敏感数据；生成的 `.legacy-code-atlas/index.json` 包含源码结构、路径和 SQL，也必须按公司源代码敏感数据管理。
- 安装和分析都可离线完成；实际模型是否联网由公司的 OpenCode 配置决定。

## 遇到问题

OpenCode 中没有入口时，先确认安装脚本显示成功，然后完全退出所有 OpenCode 进程再启动。安装脚本必须与 OpenCode 使用同一个 Windows 用户。公司 fork 无法按版本号判断时，请确认它是否支持全局 Agent Skill 和 plain JSON Schema 自定义工具。

如果看到 `Bun is not defined`，说明 OpenCode 仍在加载旧版 `legacy_atlas.ts`。从最新源码目录重新运行 `install.ps1`，确认安装成功后完全退出并重新启动 OpenCode；当前 tool 使用 Node.js 标准模块，不依赖 `Bun` 全局对象。

第一次分析太慢时，先完善 `.legacy-code-atlasignore`，或者从一个业务子模块开始。查询“未找到”时，先重新单独运行一次：

```text
/understand
```

然后在下一条普通消息中换用 URL、Java 类名、完整 statement ID 或表名提问。

更详细的 manifest v2 检查、冲突处理和崩溃恢复见 [OpenCode 安装与恢复](docs/opencode.md)。

## 开发验证

通用测试：

```powershell
npm test
```

真实 Windows 安装器发布门禁见 [OpenCode 安装与恢复](docs/opencode.md)。

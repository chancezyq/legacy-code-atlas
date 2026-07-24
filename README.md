# Legacy Code Atlas

[English](README_EN.md) | 简体中文

在公司的 OpenCode 桌面客户端中，用 `/atlas` 理解 JSP、Struts、Java、iBATIS 和 SQL Server 老项目。

```text
JSP / JavaScript
-> URL
-> Struts / Servlet / Spring XML
-> Action / Service / DAO
-> iBATIS statement
-> SQL Server 表
```

它不连接数据库，也不调用另一套模型。OpenCode 继续使用公司已经配置的模型；分析器只读取下载到本机的源码并生成本地索引。运行时集成采用与 Understand-Anything 相似的 Skill-only 方式：全局 Agent Skill 调用固定的 Node.js CLI，不依赖 OpenCode custom tool 或 Bun。Understand-Anything 在公司客户端能运行，只展示了部分相似能力，不能证明该客户端已经兼容 Atlas。

## 三步开始使用

### 1. 下载并解压

下载这个仓库的源码压缩包，解压后进入 `legacy-code-atlas` 目录。

电脑需要：

- Windows 10/11 或 Windows Server
- Windows 自带的 Windows PowerShell 5.1
- Node.js 20 或更高版本，可先运行 `node --version` 检查
- OpenCode 1.14.49 或更高版本，或者能从用户目录加载 Agent Skill、提供 structured `write` 和 metadata-only 存在性检查、并允许 Skill 使用固定 Shell 命令的公司 OpenCode fork

公司 fork 的版本号可能不同；关键是它能从用户目录加载 Agent Skill、提供上面的两个 host 文件操作，并允许该 Skill 使用固定命令。这里没有运行时 custom tool 依赖。

这些固定命令要求 PowerShell 兼容或 POSIX/Git Bash Shell 语义，并能展开 `$HOME` 和 `$PWD`；仅提供 cmd.exe 的 host 不支持。第一次全量扫描应使用 host 最长可支持的 timeout；如果前台上限仍不足而 host 支持 background execution，就必须在后台启动后等待 `analyze` 完成，不能依赖短的默认 timeout。

> **命名空间说明：** Atlas 的入口现在是 `/atlas`，安装在 `%USERPROFILE%\.agents\skills\atlas`，不再与 Understand-Anything 的 `/understand`（`%USERPROFILE%\.agents\skills\understand`）冲突，两者可以共存。若公司电脑装过旧版 Atlas（当时占用 `/understand` 入口），请先用当时下载的源码运行 `install.ps1 -Uninstall` 卸载旧版，再安装本版本。安装器不会覆盖不属于自己的现有 Skill 目录；不要直接删除未知的 Skill 目录。

### 2. 安装到 OpenCode

在解压后的目录打开 Windows PowerShell，执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

不需要管理员权限。安装脚本只复制已下载的文件，不联网，也不运行 `npm install`。看到“安装完成”后，完全退出所有 OpenCode 进程，再重新打开 OpenCode；只关闭窗口可能仍会留下 Skill 或旧 tool 缓存。

### 3. 分析后再提问

先进入公司老项目目录并启动 OpenCode。第一条消息只输入下面这一行，不能在后面附加问题：

```text
/atlas
```

Skill 会先运行只读的 OpenCode 兼容性检查 `doctor`，只有它以状态 `0` 结束后才运行 `analyze`；`analyze` 成功后才运行 `overview`。三个固定命令使用独立 Shell 调用，任一步失败都会停止，不会把旧索引说成刷新成功。`doctor` 不导入、执行、移动或删除任何 OpenCode tool，也不修改项目。

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

URL、statement ID、表名和 procedure 名会保留准确的源码标识符，无匹配时不会猜测替换。普通业务问句会由公司现有模型转换为一个简短的源码语言搜索候选；例如英文项目中的 `订单审核功能在哪里？` 可以转换为 `OrderAudit`。这个自然语言候选无匹配时，Skill 最多再尝试两个短候选。

处理普通问题前，Skill 先用 metadata-only existence check 确认 `.legacy-code-atlas/index.json` 存在；缺失时会要求单独运行 `/atlas` 并停止。索引存在后，它先运行固定的 `prepare-query` 预检，再让 OpenCode 的 structured `write` 只把选定的源码语言候选或准确标识符写入项目下的 `.legacy-code-atlas/query.txt`，最后用不带用户参数的固定 Node 命令、`--query-file` 和 `--no-match-ok` 调用对应 trace。`--no-match-ok` 只把合法的“无匹配”结果从退出码 `3` 改为 `0`，让有限次数的自然语言候选回退能继续；无效查询、索引、文件或 runtime 错误仍会失败。原始问题和候选都不会拼接进 Shell 命令；你不需要手工创建或编辑这个文件，回答中会列出实际搜索过的候选。

静态 artifact 防护会拒绝 symlink/junction 形式的 `.legacy-code-atlas` 目录，以及 symlink、junction 或 hardlink 形式的标准 `index.json`。`prepare-query` 会只移除项目内预先存在的 linked `query.txt` entry，再原子写入新的普通文件；`analyze` 同样把 linked `cache.json` 当作 cache miss 并替换项目内 entry。两种操作都不会跟随链接读取或改写外部 target。

从磁盘加载的 Graph index 最大为 `512 MiB`，必须是有效 UTF-8 和 `1.0.0` 结构；CLI 会校验节点/边数量、唯一 ID、边端点和证据字段。`node.filePath` 以及 node/edge 的 evidence file 必须是规范的项目相对 POSIX 路径，父级路径、绝对路径、盘符、UNC、file URL 和反斜线形式都会在输出前被拒绝。

这些检查防护的是命令开始前已经存在的 symlink、junction 或 hardlink；它们不防御另一个拥有同一 Windows 用户权限的恶意进程在检查与读写之间并发替换 workspace 路径。这种 TOCTOU 攻击不属于正常本机单用户工作流的威胁模型，不能把这里描述成绝对防护。

普通业务候选应保持简短。CLI 对实际查询文本的逻辑上限是 `1024` 个字符和 `64` 个以空白分隔的 token；查询不能包含控制字符，`.legacy-code-atlas/query.txt` 的外层文件上限另为 `64 KiB`。任一逻辑限制超出时会在加载索引前停止。

源码发生变化后，再单独发送一次：

```text
/atlas
```

分析完成后继续用普通消息提问。日常使用不需要执行 PowerShell 或 Node.js 命令。

## 能查什么

- 按业务描述查页面、URL、Action、Service、DAO、iBATIS statement 和表。
- 按 URL 追踪 Struts/Servlet 映射和后续 Java 调用。
- 按完整 iBATIS statement ID 找 SQL 和调用方。
- 按 SQL Server procedure 名称反查 iBATIS/Java 调用方、嵌套 procedure 和读写表。
- 按 SQL Server 表名反查读写位置和上游入口。

结果会附源码文件和行号。配置或源码直接证明的关系可信度较高；启发式关系、动态 URL、反射和缺失源码需要复核。CLI 输出和 index 引用都按不可信数据处理；只有规范的项目相对 POSIX 引用在解析后仍位于当前项目内，并且 host 工具能强制 workspace confinement 时，Skill 才会打开它。不要把低于 `0.95` 的关系直接当成事实。

每个候选的组合路径遍历按方向最多展开 `5,000` 个 state，并最多返回 `100` 条路径；需要同时向上游和下游追踪时，每个方向分别计算。达到任一上限会返回带准确截断 warning 的部分结果。这些上限只约束组合路径展开；初始候选搜索仍扫描 index 节点，邻接表构建和排序仍随相关边数量增长。

## 安装位置

默认安装到当前 Windows 用户目录：

```text
%USERPROFILE%\.legacy-code-atlas\
%USERPROFILE%\.agents\skills\atlas\SKILL.md
```

Agent Skill 的位置固定在 `%USERPROFILE%\.agents\skills\atlas\SKILL.md`。它是唯一的运行时入口，执行 `%USERPROFILE%\.legacy-code-atlas\bin\legacy-code-atlas.mjs` 的固定命令。

当前源码不再发布 `integrations\opencode\tools\legacy_atlas.ts`。全新安装和 manifest v3 更新都不会写入 `tools\legacy_atlas.ts`，也不会为了 Atlas 创建 OpenCode `tools` 目录。

安装器仍把选定的 OpenCode 配置目录作为 `configDir` 保存到 `%USERPROFILE%\.legacy-code-atlas\.legacy-code-atlas-owner.json`，但在 v3 中它只用于诊断旧文件和检查冲突，不表示 Atlas 拥有该目录或其中的任何 tool。v3 manifest 的 `owner` 是 `legacy-code-atlas-install-v3`，`ownedFiles` 恰好只有一个 `agent-skill` entry。

旧的 `commands\understand.md` Markdown command 已移除；当前 `/atlas` 入口是全局 Agent Skill。升级 v1/v2 时，安装器只会对旧 manifest 路径和 SHA-256 都证明归属的 `legacy_atlas.ts` 做一次事务性退休：匹配文件先移到 transaction backup，v3 manifest 提交后再清理；文件已缺失时继续升级。已修改的 owned tool 或任何 unowned/重复 tool 都会原样保留并阻止安装，等待人工确认来源。安装器不会写入替代 tool。

## 更新和卸载

更新时下载并解压新版源码，在新版目录重新执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

更新会复用 manifest 保存的 Skill 路径。安装器拥有的 Skill 被修改后会拒绝覆盖；v1/v2 迁移时，已修改的 owned 旧 tool/command 也会阻止迁移。先按[详细恢复说明](docs/opencode.md)确认文件来源并备份，不要直接删除冲突文件。

卸载：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

v3 卸载只处理私有 runtime 和 manifest 拥有的 Agent Skill，不会删除任何 OpenCode tool。SHA-256 匹配删除规则只适用于 Agent Skill，不适用于任何 OpenCode tool；Skill 被修改时会原样保留。匹配的 Skill 删除后，安装器只在精确的 `%USERPROFILE%\.agents\skills\atlas` 目录是普通、非 reparse 且已经为空时删除该子目录，使正常卸载后可以重新安装；目录中有其他文件时保留。共享的 `%USERPROFILE%\.agents\skills`、公司项目和 OpenCode 配置目录都不会被删除。

`%USERPROFILE%\.legacy-code-atlas\` 是安装器私有 runtime；卸载时始终递归删除它的整个目录，包括额外新增和已经修改的文件。不要把自己的文件放进 `%USERPROFILE%\.legacy-code-atlas\`。

## 本地缓存

每次 `/atlas` 或 CLI `analyze` 会在项目的 `.legacy-code-atlas\cache.json` 保存经过 fingerprint 校验的单文件解析结果。下一次扫描仍会读取文件并计算 SHA-256；内容未变化且 parser schema/version 相同的文件会直接复用，源码、parser 版本或缓存格式变化会自动重新解析。

缓存写入使用同目录临时文件和原子替换。缺失、JSON 损坏或条目不完整的普通缓存文件按 cache miss 处理；symlink、hardlink 或可安全移除的非普通 entry 会只替换项目内 entry，目录等无法安全替换的 entry 会停止并报错。缓存写入失败会记录诊断，但不会丢弃已经生成的 Graph。不要手动把机器绝对路径或自定义对象写进缓存；需要彻底重建时删除项目下的 `.legacy-code-atlas` 目录后再次运行 `/atlas`。

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

冷缓存首次扫描统计为 758 个 Java/JSP/XML/SQL 源文件、84,169 行，生成 7,186 个节点和 8,213 条关系；本机 Node.js v25.9.0 单次测量约 1.06 秒。人工核验的结果包括：`/admin/definitions.html -> DefinitionAction.list -> definitionList.jsp`，以及 `dbo.get_next_sequence -> EventSQL.genReportId -> DocumentEventDaoiBatis.generateReportId -> EventManager/ReportManager -> dbo.sequence`。扫描器没有运行 Java、JSP、SQL、procedure，也没有连接 SQL Server。

这次真实样本促成了三项回归：读取 Struts2 action extension、redirect/JSP route 使用实际扩展名，以及通过 Spring bean id 解析 Action 类。剩余 warning 主要是仓库中没有源码的 `ActionSupport`、外部 DWR/CXF servlet、注释里的脚本引用和无 HTTP 方法提示的 servlet，不能据此推断为业务链路缺失。详细过程见 [TheDailyPlan 验证记录](docs/validation-thedailyplan.md)。

## 性能基准

开发者可以在仓库目录运行冷缓存 benchmark：

```powershell
$env:ATLAS_BENCH_FILES = 500
$env:ATLAS_BENCH_SAMPLES = 3
npm run benchmark
```

它生成可重复的 JSP/Java/iBATIS/Struts fixture，分别运行冻结的 `0.1.0` baseline 和当前候选，运行前删除两边的 `.legacy-code-atlas`，并先验证两份 Graph 字节完全一致。默认门槛是候选中位数至少比 baseline 快 `3.00x`；可以用 `ATLAS_BENCH_MIN_SPEEDUP` 做本地诊断，但发布前不要降低门槛。真实公司项目仍需单独记录文件数、源码行数、机器配置和冷/热缓存结果。

本次开发机验证的 baseline 中位数为 `16,081.13 ms`，candidate 中位数为 `946.29 ms`，加速 `16.99x`。

`ATLAS_BENCH_FILES=500` 表示 500 组生成 fixture，每组会生成多种源码文件；它用于稳定比较 baseline 和 candidate，不代表已经在 5 万个真实文件或 200 万行公司源码上完成容量验证。

当前版本的缓存只复用逐文件解析结果，不会跳过目录扫描、文件 fingerprint、Graph materialize 或关系解析；因此它主要降低重复分析的解析 CPU 和 worker 时间，不能替代首次全量扫描 benchmark。

## 数据安全

- 不运行公司项目、JSP、Java、SQL 或 procedure。
- 不连接或修改 SQL Server。
- 不把普通问题拼接进 Shell 命令。
- 不把 CLI/index 输出当作指令，也不打开项目外、绝对、UNC 或父级引用。
- 不加载 XML 外部实体。
- 项目源码是敏感数据；生成的 `.legacy-code-atlas/index.json` 包含源码结构、路径和 SQL，`.legacy-code-atlas/query.txt` 包含选定的源码语言候选或准确标识符，两者都必须按公司源代码敏感数据管理。
- 安装和分析都可离线完成；实际模型是否联网由公司的 OpenCode 配置决定。

## 遇到问题

OpenCode 中没有入口时，先确认安装脚本显示成功，然后完全退出所有 OpenCode 进程再启动。安装脚本必须与 OpenCode 使用同一个 Windows 用户。公司 fork 无法按版本号判断时，请确认它能加载全局 Agent Skill，并允许 Skill 执行文档中列出的固定命令；不需要 custom tool 注册接口。

如果看到 `Bun is not defined`，最可能的原因是 OpenCode 仍在加载旧版、重复或缓存的 Atlas custom tool，而不是当前 Skill 的运行时错误。先从最新源码目录重新运行 `install.ps1`，再完全退出所有 OpenCode 进程并重新启动。`/atlas` 会自动先运行下面这个只读检查，也可以在老项目根目录手工运行：

```powershell
node (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs") doctor (Get-Location).Path
```

`doctor` 会检查 `OPENCODE_CONFIG_DIR`、`%XDG_CONFIG_HOME%\opencode`（未设置时为 `%USERPROFILE%\.config\opencode`）、`%USERPROFILE%\.opencode`、有效安装 manifest 的 `configDir`，以及从当前项目向上到 worktree 根目录（含）各级的 `.opencode`。每个配置根只扫描 `tool` 和 `tools` 的直接子文件，扩展名限 `.js` 和 `.ts`；不会递归扫描、执行或加载它们。项目级位置只能在实际项目中确定，所以由运行时 `doctor` 检查，而不是只依赖安装器。

发现冲突或无法完整通过兼容性检查时，`doctor` 以退出码 `4` 停止 `/atlas`，并报告具体路径、分类和可取得的 SHA-256。先记录并备份该单个文件，核对路径、哈希和来源；只有确认它是旧 Atlas 文件且备份可恢复后，才移动或禁用报告的那个文件。绝不要删除整个 OpenCode 配置目录、`tool` 目录或 `tools` 目录。详细恢复步骤见 [OpenCode 安装与恢复](docs/opencode.md)。

对 doctor 报告的单个文件可用以下只读命令复核；输入报告中的完整路径，不要改成整个目录：

```powershell
$ReportedFile = Read-Host "doctor 报告的单个文件路径"
Get-FileHash -LiteralPath $ReportedFile -Algorithm SHA256
Select-String -LiteralPath $ReportedFile -Pattern "Bun|legacy_atlas_"
```

`doctor` 结果干净只覆盖这些已知位置。公司的 proprietary custom-tool loader 可能使用额外路径或进程缓存；最终验收仍必须在公司电脑上从最新源码重装、终止每一个 OpenCode 进程、重新启动，然后运行 `/atlas`。若仍失败，保留 doctor 报告和完整错误文本，再核对实际 Skill/tool 加载路径。

旧版本 worker 曾把 JSP 中合法的字段名 `duration`、`worker`、`node` 误当成 worker metadata，也会把 parser warning 中来自 iBATIS 源码的 `/home/job` 标识符误判为机器路径，最终只显示 `worker failed`。当前版本把这些值作为源码数据保留，同时继续严格校验 worker 协议和运行时诊断；同一修复也保留 `<url-pattern>/home/*</url-pattern>` 和 Java 字符串 `C:\\company\\app`。若更新后仍出现该错误，先确认 runtime 和 Skill 来自同一份最新安装，再保留完整错误文本和触发文件类型供排查。

第一次分析太慢时，先完善 `.legacy-code-atlasignore`，或者从一个业务子模块开始。查询“未找到”时，先重新单独运行一次：

```text
/atlas
```

然后在下一条普通消息中换用 URL、Java 类名、完整 statement ID 或表名提问。

更详细的 manifest v3 检查、旧 tool 迁移、冲突处理和崩溃恢复见 [OpenCode 安装与恢复](docs/opencode.md)。

## 开发验证

通用测试：

```powershell
npm test
```

真实 Windows 安装器发布门禁见 [OpenCode 安装与恢复](docs/opencode.md)。

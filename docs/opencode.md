# OpenCode 安装与恢复

[English](opencode-en.md) | 简体中文

Legacy Code Atlas 不直接调用模型。OpenCode 是对话层并继续使用公司的模型；Atlas 的 Agent Skill 在分析后把普通问题路由给本地自定义工具。

官方 OpenCode 1.14.49 或更高版本提供所需接口。公司 fork 不必有相同版本号，但必须能加载用户级 Agent Skill，并支持使用 plain JSON Schema 参数的自定义工具。

## Windows 安装

要求 Windows PowerShell 5.1 和 Node.js 20 或更高版本。下载并解压源码后，在 `legacy-code-atlas` 目录执行：

```powershell
node --version
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装器不需要管理员权限、不联网，也不运行 `npm install`。完成后完全关闭 OpenCode，再进入老项目目录重新启动。

第一条消息必须是单独的无参数命令：

```text
/understand
```

等待 `legacy_atlas_analyze` 完成。下一条普通消息再发送业务描述、URL、iBATIS statement ID、SQL Server procedure 或表名，例如：

```text
退款审核功能在哪里？
```

普通消息由 Agent Skill 路由到以下工具：

- 业务描述：`legacy_atlas_trace_feature`
- URL：`legacy_atlas_trace_url`
- iBATIS statement：`legacy_atlas_trace_statement`
- SQL Server procedure：`legacy_atlas_trace_procedure`
- 数据库表：`legacy_atlas_trace_table`

不要把问题追加到斜杠命令。源码变化后重新单独运行：

```text
/understand
```

分析完成后再发下一条普通消息。

## 安装器写入的位置

安装器复制无依赖 runtime、全局 Agent Skill 和 OpenCode tool：

```text
%USERPROFILE%\.legacy-code-atlas\
%USERPROFILE%\.agents\skills\understand\SKILL.md
%USERPROFILE%\.config\opencode\tools\legacy_atlas.ts
```

`%USERPROFILE%\.config\opencode` 是 tool 的默认配置目录。首次安装时如果存在 `OPENCODE_CONFIG_DIR`，tool 会改为写入 `%OPENCODE_CONFIG_DIR%\tools\legacy_atlas.ts`。选定目录会作为 `configDir` 保存到：

```text
%USERPROFILE%\.legacy-code-atlas\.legacy-code-atlas-owner.json
```

后续更新和卸载读取保存的 `configDir`；改变或清除 `OPENCODE_CONFIG_DIR` 不会迁移已安装文件。Agent Skill 始终位于 `%USERPROFILE%\.agents\skills\understand\SKILL.md`，不受该变量影响。

旧版 Markdown command `commands\understand.md` 已经移除。v1 安装会在下一次成功更新时自动迁移到 Agent Skill 和 manifest v2，不应继续把旧 command 当作当前入口。

## manifest v2

当前 ownership manifest 必须满足：

- `owner` 是 `legacy-code-atlas-install-v2`。
- `version` 是数字 `2`。
- `installDir` 是当前用户的 runtime 目录。
- `configDir` 是首次安装时保存的 OpenCode 配置目录。
- `ownedFiles` 恰好用 `kind`、`path`、`sha256` 记录 `agent-skill` 和 `opencode-tool`。

检查实际文件时按 `kind` 定位，不要依赖旧版恢复字段：

```powershell
$ManifestPath = Join-Path $HOME ".legacy-code-atlas\.legacy-code-atlas-owner.json"
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json

$Manifest.owner
$Manifest.version
$Manifest.configDir
$Manifest.ownedFiles | Format-Table kind, path, sha256

$Skill = $Manifest.ownedFiles | Where-Object { $_.kind -ceq "agent-skill" }
$Tool = $Manifest.ownedFiles | Where-Object { $_.kind -ceq "opencode-tool" }
Test-Path -LiteralPath $Skill.path
Test-Path -LiteralPath $Tool.path
Test-Path -LiteralPath (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs")
```

正常的 v2 manifest 会输出准确的 owner、version 和两个 owned file；最后三个 `Test-Path` 应为 `True`。还可以核对 SHA-256：

```powershell
(Get-FileHash -LiteralPath $Skill.path -Algorithm SHA256).Hash
$Skill.sha256
(Get-FileHash -LiteralPath $Tool.path -Algorithm SHA256).Hash
$Tool.sha256
```

Windows PowerShell 默认显示的大写哈希与 manifest 中的哈希可按不区分大小写比较。Node.js 和 runtime 可单独检查：

```powershell
node --version
node (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs") --help
```

Node.js 必须是 20 或更高版本。runtime 正常但 OpenCode 没有入口时，完全退出所有 OpenCode 进程，再确认 OpenCode 与安装脚本使用同一个 Windows 用户。

## 更新与已修改文件

下载并解压新版源码，在新目录重新运行安装脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

更新复用 manifest 保存的 `configDir`。如果任何 modified owned file 的实际 SHA-256 与 manifest 不同，安装器会拒绝更新，避免覆盖用户或公司修改。

发生冲突时：

1. 用上面的 `ownedFiles` 命令按 `kind` 找到实际 Skill 或 tool 路径。
2. 确认文件来源和当前用途，并在 Atlas 目录之外建立备份。
3. 如果它属于公司配置或另一个插件，不要移动或删除；保留现场并与 OpenCode 管理员解决命名空间冲突。
4. 只有确认它是旧 Atlas 文件且备份可恢复后，才处理该精确路径。可从原版本恢复与 manifest 哈希一致的内容后更新；也可以先运行卸载，让卸载器保留修改文件，再确认并备份后移除残留，最后重新安装。

不要直接删除、盲目清空 `%USERPROFILE%\.agents\skills\understand`、OpenCode `tools` 目录、ownership manifest 或整个 OpenCode 配置目录。

## 卸载

在任意一份已下载的 Atlas 源码目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

卸载要求有效的 ownership manifest。SHA-256 匹配才删除、修改后保留的规则，只适用于 runtime 之外的 Agent Skill 和 OpenCode tool。共享的 `.agents\skills` 和 OpenCode `tools` 目录不会被整体删除，公司项目也不会被删除。

`%USERPROFILE%\.legacy-code-atlas\` 是安装器私有 runtime；卸载时始终递归删除它的整个目录，包括额外新增和已经修改的文件。不要把自己的文件放进 `%USERPROFILE%\.legacy-code-atlas\`，也不要把该目录当作备份位置。

## 崩溃与事务恢复

安装开始后会先写事务 journal：

```text
%USERPROFILE%\.legacy-code-atlas.transaction.json
```

runtime、Skill、tool 和 manifest 都先进入 transaction stage，并在替换已有文件前创建带 transaction id 的 backup。ownership manifest 是提交标记。

如果 PowerShell 或电脑在安装中断，保留 journal、stage 和 backup。下一次运行 `install.ps1` 时，恢复逻辑会在读取 ownership manifest 之前执行：

- 提交标记与 journal 的 manifest SHA-256 匹配时，安装已提交，恢复逻辑继续清理 stage、backup 和 journal。
- 提交标记不匹配时，安装未完成，恢复逻辑回滚到原 runtime、Skill、tool 和旧 command 状态。
- 如果中断后目标又被修改，恢复会拒绝覆盖或删除，并保留 journal 供排查。

此时不要手工删除 journal 或 transaction backup，也不要反复复制文件。先保存错误全文和这些路径的目录清单；确认文件来源后再恢复目标内容，或交给维护人员分析 journal。

## 路径安全与威胁边界

安装器会检查规范路径、ownership、SHA-256、reparse point 和事务恢复状态，并在关键替换前重新检查目标。这些检查用于防止普通误配置、链接跳转和覆盖未知文件。

Windows PowerShell 5.1 没有可供脚本可靠使用的 handle-relative 文件系统 API，因此安装器不能把每一步都绑定到预先打开的父目录句柄。能够以同一 Windows 账户权限恶意并发替换父目录的进程在当前威胁模型之外；不能宣称安装器绝对消除了所有 TOCTOU 窗口。发现这类风险时应停止安装并隔离该账户上的不可信进程。

## 真实 Windows 发布门禁

发布前必须在真实 Windows、内置 Windows PowerShell 5.1 环境执行：

```powershell
npm run test:installer:windows
```

只有结果为 `50 pass`、`0 skip` 才能通过发布门禁。非 Windows 系统会把真实安装场景标记为 skip，这只适合开发期语法检查，不能作为 Windows 门禁通过的证据。文档中的要求不代表某次发布已经实际执行并通过该命令。

## 大项目与敏感数据

目标项目少于 5 万个文件、200 万行源码时，先通过 `.legacy-code-atlasignore` 排除备份、生成物、依赖和二进制目录，并从熟悉模块验证已知链路。不要排除需要追踪的 Struts、iBATIS 和 procedure 源文件。

分析器离线读取源码，不运行 Java、JSP、SQL 或 procedure，也不连接 SQL Server。项目中的 `.legacy-code-atlas/index.json` 包含路径、符号、调用关系和 SQL 片段，与 source code 一样属于敏感数据，应只保存在公司批准的设备和存储中。

## 当前分析边界

- SQL Server procedure 支持 `CREATE/ALTER PROCEDURE`、嵌套 `EXEC`、读写表，以及 iBATIS `<procedure>` 和包含静态 `CALL/EXEC` 的通用 `<statement>` 调用关系；通用 `<statement>` 中的多条 DML 会合并读写表；可直接询问 procedure 名称；不连接数据库，也不执行 procedure。
- Struts 2 支持 namespace/action/method/result 到 Java 方法和 JSP 页面，并读取 `struts.action.extension`；`redirectAction` 和 JSP Struts2 标签会沿用实际扩展名，唯一的无 namespace action 名会对齐到已知 route。
- Struts 2 的 `class` 为 Spring bean id 时会通过 Spring bean class 解析到 Java Action；同名 bean、动态 action 和缺失源码仍需人工复核。
- Struts 1 Tiles forward 和 Tiles 跨 XML 文件继承会生成明确关系。
- Tiles 支持 definition 继承、template 和 put 页面关系。
- Java 调用会按当前文件/类型/方法解析成员字段、局部变量，以及当前类或父类中无参方法的返回类型；同名重载按规范化参数类型签名隔离（旧 facts 没有签名时回退到参数个数）。带参数的工厂调用、限定对象的多段调用链、反射和动态对象可能仍需人工复核。
- JSP 支持原生表单/链接以及常见 Struts 1 `html:*` rewrite/link/form、Struts 2 `s:*` form/link/url 标签；静态 `page`/`href` 和 URL 标签中的 `value` 会建路由，Struts `s:a value` 仅作为显示文本，动态 action、namespace、EL/OGNL 和 JavaScript 拼接 URL 不会建路由。
- 动态 URL、反射和缺失源码可能需要 OpenCode 用 `read`、`grep`、`glob` 检查 Atlas 引用的源码；动态 JSP URL 不应据此推断为具体 route。

不要在 OpenCode 消息中添加未记录的性能、缓存或增量扫描参数。缓存由 `/understand` 和 CLI 自动管理，位置是项目下的 `.legacy-code-atlas\cache.json`；需要评估真实项目时，记录项目文件数、代码行数、缓存命中数和人工计时即可。

# OpenCode 安装与恢复

[English](opencode-en.md) | 简体中文

Legacy Code Atlas 不直接调用模型。OpenCode 是对话层并继续使用公司的模型。OpenCode 集成采用与 Understand-Anything 相似的 Skill-only 架构：Atlas Agent Skill 直接执行安装好的 Node.js CLI，不调用或依赖 custom tool，也不需要 Bun。Understand-Anything 只能展示部分相似能力，不能证明公司 fork 已兼容 Atlas。

官方 OpenCode 1.14.49 或更高版本提供所需接口。公司 fork 不必有相同版本号，但必须能加载用户级 Agent Skill、提供 structured `write` 和 metadata-only 索引存在性检查，并允许 Skill 执行固定 Shell 命令。文档没有宣称未知的公司 fork 已经验证通过；最终仍要在公司电脑重装、彻底重启并核验已知链路。

现场验收还必须确认公司 fork 提供 PowerShell 兼容或 POSIX/Git Bash Shell 语义，能展开 `$HOME` 和 `$PWD`，并提供 structured `write`；仅提供 cmd.exe 的 host 不支持。Understand-Anything 在同一客户端可运行，只能证明相似的 Shell 能力，不能替代 Atlas 的完整验收。

第一次全量扫描必须请求 host 最长可支持的 timeout。如果前台上限仍不足且 host 支持 background execution，Skill 必须在后台启动后等待 `analyze` 完成；不能依赖短的默认 timeout，也不能为未知公司 fork 臆造工具参数。

## Windows 安装

Understand-Anything 通常也安装 `%USERPROFILE%\.agents\skills\understand\SKILL.md`。该路径只能有一个 `/understand` Skill；Atlas 安装器会拒绝覆盖不属于自己的现有目录。若它仍存在，先按 Understand-Anything 自己的卸载或禁用流程备份并释放该命名空间，再运行 Atlas 安装器。不要手工删除来源不明的 Skill 目录。

要求 Windows PowerShell 5.1 和 Node.js 20 或更高版本。下载并解压源码后，在 `legacy-code-atlas` 目录执行：

```powershell
node --version
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

安装器不需要管理员权限、不联网，也不运行 `npm install`。完成后必须完全退出所有 OpenCode 进程，再进入老项目目录重新启动；只关闭窗口可能继续使用旧的 Skill/tool 缓存。

第一条消息必须是单独的无参数命令：

```text
/understand
```

Skill 会用三个独立 Shell 调用依次运行以下固定命令。`doctor` 是只读的 OpenCode 兼容性预检；只有它以状态 `0` 结束后才运行 `analyze`，只有 `analyze` 成功后才运行 `overview`。任一步失败都会停止，不会把旧索引说成刷新成功。命令不会添加用户提供的文字、路径或额外 flag：

```sh
node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" doctor "$PWD"
node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" analyze "$PWD"
node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" overview "$PWD"
```

`doctor` 不导入、执行、移动或删除任何 OpenCode tool，也不修改项目；它只扫描有数量上限的目录并读取受限大小的候选文件。发现冲突或无法完整通过兼容性检查时返回退出码 `4`，Skill 会停止。worker threads 不可用只会是 warning，因为 analyzer 可以回退到主线程。

等待分析完成。下一条普通消息再发送业务描述、URL、iBATIS statement ID、SQL Server procedure 或表名，例如：

```text
退款审核功能在哪里？
```

普通消息由 Agent Skill 按以下数据流处理：

1. 先用 metadata-only existence check 检查 `.legacy-code-atlas/index.json`，不读取索引内容；缺失时要求用户单独运行 `/understand` 并停止。
2. URL、statement ID、procedure 和表名保留准确的源码标识符；普通业务问句由公司模型提取一个简短的源码语言候选，并把问题中的业务词翻译成项目使用的源码语言。
3. 在每次 structured write 前运行固定预检 `node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" prepare-query "$PWD"`；失败时停止。
4. 用 OpenCode host 的 structured `write` 把选定的源码语言候选或准确标识符写到当前项目的 `.legacy-code-atlas/query.txt`。
5. 按问题类型选择一个固定 CLI 命令：业务描述使用 `trace-feature`，URL 使用 `trace-url`，iBATIS statement 使用 `trace-statement`，SQL Server procedure 使用 `trace-procedure`，数据库表使用 `trace-table`。
6. 固定命令只通过 `--query-file "$PWD/.legacy-code-atlas/query.txt" --no-match-ok` 读取候选；不把问题文本或候选插入 Shell、命令参数或 Shell 变量。

只有自然语言候选没有匹配时，Skill 才会最多再生成两个简短候选，逐个运行并报告实际尝试过的候选。明确的 URL、statement ID、表名或 procedure 名无匹配时不会被翻译或替换。

`--no-match-ok` 只把合法无匹配的退出码 `3` 改为 `0`，让上述有限回退继续；输出内容不变，无效查询、索引、文件和 runtime 错误仍会失败。

`query.txt` 必须是项目 `.legacy-code-atlas` 目录中的 UTF-8 普通文件，非空、不含控制字符，外层文件最大 `64 KiB`。其中的逻辑查询另有 `1024` 个字符和 `64` 个以空白分隔的 token 上限；普通业务候选应保持简短，超出逻辑上限会在加载索引前停止。这个文件只保存源码语言候选或准确标识符，由 Skill 自动维护，用户不需要手工创建。CLI 还会拒绝目录外路径、同时提供 positional query，以及不符合上述限制的文件。

静态 artifact 防护会拒绝 symlink/junction 形式的 `.legacy-code-atlas` 目录，以及 symlink、junction 或 hardlink 形式的标准 `index.json`。`prepare-query` 只移除项目内预先存在的 linked `query.txt` entry，再原子写入新的普通文件；`analyze` 同样忽略 linked `cache.json` 内容，把它当作 cache miss，并只替换项目内 entry。外部 target 不会被读取或改写。

从磁盘加载的 Graph index 最大为 `512 MiB`，必须是有效 UTF-8 和 `1.0.0` 结构。CLI 会校验数量、唯一 ID、边端点和 evidence；所有 `node.filePath` 与 node/edge evidence file 必须是规范的项目相对 POSIX 路径。CLI/index 输出按不可信数据处理；只有引用解析后仍在 `$PWD` 内且 host 工具强制 workspace confinement 时，Skill 才能用 `read`、`grep` 或 `glob` 打开它。

这些防护只覆盖命令开始前已经存在的 symlink、junction 或 hardlink。它们不防御另一个拥有同一 Windows 用户权限的恶意进程在检查与读写之间并发替换 workspace 路径；这种 TOCTOU 攻击在正常本机单用户工作流威胁模型之外，不能据此宣称绝对消除了路径竞争。

每个查询候选的组合路径遍历按方向最多展开 `5,000` 个 state、返回 `100` 条路径；同时追踪上游和下游时，每个方向分别应用上限。达到任一上限会产生准确的截断 warning 并返回部分结果。这只限制组合路径展开；初始搜索仍扫描 index 节点，邻接构建和排序仍随相关边数量增长。

不要把问题追加到斜杠命令。源码变化后重新单独运行：

```text
/understand
```

分析完成后再发下一条普通消息。

## 安装器写入的位置

安装器只复制无依赖 runtime 和全局 Agent Skill：

```text
%USERPROFILE%\.legacy-code-atlas\
%USERPROFILE%\.agents\skills\understand\SKILL.md
```

Agent Skill 是唯一的运行时入口。当前仓库不再发布 `integrations\opencode\tools\legacy_atlas.ts`；全新安装和 manifest v3 更新不会写入 `tools\legacy_atlas.ts`，也不会为 Atlas 创建 OpenCode `tools` 目录。

安装时选定的 OpenCode 配置目录仍会作为 `configDir` 保存到：

```text
%USERPROFILE%\.legacy-code-atlas\.legacy-code-atlas-owner.json
```

在 v3 中，`configDir` 只用于诊断旧文件和检查已知候选配置的冲突，不表示 Atlas 拥有该目录或其中的任何 tool。Agent Skill 始终位于 `%USERPROFILE%\.agents\skills\understand\SKILL.md`，不受该变量影响。

旧版 Markdown command `commands\understand.md` 已经移除。v1/v2 安装升级到 v3 时，只会退休旧 manifest 用精确路径和 SHA-256 证明归属的 `legacy_atlas.ts`；不会写入任何替代 tool。owned 旧 tool 已缺失时继续迁移；已修改的 owned tool，或 manifest 不拥有的重复 tool，会被原样保留并阻止安装，等待人工确认来源。v1 owned command 采用相同的哈希保护。

## manifest v3

当前 ownership manifest 必须满足：

- `owner` 是 `legacy-code-atlas-install-v3`。
- `version` 是数字 `3`。
- `installDir` 是当前用户的 runtime 目录。
- `configDir` 是诊断用的 OpenCode 配置目录，不是 ownership 声明。
- `ownedFiles` 恰好只有一个带 `kind`、`path`、`sha256` 的 `agent-skill`；v3 不包含任何 tool ownership entry。

检查实际文件时按 `kind` 定位，不要依赖旧版恢复字段：

```powershell
$ManifestPath = Join-Path $HOME ".legacy-code-atlas\.legacy-code-atlas-owner.json"
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json

$Manifest.owner
$Manifest.version
$Manifest.configDir
$Manifest.ownedFiles | Format-Table kind, path, sha256

$Skill = $Manifest.ownedFiles | Where-Object { $_.kind -ceq "agent-skill" }
Test-Path -LiteralPath $Skill.path
Test-Path -LiteralPath (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs")
```

正常的 v3 manifest 会输出准确的 owner、version 和唯一的 `agent-skill` entry；最后两个 `Test-Path` 应为 `True`。还可以核对 Skill 的 SHA-256：

```powershell
(Get-FileHash -LiteralPath $Skill.path -Algorithm SHA256).Hash
$Skill.sha256
```

Windows PowerShell 默认显示的大写哈希与 manifest 中的哈希可按不区分大小写比较。Node.js 和 runtime 可单独检查：

```powershell
node --version
node (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs") --help
```

Node.js 必须是 20 或更高版本。runtime 正常但 OpenCode 没有入口时，完全退出所有 OpenCode 进程，再确认 OpenCode 与安装脚本使用同一个 Windows 用户。

## 兼容性 doctor 与恢复

可以在老项目根目录手工运行同一个只读检查：

```powershell
node (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs") doctor (Get-Location).Path
```

`doctor` 检查以下配置根：

- `OPENCODE_CONFIG_DIR`（如果设置）。
- `%XDG_CONFIG_HOME%\opencode`；未设置时为 `%USERPROFILE%\.config\opencode`。
- `%USERPROFILE%\.opencode`。
- 有效 `%USERPROFILE%\.legacy-code-atlas\.legacy-code-atlas-owner.json` manifest 中的 `configDir`。
- 从当前项目目录向上到检测到的 worktree 根目录（含）每一级的 `.opencode`。安装器不知道未来会在哪个项目运行，因此这些项目级位置只能由运行时 `doctor` 检查。

每个配置根只检查 `tool` 和 `tools` 目录的直接子文件，扩展名限 `.js` 和 `.ts`；不递归进入子目录，不导入或执行候选文件。报告为冲突的文件会包含单个路径、分类和可取得的 SHA-256。退出码 `0` 表示没有冲突且检查完整；退出码 `4` 表示发现冲突或检查不完整/被阻断。`--json` 可用于保存机器可读报告。

恢复时先把报告中的单个文件备份到 Atlas runtime 之外，核对完整路径、SHA-256 和来源。只有确认它是旧 Atlas 文件且备份可以恢复后，才移动或禁用这个确切文件；哈希不可取得时也必须保留路径和现场，先确认来源。不要删除整个 OpenCode 配置目录、`tool` 目录或 `tools` 目录，也不要清空其中其他公司的配置或插件。

可以用以下只读命令核对报告中的单个文件；必须输入报告的完整文件路径，不能输入目录：

```powershell
$ReportedFile = Read-Host "doctor 报告的单个文件路径"
Get-FileHash -LiteralPath $ReportedFile -Algorithm SHA256
Select-String -LiteralPath $ReportedFile -Pattern "Bun|legacy_atlas_"
```

本地 `doctor` 只覆盖上面的已知路径，不能证明 proprietary company fork 没有额外 loader 路径或进程缓存。最终验收必须在公司电脑上从最新源码重装，终止每一个 OpenCode 进程，重新启动并运行 `/understand`；仍有问题时保留 doctor 报告和完整错误文本。

## `Bun is not defined` 排查

当前 Skill 和 runtime 都不引用 Bun，安装器也不再发布 custom tool。因此出现 `Bun is not defined` 时，最可能是 OpenCode 还在读取旧版、缓存或重复的 `legacy_atlas.ts`。按以下顺序排查：

1. 从最新 Atlas 源码目录重新运行 `install.ps1`。v1/v2 manifest 用精确路径和匹配哈希证明归属的旧 tool 会事务性退休；已修改或不属于 manifest 的文件会原样保留并阻止安装。
2. 安装成功后完全退出所有 OpenCode 进程再启动；只关闭窗口不足以清除所有缓存。
3. 在老项目根目录运行上面的 `doctor`，按报告逐个备份和核对文件；不要盲目删除目录。
4. 如果已知位置没有冲突但错误仍存在，检查公司 fork 的实际 loader 路径、进程缓存和 proprietary custom-tool loader 是否仍假定 Bun。

还可以在老项目根目录直接验证 Node runtime，借此区分 analyzer 问题和 OpenCode Skill/缓存问题：

```powershell
node (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs") doctor (Get-Location).Path
node (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs") analyze (Get-Location).Path
node (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs") overview (Get-Location).Path
```

只有 `doctor` 返回 `0` 后才继续手工运行 `analyze` 和 `overview`。直接 CLI 成功但 OpenCode Skill 仍失败时，继续检查 OpenCode Shell 是否按 Windows PowerShell 兼容语义展开 `$HOME` 和 `$PWD`，Skill 实际加载路径、Skill 缓存和 `configDir` 是否一致，以及 host 是否同时提供 structured `write` 和对 `.legacy-code-atlas/index.json` 的 metadata-only existence check。还要确认 OpenCode 与安装器使用同一 Windows 账户。

## `worker failed` 与源码路径

旧版本 worker 曾把 JSP 中合法的字段名 `duration`、`worker`、`node` 误当成 worker metadata，也把 parser warning 中来自 iBATIS 源码的 `/home/job` 标识符误判为机器路径，导致 `worker failed`。

当前版本把这些值作为源码数据保留，同时继续严格校验 worker 协议、运行时诊断和序列化错误；同一修复也保留 `<url-pattern>/home/*</url-pattern>` 和 Java 字符串 `C:\\company\\app`。修复不会降低 JSP/Struts/iBATIS/procedure 静态分析精度。如果更新后仍遇到 `worker failed`，先用上面的 direct CLI 复现，并记录完整 stdout/stderr、项目根目录和触发文件类型；不要执行项目代码或连接 SQL Server。

## 更新与已修改文件

下载并解压新版源码，在新目录重新运行安装脚本：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

v3 更新只替换私有 runtime 和 manifest-owned Skill，不创建或写入 OpenCode `tools` 目录。Skill 的实际 SHA-256 与 manifest 不同时，安装器会拒绝更新，避免覆盖用户或公司修改。

从 v1/v2 迁移时，安装器在写 journal 前校验 owned 旧 tool（以及 v1 command）。匹配的旧文件先移到 transaction backup，v3 manifest 提交后才清理；已缺失时继续迁移。任何已修改的 owned file，或任一已知候选配置中的 unowned 同名文件，都会被原样保留，安装器在改变状态前停止。

发生冲突时：

1. 对 v3 Skill，用上面的 `ownedFiles` 命令找到准确路径；对旧 tool/command，使用安装器错误中报告的准确路径。
2. 确认文件来源和当前用途，并在 Atlas 目录之外建立备份。
3. 如果它属于公司配置或另一个插件，不要移动或删除；保留现场并与 OpenCode 管理员解决命名空间冲突。
4. 只有确认它是旧 Atlas 文件且备份可恢复后，才处理该精确路径。可从原版本恢复与 manifest 哈希一致的内容后更新；也可以先运行卸载，让卸载器保留修改文件，再确认并备份后移除残留，最后重新安装。

不要直接删除、盲目清空 `%USERPROFILE%\.agents\skills\understand`、OpenCode `tools` 目录、ownership manifest 或整个 OpenCode 配置目录。

## 卸载

在任意一份已下载的 Atlas 源码目录执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

卸载要求有效的 ownership manifest。v3 卸载只处理私有 runtime 和唯一 owned Agent Skill，绝不删除 OpenCode tool。SHA-256 匹配删除规则只适用于 Agent Skill，不适用于任何 OpenCode tool；Skill 已修改时保留。删除匹配 Skill 后，只在精确的 `%USERPROFILE%\.agents\skills\understand` 是普通、非 reparse 且已经为空时删除该子目录；目录中有其他文件时保留。这样正常的 install -> uninstall -> reinstall 可以成功，同时共享的 `.agents\skills` 始终保留。旧 v1/v2 manifest 的 external file 仍遵守“哈希匹配才删除、修改后保留”。公司项目和 OpenCode 配置目录不会被删除。

`%USERPROFILE%\.legacy-code-atlas\` 是安装器私有 runtime；卸载时始终递归删除它的整个目录，包括额外新增和已经修改的文件。不要把自己的文件放进 `%USERPROFILE%\.legacy-code-atlas\`，也不要把该目录当作备份位置。

## 崩溃与事务恢复

安装开始后会先写事务 journal：

```text
%USERPROFILE%\.legacy-code-atlas.transaction.json
```

runtime、Skill 和 v3 manifest 都先进入 transaction stage，并在替换已有文件前创建带 transaction id 的 backup。v1/v2 迁移还会把哈希匹配的 owned 旧 tool（以及 v1 command）移动到 transaction backup。ownership manifest 是提交标记。

如果 PowerShell 或电脑在安装中断，保留 journal、stage 和 backup。下一次运行 `install.ps1` 时，恢复逻辑会在读取 ownership manifest 之前执行：

- 提交标记与 journal 的 manifest SHA-256 匹配时，安装已提交，恢复逻辑继续清理 stage、backup 和 journal。
- 提交标记不匹配时，安装未完成，恢复逻辑回滚到原 runtime、Skill、旧 tool 和旧 command 状态。
- v3 提交标记已经匹配时，恢复逻辑保持旧 tool 缺失并完成 backup 清理，不会重新发布 tool。
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

当前套件共 70 项。只有结果为 `70 pass`、`0 skip` 才能通过发布门禁。非 Windows 系统会把真实安装场景标记为 skip，这只适合开发期语法检查，不能作为 Windows 门禁通过的证据。文档中的要求不代表某次发布已经实际执行并通过该命令。

## 大项目与敏感数据

目标项目少于 5 万个文件、200 万行源码时，先通过 `.legacy-code-atlasignore` 排除备份、生成物、依赖和二进制目录，并从熟悉模块验证已知链路。不要排除需要追踪的 Struts、iBATIS 和 procedure 源文件。

分析器离线读取源码，不运行 Java、JSP、SQL 或 procedure，也不连接 SQL Server。项目中的 `.legacy-code-atlas/index.json` 包含路径、符号、调用关系和 SQL 片段，`.legacy-code-atlas/query.txt` 只包含选定的源码语言候选或准确标识符；两者与 source code 一样属于敏感数据，应只保存在公司批准的设备和存储中。

## 当前分析边界

- SQL Server procedure 支持 `CREATE/ALTER PROCEDURE`、嵌套 `EXEC`、读写表，以及 iBATIS `<procedure>` 和包含静态 `CALL/EXEC` 的通用 `<statement>` 调用关系；通用 `<statement>` 中的多条 DML 会合并读写表；可直接询问 procedure 名称；不连接数据库，也不执行 procedure。
- Struts 2 支持 namespace/action/method/result 到 Java 方法和 JSP 页面，并读取 `struts.action.extension`；`redirectAction` 和 JSP Struts2 标签会沿用实际扩展名，唯一的无 namespace action 名会对齐到已知 route。
- Struts 2 的 `class` 为 Spring bean id 时会通过 Spring bean class 解析到 Java Action；同名 bean、动态 action 和缺失源码仍需人工复核。
- Struts 1 Tiles forward 和 Tiles 跨 XML 文件继承会生成明确关系。
- Tiles 支持 definition 继承、template 和 put 页面关系。
- Java 调用会按当前文件/类型/方法解析成员字段、局部变量，以及当前类或父类中无参方法的返回类型；同名重载按规范化参数类型签名隔离（旧 facts 没有签名时回退到参数个数）。带参数的工厂调用、限定对象的多段调用链、反射和动态对象可能仍需人工复核。
- JSP 支持原生表单/链接以及常见 Struts 1 `html:*` rewrite/link/form、Struts 2 `s:*` form/link/url 标签；静态 `page`/`href` 和 URL 标签中的 `value` 会建路由，Struts `s:a value` 仅作为显示文本，动态 action、namespace、EL/OGNL 和 JavaScript 拼接 URL 不会建路由。
- 动态 URL、反射和缺失源码可能需要 OpenCode 检查 Atlas 引用的源码；`read`、`grep`、`glob` 只能用于解析后仍在项目内的规范相对引用，动态 JSP URL 不应据此推断为具体 route。

不要在 OpenCode 消息中添加未记录的性能、缓存或增量扫描参数。缓存由 `/understand` 和 CLI 自动管理，位置是项目下的 `.legacy-code-atlas\cache.json`；需要评估真实项目时，记录项目文件数、代码行数、缓存命中数和人工计时即可。

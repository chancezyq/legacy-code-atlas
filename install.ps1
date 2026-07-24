[CmdletBinding()]
param(
    [switch]$Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8OutputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false
[Console]::OutputEncoding = $utf8OutputEncoding
$OutputEncoding = $utf8OutputEncoding

$OwnerValueV1 = "legacy-code-atlas-install-v1"
$OwnerValueV2 = "legacy-code-atlas-install-v2"
$OwnerValueV3 = "legacy-code-atlas-install-v3"
$LegacyTransactionOwnerValue = "legacy-code-atlas-transaction-v1"
$TransactionOwnerValue = "legacy-code-atlas-transaction-v2"
$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Join-Path $HOME ".legacy-code-atlas"
$OwnerMarker = Join-Path $InstallDir ".legacy-code-atlas-owner.json"
$TransactionJournal = Join-Path $HOME ".legacy-code-atlas.transaction.json"
$CliTarget = Join-Path $InstallDir "bin\legacy-code-atlas.mjs"
$SkillDir = Join-Path $HOME ".agents\skills\atlas"
$SkillTarget = Join-Path $SkillDir "SKILL.md"

function Get-CanonicalPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw "路径不能为空。"
    }

    $fullPath = [IO.Path]::GetFullPath($Path)
    $rootPath = [IO.Path]::GetPathRoot($fullPath)
    if ([StringComparer]::OrdinalIgnoreCase.Equals($fullPath, $rootPath)) {
        return $rootPath
    }

    return $fullPath.TrimEnd([char[]]@(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
    ))
}

function Test-SamePath([string]$Left, [string]$Right) {
    $leftFull = Get-CanonicalPath $Left
    $rightFull = Get-CanonicalPath $Right
    return [StringComparer]::OrdinalIgnoreCase.Equals($leftFull, $rightFull)
}

function Test-Sha256([string]$Hash) {
    return $Hash -match '^[0-9A-Fa-f]{64}$'
}

function Test-ExactIntegerValue {
    param(
        [object]$Value,
        [Parameter(Mandatory = $true)][decimal]$Expected
    )

    if ($null -eq $Value) { return $false }
    $integerTypes = @(
        [byte], [sbyte], [int16], [uint16],
        [int32], [uint32], [int64], [uint64]
    )
    if ($integerTypes -notcontains $Value.GetType()) { return $false }
    return [decimal]$Value -eq [decimal]$Expected
}

function Get-InstallManifest {
    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir ".legacy-code-atlas-owner.json"))) {
        return $null
    }

    try {
        $manifest = Get-Content -LiteralPath $OwnerMarker -Raw | ConvertFrom-Json
        $ownerProperty = $manifest.PSObject.Properties["owner"]
        $versionProperty = $manifest.PSObject.Properties["version"]
        if ($null -eq $ownerProperty -or $ownerProperty.Value -isnot [string] -or
            $null -eq $versionProperty) {
            return $null
        }
        $owner = [string]$ownerProperty.Value
        $version = $versionProperty.Value
        $manifestInstallDir = Get-CanonicalPath ([string]$manifest.installDir)
        if (-not (Test-SamePath $manifestInstallDir $InstallDir)) { return $null }

        $configDir = Get-CanonicalPath ([string]$manifest.configDir)
        $expectedToolTarget = Get-CanonicalPath (Join-Path $configDir "tools\legacy_atlas.ts")

        if ($owner -ceq $OwnerValueV1 -and
            (Test-ExactIntegerValue -Value $version -Expected 1)) {
            $commandTarget = Get-CanonicalPath ([string]$manifest.commandTarget)
            $toolTarget = Get-CanonicalPath ([string]$manifest.toolTarget)
            $commandHash = [string]$manifest.commandHash
            $toolHash = [string]$manifest.toolHash
            $expectedCommandTarget = Get-CanonicalPath (Join-Path $configDir "commands\understand.md")

            if (-not (Test-SamePath $commandTarget $expectedCommandTarget)) { return $null }
            if (-not (Test-SamePath $toolTarget $expectedToolTarget)) { return $null }
            if (-not (Test-Sha256 $commandHash)) { return $null }
            if (-not (Test-Sha256 $toolHash)) { return $null }

            return [pscustomobject]@{
                Version = 1
                ConfigDir = $configDir
                ExternalFiles = @(
                    [pscustomobject]@{
                        Kind = "legacy-command"
                        Path = $expectedCommandTarget
                        Sha256 = $commandHash
                    },
                    [pscustomobject]@{
                        Kind = "opencode-tool"
                        Path = $expectedToolTarget
                        Sha256 = $toolHash
                    }
                )
            }
        }

        if ($owner -ceq $OwnerValueV2 -and
            (Test-ExactIntegerValue -Value $version -Expected 2)) {
            $ownedFiles = @($manifest.ownedFiles)
            if ($ownedFiles.Count -ne 2) { return $null }

            $seenKinds = @{}
            $normalizedFiles = @()
            foreach ($ownedFile in $ownedFiles) {
                $kind = [string]$ownedFile.kind
                $path = Get-CanonicalPath ([string]$ownedFile.path)
                $sha256 = [string]$ownedFile.sha256

                if ($kind -cne "agent-skill" -and $kind -cne "opencode-tool") { return $null }
                if ($seenKinds.ContainsKey($kind)) { return $null }
                if (-not (Test-Sha256 $sha256)) { return $null }

                $expectedPath = $null
                if ($kind -ceq "agent-skill") {
                    $expectedPath = Get-CanonicalPath $SkillTarget
                } else {
                    $expectedPath = $expectedToolTarget
                }
                if (-not (Test-SamePath $path $expectedPath)) { return $null }

                $seenKinds[$kind] = $true
                $normalizedFiles += [pscustomobject]@{
                    Kind = $kind
                    Path = $expectedPath
                    Sha256 = $sha256
                }
            }

            if (-not $seenKinds.ContainsKey("agent-skill")) { return $null }
            if (-not $seenKinds.ContainsKey("opencode-tool")) { return $null }

            return [pscustomobject]@{
                Version = 2
                ConfigDir = $configDir
                ExternalFiles = $normalizedFiles
            }
        }

        if ($owner -ceq $OwnerValueV3 -and
            (Test-ExactIntegerValue -Value $version -Expected 3)) {
            $ownedFiles = @($manifest.ownedFiles)
            if ($ownedFiles.Count -ne 1) { return $null }

            $ownedFile = $ownedFiles[0]
            $kind = [string]$ownedFile.kind
            $path = Get-CanonicalPath ([string]$ownedFile.path)
            $sha256 = [string]$ownedFile.sha256
            if ($kind -cne "agent-skill") { return $null }
            if (-not (Test-SamePath $path $SkillTarget)) { return $null }
            if (-not (Test-Sha256 $sha256)) { return $null }

            return [pscustomobject]@{
                Version = 3
                ConfigDir = $configDir
                ExternalFiles = @(
                    [pscustomobject]@{
                        Kind = "agent-skill"
                        Path = Get-CanonicalPath $SkillTarget
                        Sha256 = $sha256
                    }
                )
            }
        }

        return $null
    } catch {
        return $null
    }
}

function Get-ContentHash([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-Utf8Text([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "文件不存在或不是普通文件：$Path"
    }
    return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
}

function Assert-SkillCliProtocolContent([string]$Path) {
    $content = Get-Utf8Text $Path
    $requiredFragments = @(
        'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" doctor "$PWD"',
        'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" analyze "$PWD" --main-thread',
        'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" overview "$PWD"',
        'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" docs "$PWD"',
        'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" prepare-query "$PWD"',
        'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" trace-url "$PWD" --query-file "$PWD/.legacy-code-atlas/query.txt" --no-match-ok',
        'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" trace-statement "$PWD" --query-file "$PWD/.legacy-code-atlas/query.txt" --no-match-ok',
        'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" trace-table "$PWD" --query-file "$PWD/.legacy-code-atlas/query.txt" --no-match-ok',
        'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" trace-procedure "$PWD" --query-file "$PWD/.legacy-code-atlas/query.txt" --no-match-ok',
        'node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" trace-feature "$PWD" --query-file "$PWD/.legacy-code-atlas/query.txt" --no-match-ok'
    )
    foreach ($fragment in $requiredFragments) {
        if ($content.IndexOf($fragment, [StringComparison]::Ordinal) -lt 0) {
            throw "Agent Skill 缺少固定 Node CLI/query-file 协议：$fragment。文件：$Path"
        }
    }
    if ($content -match 'legacy_atlas_') {
        throw "Agent Skill 仍引用旧 custom tool，拒绝发布：$Path"
    }
}

function Assert-IntegrationSourceFiles {
    param(
        [Parameter(Mandatory = $true)][string]$SkillSource
    )

    Assert-SkillCliProtocolContent $SkillSource
}

function Assert-PublishedIntegrationFiles([psobject]$Transaction) {
    $skillHash = (Get-ContentHash $SkillTarget).ToUpperInvariant()
    if ($skillHash -ne $Transaction.SkillSha256.ToUpperInvariant()) {
        throw "已发布 Agent Skill SHA-256 校验失败，拒绝提交 ownership manifest：$SkillTarget"
    }
    Assert-SkillCliProtocolContent $SkillTarget
    if (($Transaction.Mode -ceq "upgrade-v1" -or $Transaction.Mode -ceq "upgrade-v2") -and
        $null -ne (Get-PathEntryWithoutFollowingTarget $Transaction.LegacyToolTarget)) {
        throw "legacy tool 仍存在，拒绝提交 v3 ownership manifest：$($Transaction.LegacyToolTarget)"
    }
    if ($Transaction.Mode -ceq "upgrade-v1" -and
        $null -ne (Get-PathEntryWithoutFollowingTarget $Transaction.LegacyCommandTarget)) {
        throw "legacy command 仍存在，拒绝提交 v3 ownership manifest：$($Transaction.LegacyCommandTarget)"
    }
}

function Get-Utf8BomContentHash {
    param([Parameter(Mandatory = $true)][string]$Content)

    $encoding = New-Object System.Text.UTF8Encoding -ArgumentList $true
    $preamble = $encoding.GetPreamble()
    $bytes = $encoding.GetBytes($Content)
    $stream = New-Object IO.MemoryStream
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $stream.Write($preamble, 0, $preamble.Length)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Position = 0
        $hashBytes = $sha256.ComputeHash($stream)
        return (-join @($hashBytes | ForEach-Object { $_.ToString("x2") })).ToUpperInvariant()
    } finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Assert-DirectoryOrMissing([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if (-not $item.PSIsContainer) {
        throw "目标目录路径已被文件占用，拒绝覆盖：$Path"
    }
}

function Get-PathEntryWithoutFollowingTarget([string]$Path) {
    $fullPath = Get-CanonicalPath $Path
    $rootPath = [IO.Path]::GetPathRoot($fullPath)
    if ([StringComparer]::OrdinalIgnoreCase.Equals($fullPath, $rootPath)) {
        try {
            return Get-Item -LiteralPath $rootPath -Force -ErrorAction Stop
        } catch [System.Management.Automation.ItemNotFoundException] {
            return $null
        } catch [IO.DirectoryNotFoundException] {
            return $null
        }
    }

    $parent = Split-Path -Parent $fullPath
    $leaf = Split-Path -Leaf $fullPath
    try {
        foreach ($entry in @(Get-ChildItem -LiteralPath $parent -Force -ErrorAction Stop)) {
            if ([StringComparer]::OrdinalIgnoreCase.Equals($entry.Name, $leaf)) {
                return $entry
            }
        }
    } catch [System.Management.Automation.ItemNotFoundException] {
        return $null
    } catch [IO.DirectoryNotFoundException] {
        return $null
    }
    return $null
}

function Assert-NoReparsePointInPath {
    param(
        [Parameter(Mandatory = $true)][string]$Boundary,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $boundaryFull = Get-CanonicalPath $Boundary
    $pathFull = Get-CanonicalPath $Path
    $prefix = $boundaryFull
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($boundaryFull, [IO.Path]::GetPathRoot($boundaryFull))) {
        $prefix += [IO.Path]::DirectorySeparatorChar
    }
    if (-not (Test-SamePath $pathFull $boundaryFull) -and
        -not $pathFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "路径越过安全边界，拒绝访问：$Path"
    }

    $current = $boundaryFull
    $components = @()
    if (-not (Test-SamePath $pathFull $boundaryFull)) {
        $relative = $pathFull.Substring($prefix.Length)
        $components = @($relative.Split([char[]]@(
            [IO.Path]::DirectorySeparatorChar,
            [IO.Path]::AltDirectorySeparatorChar
        ), [StringSplitOptions]::RemoveEmptyEntries))
    }

    $boundaryItem = Get-PathEntryWithoutFollowingTarget $current
    if ($null -eq $boundaryItem) { return }
    if ($boundaryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "拒绝访问包含重解析点 (reparse point) 的路径：$current"
    }
    foreach ($component in $components) {
        $current = Join-Path $current $component
        $item = Get-PathEntryWithoutFollowingTarget $current
        if ($null -eq $item) { break }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "拒绝访问包含重解析点 (reparse point) 的路径：$current"
        }
    }
}

function Assert-NoReparsePointTree([string]$Path) {
    $rootEntry = Get-PathEntryWithoutFollowingTarget $Path
    if ($null -eq $rootEntry) { return }

    $pending = New-Object System.Collections.Queue
    $pending.Enqueue($rootEntry)
    while ($pending.Count -gt 0) {
        $item = $pending.Dequeue()
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "目录树包含重解析点 (reparse point)，拒绝递归删除：$($item.FullName)"
        }
        if ($item.PSIsContainer) {
            foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) {
                if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    throw "目录树包含重解析点 (reparse point)，拒绝递归删除：$($child.FullName)"
                }
                if ($child.PSIsContainer) {
                    $pending.Enqueue($child)
                }
            }
        }
    }
}

function Remove-AtlasTree([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Assert-NoReparsePointTree $Path
    Remove-Item -LiteralPath $Path -Recurse -Force
}

function Assert-TargetPathsSafe {
    Assert-NoReparsePointInPath -Boundary (Get-CanonicalPath $HOME) -Path $InstallDir
    Assert-NoReparsePointInPath -Boundary (Get-CanonicalPath $HOME) -Path (Join-Path $InstallDir "bin")
    Assert-NoReparsePointInPath -Boundary (Get-CanonicalPath $HOME) -Path (Join-Path $InstallDir "src")
    Assert-NoReparsePointInPath -Boundary (Get-CanonicalPath $HOME) -Path (Join-Path $InstallDir "package.json")
    Assert-NoReparsePointInPath -Boundary (Get-CanonicalPath $HOME) -Path $SkillTarget
}

function Write-AtomicUtf8File {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $temporary = Join-Path $directory (".legacy-code-atlas-write-" + [Guid]::NewGuid().ToString("N") + ".tmp")
    $encoding = New-Object System.Text.UTF8Encoding -ArgumentList $true
    $preamble = $encoding.GetPreamble()
    $bytes = $encoding.GetBytes($Content)
    $stream = $null
    try {
        $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $stream.Write($preamble, 0, $preamble.Length)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }

    try {
        if (Test-Path -LiteralPath $Path) {
            [IO.File]::Replace($temporary, $Path, $null, $true)
        } else {
            Move-Item -LiteralPath $temporary -Destination $Path
        }
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

function Replace-TransactionFile {
    param(
        [Parameter(Mandatory = $true)][string]$Temporary,
        [Parameter(Mandatory = $true)][string]$Target,
        [string]$Backup,
        [Parameter(Mandatory = $true)][bool]$ExpectedExisted
    )

    $targetEntry = Get-PathEntryWithoutFollowingTarget $Target
    $targetExists = $null -ne $targetEntry
    if ($targetExists -ne $ExpectedExisted) {
        throw "目标存在状态在预检后已改变，拒绝覆盖：$Target"
    }
    if ($targetExists) {
        [IO.File]::Replace($Temporary, $Target, $Backup, $true)
    } else {
        Move-Item -LiteralPath $Temporary -Destination $Target
    }
}

function Get-LegacyTransactionPaths {
    param(
        [Parameter(Mandatory = $true)][string]$TransactionId,
        [Parameter(Mandatory = $true)][string]$ConfigDir
    )

    $configFull = Get-CanonicalPath $ConfigDir
    $toolTarget = Get-CanonicalPath (Join-Path $configFull "tools\legacy_atlas.ts")
    $legacyCommandTarget = Get-CanonicalPath (Join-Path $configFull "commands\understand.md")
    return [ordered]@{
        RuntimeStage = Get-CanonicalPath (Join-Path $HOME ".legacy-code-atlas.stage-$transactionId")
        RuntimeBackup = Get-CanonicalPath (Join-Path $HOME ".legacy-code-atlas.backup-$transactionId")
        SkillTemp = Get-CanonicalPath ($SkillDir + ".legacy-code-atlas-temp-$transactionId")
        SkillBackup = Get-CanonicalPath ($SkillTarget + ".legacy-code-atlas-backup-$transactionId")
        ToolTemp = Get-CanonicalPath ($toolTarget + ".legacy-code-atlas-temp-$transactionId")
        ToolBackup = Get-CanonicalPath ($toolTarget + ".legacy-code-atlas-backup-$transactionId")
        LegacyCommandBackup = Get-CanonicalPath ($legacyCommandTarget + ".legacy-code-atlas-backup-$transactionId")
        ManifestTemp = Get-CanonicalPath ($OwnerMarker + ".legacy-code-atlas-temp-$transactionId")
        ToolTarget = $toolTarget
        LegacyCommandTarget = $legacyCommandTarget
    }
}

function Get-LegacyInstallTransaction {
    if (-not (Test-Path -LiteralPath $TransactionJournal)) { return $null }

    try {
        $transaction = Get-Content -LiteralPath $TransactionJournal -Raw | ConvertFrom-Json
        $requiredProperties = @(
            "owner", "version", "id", "mode", "configDir", "manifestSha256",
            "skillSha256", "toolSha256",
            "runtimeExisted", "skillExisted", "toolExisted", "legacyCommandExisted",
            "runtimeStage", "runtimeBackup", "skillTemp", "skillBackup", "toolTemp",
            "toolBackup", "legacyCommandBackup", "manifestTemp"
        )
        $actualProperties = @($transaction.PSObject.Properties | ForEach-Object { $_.Name })
        if ($actualProperties.Count -ne $requiredProperties.Count) {
            throw "事务 journal 字段数量无效。"
        }
        foreach ($propertyName in $requiredProperties) {
            if ($actualProperties -cnotcontains $propertyName) {
                throw "事务 journal 缺少字段：$propertyName"
            }
        }

        foreach ($stringName in @(
            "owner", "id", "mode", "configDir", "manifestSha256", "skillSha256", "toolSha256", "runtimeStage",
            "runtimeBackup", "skillTemp", "skillBackup", "toolTemp", "toolBackup",
            "legacyCommandBackup", "manifestTemp"
        )) {
            if ($transaction.PSObject.Properties[$stringName].Value -isnot [string]) {
                throw "事务 journal 字符串字段类型无效：$stringName"
            }
        }
        if (-not (Test-ExactIntegerValue -Value $transaction.version -Expected 1)) {
            throw "事务 journal version 类型无效。"
        }

        if ([string]$transaction.owner -cne "legacy-code-atlas-transaction-v1" -or
            [string]$transaction.owner -cne $LegacyTransactionOwnerValue -or
            -not (Test-ExactIntegerValue -Value $transaction.version -Expected 1)) {
            throw "事务 journal owner 或 version 无效。"
        }
        $transactionId = [string]$transaction.id
        if ($transactionId -notmatch '^[0-9a-fA-F]{32}$') {
            throw "事务 journal id 无效。"
        }
        $mode = [string]$transaction.mode
        if ($mode -cne "fresh" -and $mode -cne "upgrade-v1" -and $mode -cne "update-v2") {
            throw "事务 journal mode 无效。"
        }
        if (-not (Test-Sha256 ([string]$transaction.manifestSha256))) {
            throw "事务 journal manifest hash 无效。"
        }
        if (-not (Test-Sha256 ([string]$transaction.skillSha256)) -or
            -not (Test-Sha256 ([string]$transaction.toolSha256))) {
            throw "事务 journal external file hash 无效。"
        }
        foreach ($booleanName in @("runtimeExisted", "skillExisted", "toolExisted", "legacyCommandExisted")) {
            $booleanProperty = $transaction.PSObject.Properties[$booleanName]
            if ($null -eq $booleanProperty -or $booleanProperty.Value -isnot [bool]) {
                throw "事务 journal 布尔字段无效：$booleanName"
            }
        }

        $configDir = Get-CanonicalPath ([string]$transaction.configDir)
        if (-not [StringComparer]::OrdinalIgnoreCase.Equals([string]$transaction.configDir, $configDir)) {
            throw "事务 journal configDir 不是规范绝对路径。"
        }
        $paths = Get-LegacyTransactionPaths -TransactionId $transactionId -ConfigDir $configDir
        $pathChecks = [ordered]@{
            runtimeStage = @([string]$transaction.runtimeStage, $paths.RuntimeStage)
            runtimeBackup = @([string]$transaction.runtimeBackup, $paths.RuntimeBackup)
            skillTemp = @([string]$transaction.skillTemp, $paths.SkillTemp)
            skillBackup = @([string]$transaction.skillBackup, $paths.SkillBackup)
            toolTemp = @([string]$transaction.toolTemp, $paths.ToolTemp)
            toolBackup = @([string]$transaction.toolBackup, $paths.ToolBackup)
            legacyCommandBackup = @([string]$transaction.legacyCommandBackup, $paths.LegacyCommandBackup)
            manifestTemp = @([string]$transaction.manifestTemp, $paths.ManifestTemp)
        }
        foreach ($pathName in $pathChecks.Keys) {
            $pathPair = $pathChecks[$pathName]
            if (-not [StringComparer]::OrdinalIgnoreCase.Equals($pathPair[0], $pathPair[1])) {
                throw "事务 journal 包含任意或非推导路径：$pathName"
            }
        }

        if ($mode -ceq "fresh" -and
            ($transaction.runtimeExisted -or $transaction.skillExisted -or
             $transaction.toolExisted -or $transaction.legacyCommandExisted)) {
            throw "fresh 事务不能声明已有目标。"
        }
        if (($mode -ceq "upgrade-v1" -or $mode -ceq "update-v2") -and
            -not $transaction.runtimeExisted) {
            throw "升级事务必须声明已有 runtime。"
        }
        if ($mode -ceq "upgrade-v1" -and $transaction.skillExisted) {
            throw "v1 升级事务不能声明已有 agent skill。"
        }
        if ($mode -ceq "update-v2" -and $transaction.legacyCommandExisted) {
            throw "v2 更新事务不能声明 legacy command。"
        }

        return [pscustomobject]@{
            Owner = $LegacyTransactionOwnerValue
            Version = 1
            Id = $transactionId
            Mode = $mode
            ConfigDir = $configDir
            ManifestSha256 = ([string]$transaction.manifestSha256).ToUpperInvariant()
            SkillSha256 = ([string]$transaction.skillSha256).ToUpperInvariant()
            ToolSha256 = ([string]$transaction.toolSha256).ToUpperInvariant()
            ManifestContent = ""
            RuntimeExisted = [bool]$transaction.runtimeExisted
            SkillExisted = [bool]$transaction.skillExisted
            ToolExisted = [bool]$transaction.toolExisted
            LegacyCommandExisted = [bool]$transaction.legacyCommandExisted
            RuntimeStage = $paths.RuntimeStage
            RuntimeBackup = $paths.RuntimeBackup
            SkillTemp = $paths.SkillTemp
            SkillBackup = $paths.SkillBackup
            ToolTemp = $paths.ToolTemp
            ToolBackup = $paths.ToolBackup
            LegacyCommandBackup = $paths.LegacyCommandBackup
            ManifestTemp = $paths.ManifestTemp
            ToolTarget = $paths.ToolTarget
            LegacyCommandTarget = $paths.LegacyCommandTarget
        }
    } catch {
        throw "拒绝使用无效的安装事务 journal：$($_.Exception.Message)"
    }
}

function Assert-LegacyTransactionPathsSafe([psobject]$Transaction) {
    $homeFull = Get-CanonicalPath $HOME
    Assert-NoReparsePointInPath -Boundary $homeFull -Path $Transaction.RuntimeStage
    Assert-NoReparsePointInPath -Boundary $homeFull -Path $Transaction.RuntimeBackup
    Assert-NoReparsePointInPath -Boundary $homeFull -Path $InstallDir
    Assert-NoReparsePointInPath -Boundary $homeFull -Path $Transaction.SkillTemp
    Assert-NoReparsePointInPath -Boundary $homeFull -Path (Join-Path $Transaction.SkillTemp "SKILL.md")
    Assert-NoReparsePointInPath -Boundary $homeFull -Path $Transaction.SkillBackup
    Assert-NoReparsePointInPath -Boundary $homeFull -Path $SkillTarget
    Assert-NoReparsePointInPath -Boundary $Transaction.ConfigDir -Path $Transaction.ToolTemp
    Assert-NoReparsePointInPath -Boundary $Transaction.ConfigDir -Path $Transaction.ToolBackup
    Assert-NoReparsePointInPath -Boundary $Transaction.ConfigDir -Path $Transaction.ToolTarget
    Assert-NoReparsePointInPath -Boundary $Transaction.ConfigDir -Path $Transaction.LegacyCommandTarget
    Assert-NoReparsePointInPath -Boundary $Transaction.ConfigDir -Path $Transaction.LegacyCommandBackup
    Assert-NoReparsePointInPath -Boundary $homeFull -Path $Transaction.ManifestTemp
    Assert-NoReparsePointInPath -Boundary $homeFull -Path $TransactionJournal
}

function Restore-TransactionFile {
    param(
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$Backup,
        [Parameter(Mandatory = $true)][bool]$Existed,
        [Parameter(Mandatory = $true)][string]$ExpectedNewSha256
    )

    $backupEntry = Get-PathEntryWithoutFollowingTarget $Backup
    if ($null -ne $backupEntry) {
        $targetEntry = Get-PathEntryWithoutFollowingTarget $Target
        if ($null -ne $targetEntry) {
            if ((Get-ContentHash $Target) -ne $ExpectedNewSha256) {
                throw "回滚时目标在安装中断后已被修改，拒绝覆盖：$Target"
            }
            Remove-Item -LiteralPath $Target -Force
        }
        Move-Item -LiteralPath $Backup -Destination $Target
    } elseif (-not $Existed) {
        $targetEntry = Get-PathEntryWithoutFollowingTarget $Target
        if ($null -ne $targetEntry) {
            if ((Get-ContentHash $Target) -ne $ExpectedNewSha256) {
                throw "回滚时目标内容不是本事务创建的文件，拒绝删除：$Target"
            }
            Remove-Item -LiteralPath $Target -Force
        }
    }
}

function Complete-LegacyInstallTransaction([psobject]$Transaction) {
    Assert-LegacyTransactionPathsSafe $Transaction
    $cleanupFailed = $false
    foreach ($file in @(
        $Transaction.SkillBackup,
        $Transaction.ToolTemp, $Transaction.ToolBackup,
        $Transaction.LegacyCommandBackup, $Transaction.ManifestTemp
    )) {
        if ($null -ne (Get-PathEntryWithoutFollowingTarget $file)) {
            try {
                Remove-Item -LiteralPath $file -Force
            } catch {
                Write-Warning $_.Exception.Message
                $cleanupFailed = $true
            }
            if ($null -ne (Get-PathEntryWithoutFollowingTarget $file)) {
                $cleanupFailed = $true
            }
        }
    }
    foreach ($tree in @(
        $Transaction.SkillTemp,
        $Transaction.RuntimeStage,
        $Transaction.RuntimeBackup
    )) {
        if ($null -ne (Get-PathEntryWithoutFollowingTarget $tree)) {
            try {
                Remove-AtlasTree $tree
            } catch {
                Write-Warning $_.Exception.Message
                $cleanupFailed = $true
            }
            if ($null -ne (Get-PathEntryWithoutFollowingTarget $tree)) {
                $cleanupFailed = $true
            }
        }
    }
    if ($cleanupFailed) {
        throw "安装已提交，但事务备份尚未全部清理；保留 journal 供下次重试。"
    }
    Remove-Item -LiteralPath $TransactionJournal -Force
    if ($null -ne (Get-PathEntryWithoutFollowingTarget $TransactionJournal)) {
        throw "安装已提交，但事务 journal 未能删除。"
    }
}

function Rollback-LegacyInstallTransaction([psobject]$Transaction) {
    Assert-LegacyTransactionPathsSafe $Transaction

    $ownsCreatedSkillNamespace = $false
    if (($Transaction.Mode -ceq "fresh" -or $Transaction.Mode -ceq "upgrade-v1") -and
        -not $Transaction.SkillExisted) {
        $skillTargetHash = Get-ContentHash $SkillTarget
        if ($skillTargetHash -eq $Transaction.SkillSha256) {
            $ownsCreatedSkillNamespace = $true
        }
    }

    # The manifest is the commit marker and lives inside the runtime. Reverse every
    # externally visible step before restoring the old runtime directory.
    if ((Test-Path -LiteralPath $Transaction.RuntimeBackup) -and (Test-Path -LiteralPath $OwnerMarker)) {
        Remove-Item -LiteralPath $OwnerMarker -Force
    }
    if ($Transaction.Mode -ceq "upgrade-v1" -and
        $null -ne (Get-PathEntryWithoutFollowingTarget $Transaction.LegacyCommandBackup)) {
        if ($null -ne (Get-PathEntryWithoutFollowingTarget $Transaction.LegacyCommandTarget)) {
            throw "回滚时 legacy command 目标被其他文件占用，拒绝覆盖：$($Transaction.LegacyCommandTarget)"
        }
        Move-Item -LiteralPath $Transaction.LegacyCommandBackup -Destination $Transaction.LegacyCommandTarget
    }
    Restore-TransactionFile -Target $Transaction.ToolTarget -Backup $Transaction.ToolBackup -Existed $Transaction.ToolExisted -ExpectedNewSha256 $Transaction.ToolSha256
    Restore-TransactionFile -Target $SkillTarget -Backup $Transaction.SkillBackup -Existed $Transaction.SkillExisted -ExpectedNewSha256 $Transaction.SkillSha256

    if (Test-Path -LiteralPath $Transaction.RuntimeBackup) {
        if (Test-Path -LiteralPath $InstallDir) {
            Remove-AtlasTree $InstallDir
        }
        Move-Item -LiteralPath $Transaction.RuntimeBackup -Destination $InstallDir
    } elseif (-not $Transaction.RuntimeExisted -and
        $null -ne (Get-PathEntryWithoutFollowingTarget $InstallDir)) {
        if ((Get-ContentHash $Transaction.ManifestTemp) -ne $Transaction.ManifestSha256) {
            throw "回滚时 runtime 不是本事务移动的目录，拒绝删除：$InstallDir"
        }
        Remove-AtlasTree $InstallDir
    }

    foreach ($temporary in @($Transaction.ToolTemp, $Transaction.LegacyCommandBackup)) {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
    if ($null -ne (Get-PathEntryWithoutFollowingTarget $Transaction.SkillTemp)) {
        Remove-AtlasTree $Transaction.SkillTemp
    }
    if ($ownsCreatedSkillNamespace) {
        $skillDirectoryEntry = Get-PathEntryWithoutFollowingTarget $SkillDir
        if ($null -ne $skillDirectoryEntry -and
            $skillDirectoryEntry.PSIsContainer -and
            @(Get-ChildItem -LiteralPath $SkillDir -Force).Count -eq 0) {
            Remove-Item -LiteralPath $SkillDir -Force
        }
    }
    if (Test-Path -LiteralPath $Transaction.RuntimeStage) {
        Remove-AtlasTree $Transaction.RuntimeStage
    }
    if (Test-Path -LiteralPath $TransactionJournal) {
        Remove-Item -LiteralPath $TransactionJournal -Force
    }
}

function Get-TransactionPaths {
    param(
        [Parameter(Mandatory = $true)][string]$TransactionId,
        [Parameter(Mandatory = $true)][string]$ConfigDir
    )

    $configFull = Get-CanonicalPath $ConfigDir
    $legacyToolTarget = Get-CanonicalPath (Join-Path $configFull "tools\legacy_atlas.ts")
    $legacyCommandTarget = Get-CanonicalPath (Join-Path $configFull "commands\understand.md")
    return [ordered]@{
        RuntimeStage = Get-CanonicalPath (Join-Path $HOME ".legacy-code-atlas.stage-$transactionId")
        RuntimeBackup = Get-CanonicalPath (Join-Path $HOME ".legacy-code-atlas.backup-$transactionId")
        SkillTemp = Get-CanonicalPath ($SkillDir + ".legacy-code-atlas-temp-$transactionId")
        SkillBackup = Get-CanonicalPath ($SkillTarget + ".legacy-code-atlas-backup-$transactionId")
        LegacyToolBackup = Get-CanonicalPath ($legacyToolTarget + ".legacy-code-atlas-backup-$transactionId")
        LegacyCommandBackup = Get-CanonicalPath ($legacyCommandTarget + ".legacy-code-atlas-backup-$transactionId")
        ManifestTemp = Get-CanonicalPath ($OwnerMarker + ".legacy-code-atlas-temp-$transactionId")
        LegacyToolTarget = $legacyToolTarget
        LegacyCommandTarget = $legacyCommandTarget
    }
}

function Get-InstallTransaction {
    if (-not (Test-Path -LiteralPath $TransactionJournal)) { return $null }

    try {
        $transaction = Get-Content -LiteralPath $TransactionJournal -Raw | ConvertFrom-Json
        $requiredProperties = @(
            "owner", "version", "id", "mode", "configDir", "manifestSha256", "skillSha256",
            "legacyToolSha256", "legacyCommandSha256", "runtimeExisted", "skillDirectoryExisted",
            "skillExisted", "legacyToolExisted", "legacyCommandExisted", "runtimeStage",
            "runtimeBackup", "skillTemp", "skillBackup", "legacyToolBackup",
            "legacyCommandBackup", "manifestTemp"
        )
        $actualProperties = @($transaction.PSObject.Properties | ForEach-Object { $_.Name })
        if ($actualProperties.Count -ne $requiredProperties.Count) {
            throw "事务 journal 字段数量无效。"
        }
        foreach ($propertyName in $requiredProperties) {
            if ($actualProperties -cnotcontains $propertyName) {
                throw "事务 journal 缺少字段：$propertyName"
            }
        }
        foreach ($stringName in @(
            "owner", "id", "mode", "configDir", "manifestSha256", "skillSha256",
            "legacyToolSha256", "legacyCommandSha256", "runtimeStage", "runtimeBackup",
            "skillTemp", "skillBackup", "legacyToolBackup", "legacyCommandBackup", "manifestTemp"
        )) {
            if ($transaction.PSObject.Properties[$stringName].Value -isnot [string]) {
                throw "事务 journal 字符串字段类型无效：$stringName"
            }
        }
        foreach ($booleanName in @(
            "runtimeExisted", "skillDirectoryExisted", "skillExisted",
            "legacyToolExisted", "legacyCommandExisted"
        )) {
            $booleanProperty = $transaction.PSObject.Properties[$booleanName]
            if ($null -eq $booleanProperty -or $booleanProperty.Value -isnot [bool]) {
                throw "事务 journal 布尔字段无效：$booleanName"
            }
        }
        if ([string]$transaction.owner -cne "legacy-code-atlas-transaction-v2" -or
            [string]$transaction.owner -cne $TransactionOwnerValue -or
            -not (Test-ExactIntegerValue -Value $transaction.version -Expected 2)) {
            throw "事务 journal owner 或 version 无效。"
        }

        $transactionId = [string]$transaction.id
        if ($transactionId -notmatch '^[0-9a-fA-F]{32}$') {
            throw "事务 journal id 无效。"
        }
        $mode = [string]$transaction.mode
        if ($mode -cne "fresh" -and $mode -cne "upgrade-v1" -and
            $mode -cne "upgrade-v2" -and $mode -cne "update-v3") {
            throw "事务 journal mode 无效。"
        }
        if (-not (Test-Sha256 ([string]$transaction.manifestSha256)) -or
            -not (Test-Sha256 ([string]$transaction.skillSha256))) {
            throw "事务 journal manifest 或 Skill hash 无效。"
        }

        $legacyToolSha256 = [string]$transaction.legacyToolSha256
        $legacyCommandSha256 = [string]$transaction.legacyCommandSha256
        if ($mode -ceq "upgrade-v1" -or $mode -ceq "upgrade-v2") {
            if (-not (Test-Sha256 $legacyToolSha256)) {
                throw "迁移事务 legacy tool hash 无效。"
            }
        } elseif ($legacyToolSha256.Length -ne 0 -or $transaction.legacyToolExisted) {
            throw "非迁移事务不能声明 legacy tool。"
        }
        if ($mode -ceq "upgrade-v1") {
            if (-not (Test-Sha256 $legacyCommandSha256)) {
                throw "v1 迁移事务 legacy command hash 无效。"
            }
        } elseif ($legacyCommandSha256.Length -ne 0 -or $transaction.legacyCommandExisted) {
            throw "非 v1 迁移事务不能声明 legacy command。"
        }

        $configDir = Get-CanonicalPath ([string]$transaction.configDir)
        if (-not [StringComparer]::OrdinalIgnoreCase.Equals([string]$transaction.configDir, $configDir)) {
            throw "事务 journal configDir 不是规范绝对路径。"
        }
        $paths = Get-TransactionPaths -TransactionId $transactionId -ConfigDir $configDir
        $pathChecks = [ordered]@{
            runtimeStage = @([string]$transaction.runtimeStage, $paths.RuntimeStage)
            runtimeBackup = @([string]$transaction.runtimeBackup, $paths.RuntimeBackup)
            skillTemp = @([string]$transaction.skillTemp, $paths.SkillTemp)
            skillBackup = @([string]$transaction.skillBackup, $paths.SkillBackup)
            legacyToolBackup = @([string]$transaction.legacyToolBackup, $paths.LegacyToolBackup)
            legacyCommandBackup = @([string]$transaction.legacyCommandBackup, $paths.LegacyCommandBackup)
            manifestTemp = @([string]$transaction.manifestTemp, $paths.ManifestTemp)
        }
        foreach ($pathName in $pathChecks.Keys) {
            $pathPair = $pathChecks[$pathName]
            if (-not [StringComparer]::OrdinalIgnoreCase.Equals($pathPair[0], $pathPair[1])) {
                throw "事务 journal 包含任意或非推导路径：$pathName"
            }
        }

        if ($transaction.skillExisted -and -not $transaction.skillDirectoryExisted) {
            throw "事务不能声明存在 Skill 文件但不存在 Skill 目录。"
        }
        if ($mode -ceq "fresh" -and
            ($transaction.runtimeExisted -or $transaction.skillDirectoryExisted -or
             $transaction.skillExisted -or $transaction.legacyToolExisted -or
             $transaction.legacyCommandExisted)) {
            throw "fresh 事务不能声明已有目标。"
        }
        if ($mode -cne "fresh" -and -not $transaction.runtimeExisted) {
            throw "更新事务必须声明已有 runtime。"
        }
        if ($mode -ceq "upgrade-v1" -and
            ($transaction.skillDirectoryExisted -or $transaction.skillExisted)) {
            throw "v1 升级事务不能声明已有 Agent Skill namespace。"
        }

        return [pscustomobject]@{
            Owner = $TransactionOwnerValue
            Version = 2
            Id = $transactionId
            Mode = $mode
            ConfigDir = $configDir
            ManifestSha256 = ([string]$transaction.manifestSha256).ToUpperInvariant()
            SkillSha256 = ([string]$transaction.skillSha256).ToUpperInvariant()
            LegacyToolSha256 = $legacyToolSha256.ToUpperInvariant()
            LegacyCommandSha256 = $legacyCommandSha256.ToUpperInvariant()
            ManifestContent = ""
            RuntimeExisted = [bool]$transaction.runtimeExisted
            SkillDirectoryExisted = [bool]$transaction.skillDirectoryExisted
            SkillExisted = [bool]$transaction.skillExisted
            LegacyToolExisted = [bool]$transaction.legacyToolExisted
            LegacyCommandExisted = [bool]$transaction.legacyCommandExisted
            RuntimeStage = $paths.RuntimeStage
            RuntimeBackup = $paths.RuntimeBackup
            SkillTemp = $paths.SkillTemp
            SkillBackup = $paths.SkillBackup
            LegacyToolBackup = $paths.LegacyToolBackup
            LegacyCommandBackup = $paths.LegacyCommandBackup
            ManifestTemp = $paths.ManifestTemp
            LegacyToolTarget = $paths.LegacyToolTarget
            LegacyCommandTarget = $paths.LegacyCommandTarget
        }
    } catch {
        throw "拒绝使用无效的安装事务 journal：$($_.Exception.Message)"
    }
}

function Assert-TransactionPathsSafe([psobject]$Transaction) {
    $homeFull = Get-CanonicalPath $HOME
    Assert-NoReparsePointInPath -Boundary $homeFull -Path $Transaction.RuntimeStage
    Assert-NoReparsePointInPath -Boundary $homeFull -Path $Transaction.RuntimeBackup
    Assert-NoReparsePointInPath -Boundary $homeFull -Path $InstallDir
    Assert-NoReparsePointInPath -Boundary $homeFull -Path $Transaction.SkillTemp
    Assert-NoReparsePointInPath -Boundary $homeFull -Path (Join-Path $Transaction.SkillTemp "SKILL.md")
    Assert-NoReparsePointInPath -Boundary $homeFull -Path $Transaction.SkillBackup
    Assert-NoReparsePointInPath -Boundary $homeFull -Path $SkillTarget
    Assert-NoReparsePointInPath -Boundary $Transaction.ConfigDir -Path $Transaction.LegacyToolTarget
    Assert-NoReparsePointInPath -Boundary $Transaction.ConfigDir -Path $Transaction.LegacyToolBackup
    Assert-NoReparsePointInPath -Boundary $Transaction.ConfigDir -Path $Transaction.LegacyCommandTarget
    Assert-NoReparsePointInPath -Boundary $Transaction.ConfigDir -Path $Transaction.LegacyCommandBackup
    Assert-NoReparsePointInPath -Boundary $homeFull -Path $Transaction.ManifestTemp
    Assert-NoReparsePointInPath -Boundary $homeFull -Path $TransactionJournal
}

function Restore-LegacyOwnedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][string]$Backup,
        [Parameter(Mandatory = $true)][bool]$ExpectedExisted,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )

    $backupEntry = Get-PathEntryWithoutFollowingTarget $Backup
    $targetEntry = Get-PathEntryWithoutFollowingTarget $Target
    if ($null -eq $backupEntry) {
        if ($ExpectedExisted -and $null -eq $targetEntry) {
            throw "回滚时 legacy owned file 及其备份都不存在，无法恢复：$Target"
        }
        return
    }
    if (-not $ExpectedExisted) {
        throw "回滚时出现不应存在的 legacy backup，拒绝处理：$Backup"
    }
    if ((Get-ContentHash $Backup) -ne $ExpectedSha256) {
        throw "回滚时 legacy backup 已被修改，拒绝恢复：$Backup"
    }
    if ($null -ne $targetEntry) {
        throw "回滚时 legacy owned file 目标被其他文件占用，拒绝覆盖：$Target"
    }
    Move-Item -LiteralPath $Backup -Destination $Target
}

function Remove-VerifiedLegacyBackup {
    param(
        [Parameter(Mandatory = $true)][string]$Backup,
        [Parameter(Mandatory = $true)][bool]$ExpectedExisted,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256
    )

    $backupEntry = Get-PathEntryWithoutFollowingTarget $Backup
    if ($null -eq $backupEntry) { return }
    if (-not $ExpectedExisted -or (Get-ContentHash $Backup) -ne $ExpectedSha256) {
        throw "legacy backup ownership 校验失败，拒绝删除：$Backup"
    }
    Remove-Item -LiteralPath $Backup -Force
}

function Complete-InstallTransaction([psobject]$Transaction) {
    Assert-TransactionPathsSafe $Transaction
    $cleanupFailed = $false

    foreach ($backupSpec in @(
        [pscustomobject]@{
            Path = $Transaction.LegacyToolBackup
            Existed = [bool]$Transaction.LegacyToolExisted
            Sha256 = $Transaction.LegacyToolSha256
        },
        [pscustomobject]@{
            Path = $Transaction.LegacyCommandBackup
            Existed = [bool]$Transaction.LegacyCommandExisted
            Sha256 = $Transaction.LegacyCommandSha256
        }
    )) {
        try {
            Remove-VerifiedLegacyBackup -Backup $backupSpec.Path -ExpectedExisted $backupSpec.Existed -ExpectedSha256 $backupSpec.Sha256
        } catch {
            Write-Warning $_.Exception.Message
            $cleanupFailed = $true
        }
    }
    foreach ($file in @($Transaction.SkillBackup, $Transaction.ManifestTemp)) {
        if ($null -ne (Get-PathEntryWithoutFollowingTarget $file)) {
            try {
                Remove-Item -LiteralPath $file -Force
            } catch {
                Write-Warning $_.Exception.Message
                $cleanupFailed = $true
            }
            if ($null -ne (Get-PathEntryWithoutFollowingTarget $file)) {
                $cleanupFailed = $true
            }
        }
    }
    foreach ($tree in @(
        $Transaction.SkillTemp,
        $Transaction.RuntimeStage,
        $Transaction.RuntimeBackup
    )) {
        if ($null -ne (Get-PathEntryWithoutFollowingTarget $tree)) {
            try {
                Remove-AtlasTree $tree
            } catch {
                Write-Warning $_.Exception.Message
                $cleanupFailed = $true
            }
            if ($null -ne (Get-PathEntryWithoutFollowingTarget $tree)) {
                $cleanupFailed = $true
            }
        }
    }
    if ($cleanupFailed) {
        throw "安装已提交，但事务备份尚未全部清理；保留 journal 供下次重试。"
    }
    Remove-Item -LiteralPath $TransactionJournal -Force
    if ($null -ne (Get-PathEntryWithoutFollowingTarget $TransactionJournal)) {
        throw "安装已提交，但事务 journal 未能删除。"
    }
}

function Rollback-InstallTransaction([psobject]$Transaction) {
    Assert-TransactionPathsSafe $Transaction

    $ownsCreatedSkillNamespace = $false
    if (-not $Transaction.SkillDirectoryExisted) {
        $skillTargetHash = Get-ContentHash $SkillTarget
        if ($skillTargetHash -eq $Transaction.SkillSha256) {
            $ownsCreatedSkillNamespace = $true
        }
    }

    if ((Test-Path -LiteralPath $Transaction.RuntimeBackup) -and (Test-Path -LiteralPath $OwnerMarker)) {
        Remove-Item -LiteralPath $OwnerMarker -Force
    }
    if ($Transaction.Mode -ceq "upgrade-v1") {
        Restore-LegacyOwnedFile `
            -Target $Transaction.LegacyCommandTarget `
            -Backup $Transaction.LegacyCommandBackup `
            -ExpectedExisted $Transaction.LegacyCommandExisted `
            -ExpectedSha256 $Transaction.LegacyCommandSha256
    }
    if ($Transaction.Mode -ceq "upgrade-v1" -or $Transaction.Mode -ceq "upgrade-v2") {
        Restore-LegacyOwnedFile `
            -Target $Transaction.LegacyToolTarget `
            -Backup $Transaction.LegacyToolBackup `
            -ExpectedExisted $Transaction.LegacyToolExisted `
            -ExpectedSha256 $Transaction.LegacyToolSha256
    }
    Restore-TransactionFile -Target $SkillTarget -Backup $Transaction.SkillBackup -Existed $Transaction.SkillExisted -ExpectedNewSha256 $Transaction.SkillSha256

    if (Test-Path -LiteralPath $Transaction.RuntimeBackup) {
        if (Test-Path -LiteralPath $InstallDir) {
            Remove-AtlasTree $InstallDir
        }
        Move-Item -LiteralPath $Transaction.RuntimeBackup -Destination $InstallDir
    } elseif (-not $Transaction.RuntimeExisted -and
        $null -ne (Get-PathEntryWithoutFollowingTarget $InstallDir)) {
        if ((Get-ContentHash $Transaction.ManifestTemp) -ne $Transaction.ManifestSha256) {
            throw "回滚时 runtime 不是本事务移动的目录，拒绝删除：$InstallDir"
        }
        Remove-AtlasTree $InstallDir
    }

    if ($null -ne (Get-PathEntryWithoutFollowingTarget $Transaction.SkillTemp)) {
        Remove-AtlasTree $Transaction.SkillTemp
    }
    if ($ownsCreatedSkillNamespace) {
        $skillDirectoryEntry = Get-PathEntryWithoutFollowingTarget $SkillDir
        if ($null -ne $skillDirectoryEntry -and
            $skillDirectoryEntry.PSIsContainer -and
            -not ($skillDirectoryEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
            @(Get-ChildItem -LiteralPath $SkillDir -Force).Count -eq 0) {
            Remove-Item -LiteralPath $SkillDir -Force
        }
    }
    if (Test-Path -LiteralPath $Transaction.RuntimeStage) {
        Remove-AtlasTree $Transaction.RuntimeStage
    }
    if (Test-Path -LiteralPath $TransactionJournal) {
        Remove-Item -LiteralPath $TransactionJournal -Force
    }
}

function Recover-InstallTransaction {
    if (-not (Test-Path -LiteralPath $TransactionJournal)) { return }

    try {
        $header = Get-Content -LiteralPath $TransactionJournal -Raw | ConvertFrom-Json
        $ownerProperty = $header.PSObject.Properties["owner"]
        $versionProperty = $header.PSObject.Properties["version"]
        if ($null -eq $ownerProperty -or $ownerProperty.Value -isnot [string] -or
            $null -eq $versionProperty) {
            throw "事务 journal 缺少严格的 owner/version。"
        }

        if ([string]$ownerProperty.Value -ceq $LegacyTransactionOwnerValue -and
            (Test-ExactIntegerValue -Value $versionProperty.Value -Expected 1)) {
            $legacyTransaction = Get-LegacyInstallTransaction
            Assert-LegacyTransactionPathsSafe $legacyTransaction
            $legacyManifestHash = Get-ContentHash -Path $OwnerMarker
            if ($legacyManifestHash -and $legacyManifestHash -eq $legacyTransaction.ManifestSha256) {
                Complete-LegacyInstallTransaction $legacyTransaction
            } else {
                Rollback-LegacyInstallTransaction $legacyTransaction
            }
            return
        }
        if ([string]$ownerProperty.Value -cne $TransactionOwnerValue -or
            -not (Test-ExactIntegerValue -Value $versionProperty.Value -Expected 2)) {
            throw "事务 journal owner/version 不受支持。"
        }
    } catch {
        throw "拒绝恢复无效的安装事务 journal：$($_.Exception.Message)"
    }

    $transaction = Get-InstallTransaction
    Assert-TransactionPathsSafe $transaction
    $installedManifestHash = Get-ContentHash -Path $OwnerMarker
    if ($installedManifestHash -and $installedManifestHash -eq $transaction.ManifestSha256) {
        Complete-InstallTransaction $transaction
        return
    }
    Rollback-InstallTransaction $transaction
}

function Write-TransactionJournal([psobject]$Transaction) {
    $journal = [ordered]@{
        owner = $TransactionOwnerValue
        version = 2
        id = $Transaction.Id
        mode = $Transaction.Mode
        configDir = Get-CanonicalPath $Transaction.ConfigDir
        manifestSha256 = $Transaction.ManifestSha256
        skillSha256 = $Transaction.SkillSha256
        legacyToolSha256 = $Transaction.LegacyToolSha256
        legacyCommandSha256 = $Transaction.LegacyCommandSha256
        runtimeExisted = [bool]$Transaction.RuntimeExisted
        skillDirectoryExisted = [bool]$Transaction.SkillDirectoryExisted
        skillExisted = [bool]$Transaction.SkillExisted
        legacyToolExisted = [bool]$Transaction.LegacyToolExisted
        legacyCommandExisted = [bool]$Transaction.LegacyCommandExisted
        runtimeStage = Get-CanonicalPath $Transaction.RuntimeStage
        runtimeBackup = Get-CanonicalPath $Transaction.RuntimeBackup
        skillTemp = Get-CanonicalPath $Transaction.SkillTemp
        skillBackup = Get-CanonicalPath $Transaction.SkillBackup
        legacyToolBackup = Get-CanonicalPath $Transaction.LegacyToolBackup
        legacyCommandBackup = Get-CanonicalPath $Transaction.LegacyCommandBackup
        manifestTemp = Get-CanonicalPath $Transaction.ManifestTemp
    }
    Write-AtomicUtf8File -Path $TransactionJournal -Content ($journal | ConvertTo-Json -Depth 4)
}

function New-InstallTransaction {
    param(
        [psobject]$ExistingManifest,
        [Parameter(Mandatory = $true)][string]$ConfigDir
    )

    $transactionId = [Guid]::NewGuid().ToString("N")
    $paths = Get-TransactionPaths -TransactionId $transactionId -ConfigDir $ConfigDir
    $mode = "fresh"
    $legacyToolSha256 = ""
    $legacyCommandSha256 = ""
    if ($null -ne $ExistingManifest) {
        if ($ExistingManifest.Version -eq 1) {
            $mode = "upgrade-v1"
        } elseif ($ExistingManifest.Version -eq 2) {
            $mode = "upgrade-v2"
        } else {
            $mode = "update-v3"
        }
        foreach ($entry in @($ExistingManifest.ExternalFiles)) {
            if ($entry.Kind -ceq "opencode-tool") {
                $legacyToolSha256 = $entry.Sha256
            } elseif ($entry.Kind -ceq "legacy-command") {
                $legacyCommandSha256 = $entry.Sha256
            }
        }
    }

    $migratesTool = $mode -ceq "upgrade-v1" -or $mode -ceq "upgrade-v2"
    $migratesCommand = $mode -ceq "upgrade-v1"
    return [pscustomobject]@{
        Owner = $TransactionOwnerValue
        Version = 2
        Id = $transactionId
        Mode = $mode
        ConfigDir = Get-CanonicalPath $ConfigDir
        ManifestSha256 = ""
        SkillSha256 = ""
        LegacyToolSha256 = $legacyToolSha256
        LegacyCommandSha256 = $legacyCommandSha256
        ManifestContent = ""
        RuntimeExisted = [bool]($null -ne (Get-PathEntryWithoutFollowingTarget $InstallDir))
        SkillDirectoryExisted = [bool]($null -ne (Get-PathEntryWithoutFollowingTarget $SkillDir))
        SkillExisted = [bool]($null -ne (Get-PathEntryWithoutFollowingTarget $SkillTarget))
        LegacyToolExisted = [bool]($migratesTool -and $null -ne (Get-PathEntryWithoutFollowingTarget $paths.LegacyToolTarget))
        LegacyCommandExisted = [bool]($migratesCommand -and $null -ne (Get-PathEntryWithoutFollowingTarget $paths.LegacyCommandTarget))
        RuntimeStage = $paths.RuntimeStage
        RuntimeBackup = $paths.RuntimeBackup
        SkillTemp = $paths.SkillTemp
        SkillBackup = $paths.SkillBackup
        LegacyToolBackup = $paths.LegacyToolBackup
        LegacyCommandBackup = $paths.LegacyCommandBackup
        ManifestTemp = $paths.ManifestTemp
        LegacyToolTarget = $paths.LegacyToolTarget
        LegacyCommandTarget = $paths.LegacyCommandTarget
    }
}

function Test-ManifestOwnsExternalPath {
    param(
        [psobject]$Manifest,
        [Parameter(Mandatory = $true)][string]$Kind,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if ($null -eq $Manifest) { return $false }
    foreach ($entry in @($Manifest.ExternalFiles)) {
        if ($entry.Kind -ceq $Kind -and (Test-SamePath $entry.Path $Path)) {
            return $true
        }
    }
    return $false
}

function Assert-NoUnownedLegacyIntegrationFiles {
    param(
        [Parameter(Mandatory = $true)][psobject]$Transaction,
        [psobject]$ExistingManifest
    )

    $userProfile = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace([string]$userProfile)) {
        $userProfile = $HOME
    }

    $globalConfigDir = $null
    if (-not [string]::IsNullOrWhiteSpace([string]$env:XDG_CONFIG_HOME)) {
        $globalConfigDir = Join-Path $env:XDG_CONFIG_HOME "opencode"
    } else {
        $globalConfigDir = Join-Path $userProfile ".config\opencode"
    }

    $candidateConfigDirs = @(
        $Transaction.ConfigDir,
        $env:OPENCODE_CONFIG_DIR,
        $globalConfigDir,
        (Join-Path $userProfile ".opencode")
    )
    $releasedToolHashes = @(
        "410C82A1CBC65A4FEF185F8F2B6DA506AB328997C505569E4A88A3667A9290FF",
        "17A88674FD7F9822B2D7DBF0320AF8BBB3F6A7ABDB7EF725AB6066A505310E57",
        "5A7985A2DE64F6BC072C7890D2A3964D6645A3ED694C804F5896F615D8510235",
        "1D683E03F06B0C1CDD80671174C5BC467BD4B871736DE2728BE3E530FB87D4CC"
    )
    $releasedToolSizes = @(3888L, 4003L, 4012L, 4142L)
    $seenConfigDirs = @{}
    foreach ($candidateConfigDir in $candidateConfigDirs) {
        if ([string]::IsNullOrWhiteSpace([string]$candidateConfigDir)) { continue }
        $configDir = Get-CanonicalPath ([string]$candidateConfigDir)
        $configKey = $configDir.ToUpperInvariant()
        if ($seenConfigDirs.ContainsKey($configKey)) { continue }
        $seenConfigDirs[$configKey] = $true

        $legacyCommand = Get-CanonicalPath (Join-Path $configDir "commands\understand.md")
        Assert-NoReparsePointInPath -Boundary $configDir -Path $legacyCommand
        if ($null -ne (Get-PathEntryWithoutFollowingTarget $legacyCommand) -and
            -not (Test-ManifestOwnsExternalPath -Manifest $ExistingManifest -Kind "legacy-command" -Path $legacyCommand)) {
            throw "检测到不属于当前 manifest 的旧 commands\understand.md：$legacyCommand。安装器已保留文件并停止；请先按原插件流程备份并卸载或禁用。"
        }

        $toolDirectories = @(
            (Get-CanonicalPath (Join-Path $configDir "tool")),
            (Get-CanonicalPath (Join-Path $configDir "tools"))
        )
        foreach ($toolDirectory in $toolDirectories) {
            Assert-NoReparsePointInPath -Boundary $configDir -Path $toolDirectory
            $toolDirectoryEntry = Get-PathEntryWithoutFollowingTarget $toolDirectory
            if ($null -eq $toolDirectoryEntry) { continue }
            if (-not $toolDirectoryEntry.PSIsContainer) {
                throw "OpenCode custom-tool 路径不是目录，无法安全扫描：$toolDirectory。安装器已保留现场并停止。"
            }

            foreach ($toolEntry in @(Get-ChildItem -LiteralPath $toolDirectory -Force -ErrorAction Stop)) {
                $extension = [IO.Path]::GetExtension($toolEntry.Name)
                if (-not [StringComparer]::OrdinalIgnoreCase.Equals($extension, ".js") -and
                    -not [StringComparer]::OrdinalIgnoreCase.Equals($extension, ".ts")) {
                    continue
                }

                $toolPath = Get-CanonicalPath $toolEntry.FullName
                Assert-NoReparsePointInPath -Boundary $configDir -Path $toolPath
                if ($toolEntry.PSIsContainer) {
                    throw "OpenCode custom-tool 候选不是普通文件，无法安全扫描：$toolPath。安装器已保留现场并停止。"
                }
                if (Test-ManifestOwnsExternalPath -Manifest $ExistingManifest -Kind "opencode-tool" -Path $toolPath) {
                    continue
                }

                $baseName = [IO.Path]::GetFileNameWithoutExtension($toolEntry.Name)
                $hasLegacyName = [StringComparer]::OrdinalIgnoreCase.Equals($baseName, "legacy_atlas")
                $matchesReleasedSize = $releasedToolSizes -contains [int64]$toolEntry.Length
                if (-not $hasLegacyName -and -not $matchesReleasedSize) { continue }

                $toolHash = (Get-ContentHash $toolPath).ToUpperInvariant()
                $hasReleasedHash = $releasedToolHashes -contains $toolHash
                if (-not $hasLegacyName -and -not $hasReleasedHash) { continue }

                throw "检测到不属于当前 manifest 的旧 OpenCode custom tool：$toolPath（SHA-256: $toolHash）。文件名或已发布哈希表明它可能再次触发 Bun is not defined；安装器已保留文件并停止。请先备份、确认来源后移动这个单独文件，不要删除整个 tool 或 tools 目录。"
            }
        }
    }
}

function Assert-InstallTransactionPreflight {
    param(
        [Parameter(Mandatory = $true)][psobject]$Transaction,
        [psobject]$ExistingManifest
    )

    Assert-TargetPathsSafe
    Assert-TransactionPathsSafe $Transaction
    Assert-DirectoryOrMissing $SkillDir

    foreach ($artifact in @(
        $Transaction.RuntimeStage, $Transaction.RuntimeBackup,
        $Transaction.SkillTemp, $Transaction.SkillBackup,
        $Transaction.LegacyToolBackup, $Transaction.LegacyCommandBackup,
        $Transaction.ManifestTemp
    )) {
        if ($null -ne (Get-PathEntryWithoutFollowingTarget $artifact)) {
            throw "事务临时路径已被占用，拒绝覆盖：$artifact"
        }
    }
    Assert-NoUnownedLegacyIntegrationFiles -Transaction $Transaction -ExistingManifest $ExistingManifest

    if ($null -eq $ExistingManifest) {
        if ($null -ne (Get-PathEntryWithoutFollowingTarget $InstallDir)) {
            throw "拒绝覆盖已有目录：$InstallDir。若它来自旧版 Legacy Code Atlas（/understand 入口时代），请先用当时下载的源码运行 install.ps1 -Uninstall，再重新安装；否则请确认目录来源后手工处理。"
        }
        if ($null -ne (Get-PathEntryWithoutFollowingTarget $SkillDir)) {
            throw "拒绝覆盖已有 Agent Skill 文件或目录：$SkillDir。两个 Skill 不能同时占用同一个 /atlas namespace；该目录可能来自旧安装或其他插件。安装器不会覆盖或删除现有文件。请先备份，再按来源插件的卸载或禁用流程处理。"
        }
        return
    }

    Assert-NoReparsePointTree $InstallDir
    foreach ($entry in @($ExistingManifest.ExternalFiles)) {
        $ownedEntry = Get-PathEntryWithoutFollowingTarget $entry.Path
        if ($null -ne $ownedEntry -and (Get-ContentHash $entry.Path) -ne $entry.Sha256) {
            if ($entry.Kind -ceq "opencode-tool") {
                throw "安装文件已被修改，拒绝迁移：$($entry.Path)。旧 OpenCode custom tool 已原样保留；请先备份并核对来源，不要盲目删除未知或重复文件。"
            }
            throw "安装文件已被修改，拒绝覆盖：$($entry.Path)"
        }
    }
    if ($ExistingManifest.Version -eq 1 -and
        $null -ne (Get-PathEntryWithoutFollowingTarget $SkillDir)) {
        throw "拒绝覆盖已有 Agent Skill 文件或目录：$SkillDir。两个 Skill 不能同时占用同一个 /atlas namespace；该目录可能来自旧安装或其他插件。安装器不会覆盖或删除现有文件。请先备份，再按来源插件的卸载或禁用流程处理。"
    }
}

function Initialize-InstallTransactionManifest {
    param(
        [Parameter(Mandatory = $true)][psobject]$Transaction,
        [Parameter(Mandatory = $true)][string]$SkillSource
    )

    Assert-IntegrationSourceFiles -SkillSource $SkillSource
    $Transaction.SkillSha256 = Get-ContentHash $SkillSource
    if (-not (Test-Sha256 $Transaction.SkillSha256)) {
        throw "无法计算 Agent Skill 的 SHA-256。"
    }

    $manifest = [ordered]@{
        owner = $OwnerValueV3
        version = 3
        installDir = Get-CanonicalPath $InstallDir
        configDir = Get-CanonicalPath $Transaction.ConfigDir
        ownedFiles = @(
            [ordered]@{
                kind = "agent-skill"
                path = Get-CanonicalPath $SkillTarget
                sha256 = $Transaction.SkillSha256
            }
        )
    }
    $Transaction.ManifestContent = $manifest | ConvertTo-Json -Depth 4
    $Transaction.ManifestSha256 = Get-Utf8BomContentHash -Content $Transaction.ManifestContent
}

function Prepare-InstallTransaction {
    param(
        [Parameter(Mandatory = $true)][psobject]$Transaction,
        [Parameter(Mandatory = $true)][string]$SkillSource
    )

    Assert-TransactionPathsSafe $Transaction
    New-Item -ItemType Directory -Path $Transaction.RuntimeStage | Out-Null
    foreach ($directory in @("bin", "src")) {
        $sourceDirectory = Join-Path $SourceRoot $directory
        $stageDirectory = Join-Path $Transaction.RuntimeStage $directory
        New-Item -ItemType Directory -Path $stageDirectory | Out-Null
        Get-ChildItem -LiteralPath $sourceDirectory -Force |
            Copy-Item -Destination $stageDirectory -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $SourceRoot "package.json") -Destination $Transaction.RuntimeStage -Force

    $stagedSkillTarget = Join-Path $Transaction.SkillTemp "SKILL.md"
    New-Item -ItemType Directory -Path $Transaction.SkillTemp -Force | Out-Null
    Copy-Item -LiteralPath $SkillSource -Destination $stagedSkillTarget
    if ((Get-ContentHash $stagedSkillTarget) -ne $Transaction.SkillSha256) {
        throw "Agent Skill 源文件在事务准备期间发生变化。"
    }
    $stagedManifest = Join-Path $Transaction.RuntimeStage (Split-Path -Leaf $Transaction.ManifestTemp)
    Write-AtomicUtf8File -Path $stagedManifest -Content $Transaction.ManifestContent
    if ((Get-ContentHash $stagedManifest) -ne $Transaction.ManifestSha256) {
        throw "staged manifest SHA-256 与事务 journal 不一致。"
    }
}

function Move-RuntimeIntoPlace([psobject]$Transaction) {
    Assert-TransactionPathsSafe $Transaction
    Assert-NoReparsePointTree $Transaction.RuntimeStage
    $runtimeEntry = Get-PathEntryWithoutFollowingTarget $InstallDir
    $runtimeExists = $null -ne $runtimeEntry
    if ($runtimeExists -ne $Transaction.RuntimeExisted) {
        throw "runtime 目标存在状态在预检后已改变，拒绝覆盖：$InstallDir"
    }
    if ($runtimeExists) {
        Assert-NoReparsePointTree $InstallDir
        Move-Item -LiteralPath $InstallDir -Destination $Transaction.RuntimeBackup
    }
    Move-Item -LiteralPath $Transaction.RuntimeStage -Destination $InstallDir
}

function Replace-SkillFile([psobject]$Transaction) {
    Assert-TransactionPathsSafe $Transaction
    $stagedSkillTarget = Join-Path $Transaction.SkillTemp "SKILL.md"
    if (-not $Transaction.SkillDirectoryExisted) {
        $skillNamespaceBeforePublish = Get-PathEntryWithoutFollowingTarget $SkillDir
        if ($null -ne $skillNamespaceBeforePublish) {
            throw "Agent Skill namespace 在预检后已被占用，拒绝发布：$SkillDir。两个 Skill 不能同时占用同一个 /atlas namespace；该目录可能来自旧安装或其他插件。安装器不会覆盖或删除现有文件。请先备份，再按来源插件的卸载或禁用流程处理。"
        }
        Assert-NoReparsePointTree $Transaction.SkillTemp
        if ((Get-ContentHash $stagedSkillTarget) -ne $Transaction.SkillSha256) {
            throw "Agent Skill stage 内容在发布前发生变化，拒绝发布。"
        }
        Move-Item -LiteralPath $Transaction.SkillTemp -Destination $SkillDir
        return
    }

    $currentSkillDirectory = Get-PathEntryWithoutFollowingTarget $SkillDir
    if ($null -eq $currentSkillDirectory -or -not $currentSkillDirectory.PSIsContainer) {
        throw "Agent Skill namespace 在预检后消失或类型改变，拒绝发布：$SkillDir"
    }
    Replace-TransactionFile -Temporary $stagedSkillTarget -Target $SkillTarget -Backup $Transaction.SkillBackup -ExpectedExisted $Transaction.SkillExisted
    if ($null -ne (Get-PathEntryWithoutFollowingTarget $Transaction.SkillTemp)) {
        Remove-AtlasTree $Transaction.SkillTemp
    }
}

function Backup-LegacyTool([psobject]$Transaction) {
    if ($Transaction.Mode -cne "upgrade-v1" -and $Transaction.Mode -cne "upgrade-v2") { return }
    Assert-TransactionPathsSafe $Transaction
    $toolEntry = Get-PathEntryWithoutFollowingTarget $Transaction.LegacyToolTarget
    $toolExists = $null -ne $toolEntry
    if ($toolExists -ne $Transaction.LegacyToolExisted) {
        throw "legacy tool 目标存在状态在预检后已改变，拒绝迁移：$($Transaction.LegacyToolTarget)"
    }
    if ($toolExists) {
        if ((Get-ContentHash $Transaction.LegacyToolTarget) -ne $Transaction.LegacyToolSha256) {
            throw "legacy tool 内容在预检后已改变，拒绝迁移：$($Transaction.LegacyToolTarget)"
        }
        Move-Item -LiteralPath $Transaction.LegacyToolTarget -Destination $Transaction.LegacyToolBackup
    }
}

function Backup-LegacyCommand([psobject]$Transaction) {
    if ($Transaction.Mode -cne "upgrade-v1") { return }
    Assert-TransactionPathsSafe $Transaction
    $commandEntry = Get-PathEntryWithoutFollowingTarget $Transaction.LegacyCommandTarget
    $commandExists = $null -ne $commandEntry
    if ($commandExists -ne $Transaction.LegacyCommandExisted) {
        throw "legacy command 目标存在状态在预检后已改变，拒绝迁移：$($Transaction.LegacyCommandTarget)"
    }
    if ($commandExists) {
        if ((Get-ContentHash $Transaction.LegacyCommandTarget) -ne $Transaction.LegacyCommandSha256) {
            throw "legacy command 内容在预检后已改变，拒绝迁移：$($Transaction.LegacyCommandTarget)"
        }
        Move-Item -LiteralPath $Transaction.LegacyCommandTarget -Destination $Transaction.LegacyCommandBackup
    }
}

function Commit-ManifestFile([psobject]$Transaction) {
    Assert-TransactionPathsSafe $Transaction
    Replace-TransactionFile -Temporary $Transaction.ManifestTemp -Target $OwnerMarker -ExpectedExisted $false
}

function Commit-InstallTransaction([psobject]$Transaction) {
    Assert-TransactionPathsSafe $Transaction
    Move-RuntimeIntoPlace $Transaction
    Replace-SkillFile $Transaction
    Backup-LegacyTool $Transaction
    Backup-LegacyCommand $Transaction
    Assert-PublishedIntegrationFiles $Transaction
    Commit-ManifestFile $Transaction
}

function Invoke-InstallTransaction {
    param(
        [Parameter(Mandatory = $true)][psobject]$Transaction,
        [psobject]$ExistingManifest,
        [Parameter(Mandatory = $true)][string]$SkillSource
    )

    $transactionStarted = $false
    try {
        Assert-InstallTransactionPreflight -Transaction $Transaction -ExistingManifest $ExistingManifest
        Initialize-InstallTransactionManifest -Transaction $Transaction -SkillSource $SkillSource
        Write-TransactionJournal $Transaction
        $transactionStarted = $true
        Prepare-InstallTransaction -Transaction $Transaction -SkillSource $SkillSource
        Commit-InstallTransaction $Transaction
    } catch {
        $installError = $_
        $journalEntry = Get-PathEntryWithoutFollowingTarget $TransactionJournal
        if ($transactionStarted -or $null -ne $journalEntry) {
            try {
                Rollback-InstallTransaction $Transaction
            } catch {
                throw "安装失败且回滚未完成；已保留事务 journal 供下次恢复。原始错误：$($installError.Exception.Message)；回滚错误：$($_.Exception.Message)"
            }
        }
        throw $installError
    }
    Complete-InstallTransaction $Transaction
}

Recover-InstallTransaction

$existingManifest = Get-InstallManifest

if ($existingManifest) {
    $OpenCodeConfigDir = Get-CanonicalPath $existingManifest.ConfigDir
} elseif ($env:OPENCODE_CONFIG_DIR) {
    $OpenCodeConfigDir = Get-CanonicalPath $env:OPENCODE_CONFIG_DIR
} elseif ($env:XDG_CONFIG_HOME) {
    $OpenCodeConfigDir = Get-CanonicalPath (Join-Path $env:XDG_CONFIG_HOME "opencode")
} else {
    $OpenCodeConfigDir = Get-CanonicalPath (Join-Path $HOME ".config\opencode")
}
if ($Uninstall) {
    if (-not $existingManifest) {
        throw "拒绝卸载：$InstallDir 没有有效的 Legacy Code Atlas ownership manifest。"
    }

    Assert-TargetPathsSafe
    Assert-NoReparsePointTree $InstallDir
    $filesToRemove = @()
    foreach ($entry in @($existingManifest.ExternalFiles)) {
        if ($entry.Kind -ceq "agent-skill") {
            Assert-NoReparsePointInPath -Boundary (Get-CanonicalPath $HOME) -Path $entry.Path
        } else {
            Assert-NoReparsePointInPath -Boundary $OpenCodeConfigDir -Path $entry.Path
        }
        if ($null -eq (Get-PathEntryWithoutFollowingTarget $entry.Path)) { continue }
        $actualHash = Get-ContentHash $entry.Path
        if ($actualHash -ne $entry.Sha256) {
            Write-Warning "文件已被修改，卸载时保留：$($entry.Path)"
        } else {
            $filesToRemove += $entry
        }
    }

    $removedOwnedSkill = $false
    foreach ($entry in $filesToRemove) {
        if ($entry.Kind -ceq "agent-skill") {
            Assert-NoReparsePointInPath -Boundary (Get-CanonicalPath $HOME) -Path $entry.Path
        } else {
            Assert-NoReparsePointInPath -Boundary $OpenCodeConfigDir -Path $entry.Path
        }
        Remove-Item -LiteralPath $entry.Path -Force
        if ($entry.Kind -ceq "agent-skill") {
            $removedOwnedSkill = $true
        }
    }
    if ($removedOwnedSkill) {
        Assert-NoReparsePointInPath -Boundary (Get-CanonicalPath $HOME) -Path $SkillDir
        $skillDirectoryEntry = Get-PathEntryWithoutFollowingTarget $SkillDir
        if ($null -ne $skillDirectoryEntry -and
            $skillDirectoryEntry.PSIsContainer -and
            -not ($skillDirectoryEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
            @(Get-ChildItem -LiteralPath $SkillDir -Force).Count -eq 0) {
            Remove-Item -LiteralPath $SkillDir -Force
        }
    }

    $savedCli = [Environment]::GetEnvironmentVariable("LEGACY_CODE_ATLAS_CLI", "User")
    if ($savedCli -eq $CliTarget) {
        [Environment]::SetEnvironmentVariable("LEGACY_CODE_ATLAS_CLI", $null, "User")
    }
    Remove-Item Env:LEGACY_CODE_ATLAS_CLI -ErrorAction SilentlyContinue
    Assert-NoReparsePointInPath -Boundary (Get-CanonicalPath $HOME) -Path $InstallDir
    Remove-AtlasTree $InstallDir

    Write-Host "Legacy Code Atlas 已卸载。请重启 OpenCode。" -ForegroundColor Green
    exit 0
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw "找不到 node.exe。请先安装 Node.js 20 或更高版本。"
}
$nodeVersion = (& node --version).Trim()
$nodeMajorText = $nodeVersion -replace '^v([0-9]+).*$','$1'
$nodeMajor = 0
if (-not [int]::TryParse($nodeMajorText, [ref]$nodeMajor) -or $nodeMajor -lt 20) {
    throw "需要 Node.js 20 或更高版本，当前版本：$nodeVersion"
}

$SkillSource = Join-Path $SourceRoot "integrations\opencode\skills\atlas\SKILL.md"
$requiredFiles = @(
    (Join-Path $SourceRoot "bin\legacy-code-atlas.mjs"),
    (Join-Path $SourceRoot "src\analyzer.mjs"),
    (Join-Path $SourceRoot "package.json"),
    $SkillSource
)
foreach ($required in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "安装源文件缺失：$required"
    }
}

$transaction = New-InstallTransaction -ExistingManifest $existingManifest -ConfigDir $OpenCodeConfigDir
Invoke-InstallTransaction -Transaction $transaction -ExistingManifest $existingManifest -SkillSource $SkillSource

Write-Host ""
Write-Host "Legacy Code Atlas 安装完成。" -ForegroundColor Green
Write-Host "运行文件：$InstallDir"
Write-Host "Agent Skill：$SkillTarget"
Write-Host "运行时入口：Agent Skill（唯一运行入口，不依赖 OpenCode custom tool）"
Write-Host "OpenCode custom tool：未安装；不会创建或写入 tools\legacy_atlas.ts"
Write-Host "旧版 v1/v2 中由 manifest 和 SHA-256 证明归属的 legacy_atlas.ts 已在本次迁移中安全移除。"
Write-Host "若仍出现 Bun is not defined：OpenCode 可能正在加载其他配置位置的旧文件。请先确认实际 configDir 并备份核对；不要删除整个 tools 目录。"
Write-Host ""
Write-Host "下一步："
Write-Host "  1. 完全关闭并重新打开 OpenCode"
Write-Host "  2. 在老项目目录启动 OpenCode"
Write-Host "  3. 单独输入 /atlas"
Write-Host "  4. 分析完成后，在下一条普通消息中询问功能"
Write-Host ""
Write-Host "更新：下载新源码后重新运行本脚本"
Write-Host "卸载：powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall"

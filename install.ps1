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
$TransactionOwnerValue = "legacy-code-atlas-transaction-v1"
$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Join-Path $HOME ".legacy-code-atlas"
$OwnerMarker = Join-Path $InstallDir ".legacy-code-atlas-owner.json"
$TransactionJournal = Join-Path $HOME ".legacy-code-atlas.transaction.json"
$CliTarget = Join-Path $InstallDir "bin\legacy-code-atlas.mjs"
$SkillDir = Join-Path $HOME ".agents\skills\understand"
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

        return $null
    } catch {
        return $null
    }
}

function Get-ContentHash([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
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

function Assert-TargetPathsSafe([string]$ConfigDir) {
    Assert-NoReparsePointInPath -Boundary (Get-CanonicalPath $HOME) -Path $InstallDir
    Assert-NoReparsePointInPath -Boundary (Get-CanonicalPath $HOME) -Path (Join-Path $InstallDir "bin")
    Assert-NoReparsePointInPath -Boundary (Get-CanonicalPath $HOME) -Path (Join-Path $InstallDir "src")
    Assert-NoReparsePointInPath -Boundary (Get-CanonicalPath $HOME) -Path (Join-Path $InstallDir "package.json")
    Assert-NoReparsePointInPath -Boundary (Get-CanonicalPath $HOME) -Path $SkillTarget
    Assert-NoReparsePointInPath -Boundary $ConfigDir -Path $ToolTarget
    Assert-NoReparsePointInPath -Boundary $ConfigDir -Path $LegacyCommandTarget
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

function Get-TransactionPaths {
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

function Get-InstallTransaction {
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
            [string]$transaction.owner -cne $TransactionOwnerValue -or
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
        $paths = Get-TransactionPaths -TransactionId $transactionId -ConfigDir $configDir
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
            Owner = $TransactionOwnerValue
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

function Assert-TransactionPathsSafe([psobject]$Transaction) {
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

function Complete-InstallTransaction([psobject]$Transaction) {
    Assert-TransactionPathsSafe $Transaction
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

function Rollback-InstallTransaction([psobject]$Transaction) {
    Assert-TransactionPathsSafe $Transaction

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

function Recover-InstallTransaction {
    $transaction = Get-InstallTransaction
    if ($null -eq $transaction) { return }

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
        version = 1
        id = $Transaction.Id
        mode = $Transaction.Mode
        configDir = Get-CanonicalPath $Transaction.ConfigDir
        manifestSha256 = $Transaction.ManifestSha256
        skillSha256 = $Transaction.SkillSha256
        toolSha256 = $Transaction.ToolSha256
        runtimeExisted = [bool]$Transaction.RuntimeExisted
        skillExisted = [bool]$Transaction.SkillExisted
        toolExisted = [bool]$Transaction.ToolExisted
        legacyCommandExisted = [bool]$Transaction.LegacyCommandExisted
        runtimeStage = Get-CanonicalPath $Transaction.RuntimeStage
        runtimeBackup = Get-CanonicalPath $Transaction.RuntimeBackup
        skillTemp = Get-CanonicalPath $Transaction.SkillTemp
        skillBackup = Get-CanonicalPath $Transaction.SkillBackup
        toolTemp = Get-CanonicalPath $Transaction.ToolTemp
        toolBackup = Get-CanonicalPath $Transaction.ToolBackup
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
    if ($null -ne $ExistingManifest) {
        if ($ExistingManifest.Version -eq 1) { $mode = "upgrade-v1" } else { $mode = "update-v2" }
    }
    return [pscustomobject]@{
        Owner = $TransactionOwnerValue
        Version = 1
        Id = $transactionId
        Mode = $mode
        ConfigDir = Get-CanonicalPath $ConfigDir
        ManifestSha256 = ""
        SkillSha256 = ""
        ToolSha256 = ""
        ManifestContent = ""
        RuntimeExisted = [bool]($null -ne (Get-PathEntryWithoutFollowingTarget $InstallDir))
        SkillExisted = [bool]($null -ne (Get-PathEntryWithoutFollowingTarget $SkillTarget))
        ToolExisted = [bool]($null -ne (Get-PathEntryWithoutFollowingTarget $paths.ToolTarget))
        LegacyCommandExisted = [bool]($null -ne (Get-PathEntryWithoutFollowingTarget $paths.LegacyCommandTarget))
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
}

function Assert-InstallTransactionPreflight {
    param(
        [Parameter(Mandatory = $true)][psobject]$Transaction,
        [psobject]$ExistingManifest
    )

    Assert-TargetPathsSafe -ConfigDir $Transaction.ConfigDir
    Assert-TransactionPathsSafe $Transaction
    Assert-DirectoryOrMissing $SkillDir
    Assert-DirectoryOrMissing (Split-Path -Parent $Transaction.ToolTarget)

    foreach ($artifact in @(
        $Transaction.RuntimeStage, $Transaction.RuntimeBackup,
        $Transaction.SkillTemp, $Transaction.SkillBackup,
        $Transaction.ToolTemp, $Transaction.ToolBackup,
        $Transaction.LegacyCommandBackup, $Transaction.ManifestTemp
    )) {
        if (Test-Path -LiteralPath $artifact) {
            throw "事务临时路径已被占用，拒绝覆盖：$artifact"
        }
    }

    if ($null -eq $ExistingManifest) {
        if (Test-Path -LiteralPath $InstallDir) {
            throw "拒绝覆盖已有目录：$InstallDir。请确认目录来源后手工处理。"
        }
        if ($null -ne (Get-PathEntryWithoutFollowingTarget $SkillDir)) {
            throw "拒绝覆盖已有 Agent Skill 文件或目录：$SkillDir"
        }
        foreach ($target in @($Transaction.ToolTarget, $Transaction.LegacyCommandTarget)) {
            if (Test-Path -LiteralPath $target) {
                throw "拒绝覆盖已有 OpenCode 文件：$target"
            }
        }
        return
    }

    Assert-NoReparsePointTree $InstallDir
    foreach ($entry in @($ExistingManifest.ExternalFiles)) {
        if ((Test-Path -LiteralPath $entry.Path) -and (Get-ContentHash $entry.Path) -ne $entry.Sha256) {
            throw "安装文件已被修改，拒绝覆盖：$($entry.Path)"
        }
    }
    if ($ExistingManifest.Version -eq 1) {
        if ($null -ne (Get-PathEntryWithoutFollowingTarget $SkillDir)) {
            throw "拒绝覆盖已有 Agent Skill 文件或目录：$SkillDir"
        }
    } elseif (Test-Path -LiteralPath $Transaction.LegacyCommandTarget) {
        throw "拒绝覆盖已有 OpenCode 文件：$($Transaction.LegacyCommandTarget)"
    }
}

function Initialize-InstallTransactionManifest {
    param(
        [Parameter(Mandatory = $true)][psobject]$Transaction,
        [Parameter(Mandatory = $true)][string]$SkillSource,
        [Parameter(Mandatory = $true)][string]$ToolSource
    )

    $Transaction.SkillSha256 = Get-ContentHash $SkillSource
    $Transaction.ToolSha256 = Get-ContentHash $ToolSource
    if (-not (Test-Sha256 $Transaction.SkillSha256) -or
        -not (Test-Sha256 $Transaction.ToolSha256)) {
        throw "无法计算 Agent Skill 或 OpenCode tool 的 SHA-256。"
    }

    $manifest = [ordered]@{
        owner = $OwnerValueV2
        version = 2
        installDir = Get-CanonicalPath $InstallDir
        configDir = Get-CanonicalPath $Transaction.ConfigDir
        ownedFiles = @(
            [ordered]@{
                kind = "agent-skill"
                path = Get-CanonicalPath $SkillTarget
                sha256 = $Transaction.SkillSha256
            },
            [ordered]@{
                kind = "opencode-tool"
                path = Get-CanonicalPath $Transaction.ToolTarget
                sha256 = $Transaction.ToolSha256
            }
        )
    }
    $Transaction.ManifestContent = $manifest | ConvertTo-Json -Depth 4
    $Transaction.ManifestSha256 = Get-Utf8BomContentHash -Content $Transaction.ManifestContent
}

function Prepare-InstallTransaction {
    param(
        [Parameter(Mandatory = $true)][psobject]$Transaction,
        [Parameter(Mandatory = $true)][string]$SkillSource,
        [Parameter(Mandatory = $true)][string]$ToolSource
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
    $toolDir = Split-Path -Parent $Transaction.ToolTarget
    New-Item -ItemType Directory -Path $toolDir -Force | Out-Null
    Copy-Item -LiteralPath $ToolSource -Destination $Transaction.ToolTemp
    if ((Get-ContentHash $stagedSkillTarget) -ne $Transaction.SkillSha256 -or
        (Get-ContentHash $Transaction.ToolTemp) -ne $Transaction.ToolSha256) {
        throw "安装源文件在事务准备期间发生变化。"
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
    if ($Transaction.Mode -ceq "fresh" -or $Transaction.Mode -ceq "upgrade-v1") {
        if ($null -ne (Get-PathEntryWithoutFollowingTarget $SkillDir)) {
            throw "Agent Skill namespace 在预检后已被占用，拒绝发布：$SkillDir"
        }
        Assert-NoReparsePointTree $Transaction.SkillTemp
        if ((Get-ContentHash $stagedSkillTarget) -ne $Transaction.SkillSha256) {
            throw "Agent Skill stage 内容在发布前发生变化，拒绝发布。"
        }
        Move-Item -LiteralPath $Transaction.SkillTemp -Destination $SkillDir
        return
    }

    if ($null -eq (Get-PathEntryWithoutFollowingTarget $SkillDir)) {
        New-Item -ItemType Directory -Path $SkillDir -Force | Out-Null
    }
    Replace-TransactionFile -Temporary $stagedSkillTarget -Target $SkillTarget -Backup $Transaction.SkillBackup -ExpectedExisted $Transaction.SkillExisted
    if ($null -ne (Get-PathEntryWithoutFollowingTarget $Transaction.SkillTemp)) {
        Remove-AtlasTree $Transaction.SkillTemp
    }
}

function Replace-ToolFile([psobject]$Transaction) {
    Assert-TransactionPathsSafe $Transaction
    Replace-TransactionFile -Temporary $Transaction.ToolTemp -Target $Transaction.ToolTarget -Backup $Transaction.ToolBackup -ExpectedExisted $Transaction.ToolExisted
}

function Backup-LegacyCommand([psobject]$Transaction) {
    Assert-TransactionPathsSafe $Transaction
    $commandEntry = Get-PathEntryWithoutFollowingTarget $Transaction.LegacyCommandTarget
    $commandExists = $null -ne $commandEntry
    if ($commandExists -ne $Transaction.LegacyCommandExisted) {
        throw "legacy command 目标存在状态在预检后已改变，拒绝迁移：$($Transaction.LegacyCommandTarget)"
    }
    if ($Transaction.Mode -ceq "upgrade-v1" -and $commandExists) {
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
    Replace-ToolFile $Transaction
    Backup-LegacyCommand $Transaction
    Commit-ManifestFile $Transaction
}

function Invoke-InstallTransaction {
    param(
        [Parameter(Mandatory = $true)][psobject]$Transaction,
        [psobject]$ExistingManifest,
        [Parameter(Mandatory = $true)][string]$SkillSource,
        [Parameter(Mandatory = $true)][string]$ToolSource
    )

    $transactionStarted = $false
    try {
        Assert-InstallTransactionPreflight -Transaction $Transaction -ExistingManifest $ExistingManifest
        Initialize-InstallTransactionManifest -Transaction $Transaction -SkillSource $SkillSource -ToolSource $ToolSource
        Write-TransactionJournal $Transaction
        $transactionStarted = $true
        Prepare-InstallTransaction -Transaction $Transaction -SkillSource $SkillSource -ToolSource $ToolSource
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
} else {
    $OpenCodeConfigDir = Get-CanonicalPath (Join-Path $HOME ".config\opencode")
}
$ToolTarget = Get-CanonicalPath (Join-Path $OpenCodeConfigDir "tools\legacy_atlas.ts")
$ToolDir = Split-Path -Parent $ToolTarget
$LegacyCommandTarget = Get-CanonicalPath (Join-Path $OpenCodeConfigDir "commands\understand.md")

if ($Uninstall) {
    if (-not $existingManifest) {
        throw "拒绝卸载：$InstallDir 没有有效的 Legacy Code Atlas ownership manifest。"
    }

    Assert-TargetPathsSafe -ConfigDir $OpenCodeConfigDir
    Assert-NoReparsePointTree $InstallDir
    $filesToRemove = @()
    foreach ($entry in @($existingManifest.ExternalFiles)) {
        if (-not (Test-Path -LiteralPath $entry.Path)) { continue }
        $actualHash = Get-ContentHash $entry.Path
        if ($actualHash -ne $entry.Sha256) {
            Write-Warning "文件已被修改，卸载时保留：$($entry.Path)"
        } else {
            $filesToRemove += $entry
        }
    }

    foreach ($entry in $filesToRemove) {
        if ($entry.Kind -eq "agent-skill") {
            Assert-NoReparsePointInPath -Boundary (Get-CanonicalPath $HOME) -Path $entry.Path
        } else {
            Assert-NoReparsePointInPath -Boundary $OpenCodeConfigDir -Path $entry.Path
        }
        Remove-Item -LiteralPath $entry.Path -Force
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

$SkillSource = Join-Path $SourceRoot "integrations\opencode\skills\understand\SKILL.md"
$ToolSource = Join-Path $SourceRoot "integrations\opencode\tools\legacy_atlas.ts"
$requiredFiles = @(
    (Join-Path $SourceRoot "bin\legacy-code-atlas.mjs"),
    (Join-Path $SourceRoot "src\analyzer.mjs"),
    (Join-Path $SourceRoot "package.json"),
    $SkillSource,
    $ToolSource
)
foreach ($required in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "安装源文件缺失：$required"
    }
}

$transaction = New-InstallTransaction -ExistingManifest $existingManifest -ConfigDir $OpenCodeConfigDir
Invoke-InstallTransaction -Transaction $transaction -ExistingManifest $existingManifest -SkillSource $SkillSource -ToolSource $ToolSource

Write-Host ""
Write-Host "Legacy Code Atlas 安装完成。" -ForegroundColor Green
Write-Host "运行文件：$InstallDir"
Write-Host "Agent Skill：$SkillTarget"
Write-Host "OpenCode 工具：$ToolTarget"
Write-Host ""
Write-Host "下一步："
Write-Host "  1. 完全关闭并重新打开 OpenCode"
Write-Host "  2. 在老项目目录启动 OpenCode"
Write-Host "  3. 单独输入 /understand"
Write-Host "  4. 分析完成后，在下一条普通消息中询问功能"
Write-Host ""
Write-Host "更新：下载新源码后重新运行本脚本"
Write-Host "卸载：powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall"

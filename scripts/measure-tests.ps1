# Run from the worktree being measured. Each invocation creates a new external evidence directory.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$OutputDirectory,
    [Parameter(Mandatory)][string]$LoadDescription,
    [Parameter(Mandatory)][string]$CacheDescription,
    [switch]$Profile
)

$ErrorActionPreference = 'Stop'
# Native failures must be recorded, rather than interrupting collection before metadata is saved.
$PSNativeCommandUseErrorActionPreference = $false
$root = (Get-Location).Path
if (-not [IO.Path]::IsPathFullyQualified($OutputDirectory)) {
    throw 'Use an absolute evidence directory path.'
}
$evidence = [IO.Path]::GetFullPath($OutputDirectory)
if ($evidence.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or
    $evidence.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Choose an evidence directory outside the source worktree.'
}
New-Item -ItemType Directory -Path $evidence | Out-Null
$log = Join-Path $evidence 'output.log'
$events = Join-Path $evidence 'timings.jsonl'
$reporter = Join-Path $PSScriptRoot 'test-timing-reporter.mjs'
$collector = $PSCommandPath
$gitRoot = $root.Replace('\', '/')
$revision = & git -c "safe.directory=$gitRoot" rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the measured revision.' }
$status = @(& git -c "safe.directory=$gitRoot" status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the measured worktree.' }
$metadata = [ordered]@{
    revision = $revision
    worktreeStatus = $status
    mode = $(if ($Profile) { 'profiling; excluded from performance samples' } else { 'original npm test' })
    workingDirectory = $root
    powershell = $PSVersionTable.PSVersion.ToString()
    node = (& node --version)
    npm = (& npm --version)
    git = (& git --version)
    machine = ((& node -e 'const os=require("node:os"); console.log(JSON.stringify({platform:process.platform,osVersion:os.version(),release:os.release(),arch:process.arch,cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,availableParallelism:os.availableParallelism()}));') | ConvertFrom-Json)
    lockSha256 = (Get-FileHash -LiteralPath (Join-Path $root 'package-lock.json') -Algorithm SHA256).Hash
    collectorSha256 = (Get-FileHash -LiteralPath $collector -Algorithm SHA256).Hash
    reporterSha256 = (Get-FileHash -LiteralPath $reporter -Algorithm SHA256).Hash
    loadDescription = $LoadDescription
    cacheDescription = $CacheDescription
    ompProbeEnabled = [bool]$env:PHANTOM_RUN_OMP_PROBE
    nodeOptionsPresent = [bool]$env:NODE_OPTIONS
    processSnapshot = @(Get-Process -Name node,git,pwsh,powershell -ErrorAction SilentlyContinue |
        Select-Object Id,ProcessName,CPU,StartTime)
    log = $log
    exitCode = $null
    collectionError = $null
}
$testArgs = @()
if ($Profile) {
    $testArgs = @((Join-Path $root 'node_modules/tsx/dist/cli.mjs'), '--test',
        '--test-reporter=spec', '--test-reporter-destination=stdout',
        "--test-reporter=$(([Uri]$reporter).AbsoluteUri)", "--test-reporter-destination=$events", 'tests/*.test.ts')
    $metadata.command = @('node') + $testArgs
} else {
    $metadata.command = @('npm', 'test')
}
$metadata.startedAt = [DateTime]::UtcNow.ToString('o')
$clock = [Diagnostics.Stopwatch]::StartNew()
try {
    if ($Profile) { & node @testArgs *> $log } else { & npm test *> $log }
    $metadata.exitCode = $LASTEXITCODE
} catch {
    $metadata.collectionError = $_.Exception.Message
} finally {
    $clock.Stop()
    $metadata.wallClockMs = $clock.Elapsed.TotalMilliseconds
    $metadata.finishedAt = [DateTime]::UtcNow.ToString('o')
    $metadata | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $evidence 'metadata.json') -Encoding utf8
}
Write-Output "Evidence: $evidence"
Write-Output "Wall clock: $($metadata.wallClockMs) ms; test exit code: $($metadata.exitCode)"
if ($metadata.collectionError) { throw $metadata.collectionError }
if ($null -eq $metadata.exitCode) { throw 'The test command did not provide an exit code.' }
exit $metadata.exitCode

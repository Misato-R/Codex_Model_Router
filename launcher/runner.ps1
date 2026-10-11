param([Parameter(Mandatory = $true)][string]$ConfigPath, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$directory = Join-Path $root '.router-memory\launcher'
. (Join-Path $PSScriptRoot 'launch-plan.ps1')
$code = 1
$desktop = $false
$outputPath = $null
try {
    $resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
    if ((Split-Path -Parent $resolvedConfig) -ne $directory) { throw 'Invalid launcher configuration path.' }
    $config = Get-Content -Raw -LiteralPath $resolvedConfig | ConvertFrom-Json
    if ($ValidateOnly -and $config.action -ne 'launch') { throw 'Validation supports launch plans only.' }
    $desktop = $config.action -eq 'launch' -and $config.entry -eq 'desktop' -and -not $config.record
    $outputPath = [IO.Path]::ChangeExtension($resolvedConfig, '.log')
    Set-Location -LiteralPath $root
    if ($config.action -eq 'install') {
        & (Get-Command npm.cmd -ErrorAction Stop).Source ci
        $code = $LASTEXITCODE
    } elseif ($config.action -eq 'login') {
        $command = Get-Command codex -ErrorAction Stop
        & $command.Source login
        $code = $LASTEXITCODE
    } elseif ($config.action -eq 'launch') {
        $plan = Get-RouterLaunchPlan $root $config
        if ($ValidateOnly) { $plan | ConvertTo-Json -Depth 5; $code = 0; return }
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        $loader = Join-Path $root 'node_modules\tsx\dist\loader.mjs'
        if (-not (Test-Path -LiteralPath $loader)) { throw 'Install dependencies first.' }
        $nodeArguments = $plan.arguments
        if ($desktop) {
            & $node @nodeArguments *> $outputPath
        } else {
            & $node @nodeArguments
        }
        $code = $LASTEXITCODE
    } else { throw 'Invalid action.' }
} catch {
    if ($desktop -and $outputPath) { $_.Exception.Message | Out-File -LiteralPath $outputPath -Encoding UTF8 }
    else { Write-Host ('操作未完成：' + $_.Exception.Message) -ForegroundColor Red }
    $code = 1
} finally {
    if ($outputPath) {
        @{ exitCode = $code; log = $outputPath } | ConvertTo-Json | Set-Content -LiteralPath ([IO.Path]::ChangeExtension($ConfigPath, '.result.json')) -Encoding UTF8
    }
    Remove-Item -LiteralPath $ConfigPath -Force -ErrorAction SilentlyContinue
}
if (-not $desktop -and -not $ValidateOnly) { Read-Host '按 Enter 关闭此窗口' | Out-Null }
exit $code

function Get-RouterLaunchPlan([string]$Root, $Config) {
    if ($Config.entry -notin @('cli', 'desktop', 'chat')) { throw 'Invalid entry.' }
    if ($Config.router -notin @('jev', 'rules', 'manual')) { throw 'Invalid router.' }
    if ($Config.mode -notin @('economy', 'balanced', 'quality')) { throw 'Invalid mode.' }
    if (-not (Test-Path -LiteralPath $Config.project -PathType Container)) { throw 'Project folder not found.' }
    if ($Config.entry -eq 'chat' -and ($Config.router -eq 'manual' -or $Config.record)) { throw 'Chat does not support these options.' }
    $arguments = @('--project', [string]$Config.project, '--mode', [string]$Config.mode)
    if ($Config.router -eq 'manual') { $arguments += '--manual' } else { $arguments += @('--router', [string]$Config.router) }
    if ($Config.entry -eq 'chat') {
        if ($Config.sandbox -notin @('read-only', 'workspace-write')) { throw 'Invalid permission.' }
        $arguments += @('--sandbox', [string]$Config.sandbox)
    }
    if ($Config.resume -and $Config.entry -ne 'desktop') {
        if ($Config.resume -notmatch '^[a-zA-Z0-9_-]{1,128}$') { throw 'Invalid session ID.' }
        $arguments += @('--resume', [string]$Config.resume)
    }
    $entry = Join-Path $Root ('src\' + $Config.entry + '.ts')
    if ($Config.record) { $entry = Join-Path $Root 'test\record-timing.ts'; $arguments = @([string]$Config.entry) + $arguments }
    $loader = Join-Path $Root 'node_modules\tsx\dist\loader.mjs'
    return @{ arguments = @('--import', ([Uri]$loader).AbsoluteUri, $entry) + $arguments;
        hidden = $Config.entry -eq 'desktop' -and -not $Config.record }
}

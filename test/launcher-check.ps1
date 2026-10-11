$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'launcher\launch-plan.ps1')
$checks = 0
foreach ($entryName in @('cli', 'desktop', 'chat')) {
    foreach ($routerName in @('jev', 'rules', 'manual')) {
        foreach ($modeName in @('economy', 'balanced', 'quality')) {
            foreach ($recordEnabled in @($false, $true)) {
                $config = @{ entry = $entryName; router = $routerName; mode = $modeName; project = $root;
                    record = $recordEnabled; sandbox = 'read-only'; resume = 'test-session' }
                $invalid = $entryName -eq 'chat' -and ($routerName -eq 'manual' -or $recordEnabled)
                try { $plan = Get-RouterLaunchPlan $root $config } catch { if ($invalid) { $checks++; continue }; throw }
                if ($invalid) { throw 'Unsupported chat configuration accepted.' }
                if (-not (Test-Path -LiteralPath $plan.arguments[2])) { throw 'Missing launch script.' }
                if ($plan.arguments -notcontains $modeName) { throw 'Mode was lost.' }
                if ($plan.hidden -ne ($entryName -eq 'desktop' -and -not $recordEnabled)) { throw 'Window policy wrong.' }
                if ($recordEnabled -and $plan.arguments[3] -ne $entryName) { throw 'Recorder target wrong.' }
                if ($routerName -eq 'manual') { if ($plan.arguments -notcontains '--manual') { throw 'Manual flag missing.' } }
                elseif ($plan.arguments -notcontains $routerName) { throw 'Router flag missing.' }
                if ($entryName -eq 'desktop' -and $plan.arguments -contains '--resume') { throw 'Desktop resume flag unsupported.' }
                if ($entryName -ne 'desktop' -and $plan.arguments -notcontains 'test-session') { throw 'Resume lost.' }
                $checks++
            }
        }
    }
}
Write-Output "Launch matrix: $checks configurations checked."
$working = Join-Path $root '.router-memory\launcher'
New-Item -ItemType Directory -Path $working -Force | Out-Null
$testProject = Join-Path $working 'project test & 中文'
New-Item -ItemType Directory -Path $testProject -Force | Out-Null
try {
    foreach ($entryName in @('cli', 'desktop', 'chat')) {
        $path = Join-Path $working ('probe-' + [Guid]::NewGuid().ToString('N') + '.json')
        $resultPath = [IO.Path]::ChangeExtension($path, '.result.json')
        try {
            @{ action = 'launch'; entry = $entryName; project = $testProject; router = 'rules'; mode = 'quality';
                sandbox = 'read-only'; record = $entryName -ne 'chat'; resume = '' } | ConvertTo-Json | Set-Content -LiteralPath $path -Encoding UTF8
            $text = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'launcher\runner.ps1') -ConfigPath $path -ValidateOnly
            if ($LASTEXITCODE -ne 0) { throw "Runner probe failed: $entryName" }
            $result = ($text -join "`n") | ConvertFrom-Json
            if ($result.arguments -notcontains $testProject) { throw 'Spaces, Unicode or special-character path lost.' }
            if (Test-Path -LiteralPath $path) { throw 'Launch config not cleaned up.' }
            if ((Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json).exitCode -ne 0) { throw 'Runner completion report incorrect.' }
        } finally { Remove-Item -LiteralPath $path,$resultPath -Force -ErrorAction SilentlyContinue }
    }
    Write-Output 'Runner: 3 subprocess probes passed; Unicode and special-character paths preserved.'
} finally { Remove-Item -LiteralPath $testProject -Force }
. (Join-Path $root 'launcher\launcher.ps1') -InspectOnly
try {
    if ($form.Controls.Count -lt 20) { throw 'Launcher controls missing.' }
    $entry.SelectedIndex = 0; $router.SelectedIndex = 2
    if ($mode.Enabled -or -not $record.Enabled -or $sandbox.Enabled) { throw 'CLI manual controls wrong.' }
    $record.Checked = $true; $entry.SelectedIndex = 2
    if ($router.SelectedIndex -ne 0 -or $record.Checked -or $record.Enabled -or -not $sandbox.Enabled) { throw 'Chat controls wrong.' }
    $entry.SelectedIndex = 1
    if ($resume.Enabled -or -not $record.Enabled -or $sandbox.Enabled) { throw 'Desktop controls wrong.' }
    Write-Output 'WinForms: construction and option-change handlers passed.'
} finally { $timer.Dispose(); $logMenu.Dispose(); $form.Dispose() }

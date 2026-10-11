param([switch]$InspectOnly)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$root = Split-Path -Parent $PSScriptRoot
$directory = Join-Path $root '.router-memory\launcher'
$script:desktopProcess = $null
$script:resultPath = $null

function Notice([string]$message) { [Windows.Forms.MessageBox]::Show($message, 'Codex Model Router') | Out-Null }
function KeyPresent {
    foreach ($scope in @('Process', 'User', 'Machine')) {
        $value = [Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', $scope)
        if (-not [string]::IsNullOrWhiteSpace($value)) { $env:TYPESAFE_API_KEY = $value; return $true }
    }
    return $false
}
function Run([hashtable]$config, [bool]$hidden = $false) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $path = Join-Path $directory ('launch-' + [Guid]::NewGuid().ToString('N') + '.json')
    $config | ConvertTo-Json | Set-Content -LiteralPath $path -Encoding UTF8
    # Only launcher-owned file paths enter the PowerShell command line. User values travel in JSON.
    $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'runner.ps1') + '" -ConfigPath "' + $path + '"'
    $style = if ($hidden) { 'Hidden' } else { 'Normal' }
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WorkingDirectory $root -WindowStyle $style -PassThru
    if ($hidden) {
        $script:desktopProcess = $process
        $script:resultPath = [IO.Path]::ChangeExtension($path, '.result.json')
        $start.Enabled = $false
        $status.Text = '正在启动桌面应用，请稍候…'
        $timer.Start()
    } else { $status.Text = '已打开操作窗口，请在新窗口中继续。' }
}
function Label([string]$text, [int]$y) {
    $control = New-Object Windows.Forms.Label
    $control.Text = $text; $control.Location = New-Object Drawing.Point(24, $y)
    $control.Size = New-Object Drawing.Size(610, 26)
    $form.Controls.Add($control)
}
function Combo([int]$y, [string[]]$items, [int]$selected = 0) {
    $control = New-Object Windows.Forms.ComboBox
    $control.DropDownStyle = 'DropDownList'; $control.Location = New-Object Drawing.Point(24, $y)
    $control.Size = New-Object Drawing.Size(610, 30)
    $control.Items.AddRange($items); $control.SelectedIndex = $selected
    $form.Controls.Add($control); return $control
}
function Button([string]$text, [int]$x, [int]$y, [int]$width = 140) {
    $control = New-Object Windows.Forms.Button
    $control.Text = $text; $control.Location = New-Object Drawing.Point($x, $y)
    $control.Size = New-Object Drawing.Size($width, 36)
    $form.Controls.Add($control); return $control
}

$form = New-Object Windows.Forms.Form
$form.Text = 'Codex Model Router 启动器'
$form.ClientSize = New-Object Drawing.Size(660, 660)
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
$form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false

Label '选择开发项目（可以是 Router 之外的其他文件夹）' 18
$project = New-Object Windows.Forms.TextBox
$project.Location = New-Object Drawing.Point(24, 48); $project.Size = New-Object Drawing.Size(475, 30); $project.Text = $root
$form.Controls.Add($project)
$browse = Button '浏览…' 509 46 125
$browse.Add_Click({
    $picker = New-Object Windows.Forms.FolderBrowserDialog
    $picker.Description = '选择要使用 Codex 的项目'; $picker.SelectedPath = $project.Text
    if ($picker.ShowDialog() -eq 'OK') { $project.Text = $picker.SelectedPath }
    $picker.Dispose()
})

Label '使用入口' 94
$entry = Combo 123 @('原版 Codex CLI', '桌面版（实验入口）', '简易连续聊天') 1
Label '模型选择方式' 163
$router = Combo 192 @('Jev 在线判断', '本地规则（无需 Jev Key）', '手动选择模型（仅 CLI / 桌面）')
Label '路由模式' 232
$mode = Combo 261 @('节省优先 — economy', '平衡 — balanced', '质量优先 — quality') 1
Label '项目权限（简易聊天入口）' 301
$sandbox = Combo 330 @('只读 — read-only', '允许修改项目 — workspace-write')
Label '恢复会话 ID（可选；桌面入口在应用中选择旧会话）' 370
$resume = New-Object Windows.Forms.TextBox
$resume.Location = New-Object Drawing.Point(24, 399); $resume.Size = New-Object Drawing.Size(610, 30)
$form.Controls.Add($resume)
$record = New-Object Windows.Forms.CheckBox
$record.Text = '记录每轮耗时与 Token 用量到 test/log（需保持记录窗口打开）'
$record.Location = New-Object Drawing.Point(24, 441); $record.Size = New-Object Drawing.Size(610, 30)
$form.Controls.Add($record)
$keyLabel = New-Object Windows.Forms.Label
$keyLabel.Location = New-Object Drawing.Point(24, 486); $keyLabel.Size = New-Object Drawing.Size(610, 26)
$form.Controls.Add($keyLabel)
function RefreshKey { $keyLabel.Text = if (KeyPresent) { 'Jev Key：已配置（此处只检查是否存在）' } else { 'Jev Key：未配置。可本次输入，或选择本地规则。' } }
RefreshKey
$key = Button '本次输入 Jev Key' 24 517 170
$install = Button '安装依赖' 204 517 130
$login = Button '登录 Codex' 344 517 130
$logs = Button '打开日志目录' 484 517 150
$start = Button '启动 Router' 24 568 610
$status = New-Object Windows.Forms.Label
$status.Location = New-Object Drawing.Point(24, 612); $status.Size = New-Object Drawing.Size(610, 42)
$status.Text = '桌面入口需要先完全退出桌面应用。CLI 和简易聊天会打开交互终端。'
$form.Controls.Add($status)
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
    if ($script:desktopProcess -and $script:desktopProcess.HasExited) {
        $timer.Stop(); $start.Enabled = $true
        try {
            $result = Get-Content -LiteralPath $script:resultPath -Raw | ConvertFrom-Json
            if ($result.exitCode -eq 0) { $status.Text = '桌面启动请求已完成。请在应用中进入所选项目的本地 Codex 会话。' }
            else { $status.Text = '启动失败。'; Notice ('桌面未能启动。请检查登录、依赖和桌面是否已完全退出。' + "`n`n" + (Get-Content -LiteralPath $result.log -Raw)) }
        } catch { $status.Text = '启动进程已退出，未收到完整结果。请打开“启动日志”检查。' }
        $script:desktopProcess.Dispose(); $script:desktopProcess = $null
    }
})
function UpdateControls {
    $chat = $entry.SelectedIndex -eq 2
    if ($chat -and $router.SelectedIndex -eq 2) { $router.SelectedIndex = 0 }
    $sandbox.Enabled = $chat; $resume.Enabled = $entry.SelectedIndex -ne 1
    $mode.Enabled = $router.SelectedIndex -ne 2
    $record.Enabled = -not $chat
    if ($chat) { $record.Checked = $false }
}
$entry.Add_SelectedIndexChanged({ UpdateControls })
$router.Add_SelectedIndexChanged({ UpdateControls })
UpdateControls
$key.Add_Click({
    $dialog = New-Object Windows.Forms.Form
    $dialog.Text = '仅供本次启动使用'; $dialog.ClientSize = New-Object Drawing.Size(440, 145)
    $dialog.StartPosition = 'CenterParent'; $dialog.Font = $form.Font
    $text = New-Object Windows.Forms.TextBox
    $text.UseSystemPasswordChar = $true; $text.Location = New-Object Drawing.Point(20, 22); $text.Size = New-Object Drawing.Size(400, 30)
    $ok = New-Object Windows.Forms.Button
    $ok.Text = '使用此 Key'; $ok.Location = New-Object Drawing.Point(20, 70); $ok.Size = New-Object Drawing.Size(180, 36); $ok.DialogResult = 'OK'
    $dialog.Controls.AddRange(@($text, $ok)); $dialog.AcceptButton = $ok
    if ($dialog.ShowDialog($form) -eq 'OK' -and -not [string]::IsNullOrWhiteSpace($text.Text)) { $env:TYPESAFE_API_KEY = $text.Text.Trim(); RefreshKey }
    $text.Clear(); $dialog.Dispose()
})
$install.Add_Click({ try { Run @{ action = 'install' } } catch { Notice $_.Exception.Message } })
$login.Add_Click({ try { Run @{ action = 'login' } } catch { Notice $_.Exception.Message } })
function OpenFolder([string]$path) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    Start-Process explorer.exe -ArgumentList ('"' + $path + '"')
}
$logMenu = New-Object Windows.Forms.ContextMenuStrip
$timingItem = $logMenu.Items.Add('每轮耗时与 Token 日志')
$timingItem.Add_Click({ OpenFolder (Join-Path $root 'test\log') })
$startupItem = $logMenu.Items.Add('启动日志')
$startupItem.Add_Click({ OpenFolder $directory })
$logs.Add_Click({ $logMenu.Show($logs, (New-Object Drawing.Point(0, $logs.Height))) })
$start.Add_Click({
    try {
        if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw '请先安装 Node.js，再重新打开启动器。' }
        if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\tsx\dist\loader.mjs'))) { throw '请先点击“安装依赖”，安装成功后再启动。' }
        if (-not (Test-Path -LiteralPath $project.Text -PathType Container)) { throw '请选择一个存在的项目文件夹。' }
        if ($router.SelectedIndex -eq 0 -and -not (KeyPresent)) { throw 'Jev Key 尚未配置。请点击“本次输入 Jev Key”，或选择本地规则。' }
        $target = @('cli', 'desktop', 'chat')[$entry.SelectedIndex]
        if ($target -eq 'desktop' -and @(Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -or $_.ProcessName -eq 'ChatGPT' }).Count -gt 0) { throw '请先完全退出桌面应用（包括托盘），然后再启动。' }
        if ($resume.Enabled -and $resume.Text.Trim() -and $resume.Text.Trim() -notmatch '^[a-zA-Z0-9_-]{1,128}$') { throw '会话 ID 格式不正确。' }
        $config = @{ action = 'launch'; entry = $target; project = (Resolve-Path -LiteralPath $project.Text).Path;
            router = @('jev', 'rules', 'manual')[$router.SelectedIndex]; mode = @('economy', 'balanced', 'quality')[$mode.SelectedIndex];
            sandbox = @('read-only', 'workspace-write')[$sandbox.SelectedIndex]; record = $record.Checked;
            resume = $(if ($resume.Enabled) { $resume.Text.Trim() } else { '' }) }
        Run $config ($target -eq 'desktop' -and -not $record.Checked)
    } catch { Notice $_.Exception.Message }
})
$form.Add_FormClosed({ $timer.Stop(); $timer.Dispose(); $logMenu.Dispose() })
if (-not $InspectOnly) {
    try { [Windows.Forms.Application]::Run($form) } finally { $form.Dispose() }
}

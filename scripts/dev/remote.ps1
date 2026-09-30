param(
    [ValidateSet('exec', 'pull', 'status', 'tunnel')][string]$Action = 'exec',
    [string]$Command,
    [string]$ScriptFile,
    [string]$ConfigFile
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (-not $ConfigFile) { $ConfigFile = Join-Path $workspace '.tools/remote/connection.json' }
$connection = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
if (-not $connection.destination -or -not $connection.root -or -not $connection.identityFile) {
    throw 'connection.json requires destination, root and identityFile.'
}
$sshProgram = if ($IsWindows) { Join-Path $env:WINDIR 'System32/OpenSSH/ssh.exe' } else { 'ssh' }
$sshProcessInfo = [Diagnostics.ProcessStartInfo]::new()
$sshProcessInfo.FileName = $sshProgram
$sshProcessInfo.UseShellExecute = $false
$sshProcessInfo.CreateNoWindow = $true
foreach ($sshArgument in @('-i', $connection.identityFile, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3')) {
    $sshProcessInfo.ArgumentList.Add($sshArgument)
}
if ($Action -eq 'tunnel') {
    $sshProcessInfo.ArgumentList.Add('-N')
    $sshProcessInfo.ArgumentList.Add('-o')
    $sshProcessInfo.ArgumentList.Add('ExitOnForwardFailure=yes')
    foreach ($forward in $connection.forwards) {
        $sshProcessInfo.ArgumentList.Add('-L')
        $sshProcessInfo.ArgumentList.Add("127.0.0.1:$($forward.local):127.0.0.1:$($forward.remote)")
    }
    $sshProcessInfo.ArgumentList.Add($connection.destination)
} else {
    if ($Action -eq 'pull') { $Command = 'git pull --ff-only' }
    if ($Action -eq 'status') { $Command = 'git status --short; git log -1 --oneline' }
    if ($ScriptFile) { $Command = Get-Content -LiteralPath $ScriptFile -Raw }
    if (-not $Command) { throw 'Provide -Command or -ScriptFile.' }
    $escapedSingleQuote = [string][char]39 + [char]34 + [char]39 + [char]34 + [char]39
    $quotedRoot = "'" + $connection.root.Replace("'", $escapedSingleQuote) + "'"
    # Write exact LF bytes instead of PowerShell's native pipeline CRLF suffix.
    $remoteScript = "set -e`ncd -- $quotedRoot`nsource scripts/dev/remote-env.sh`n" + $Command.Replace("`r`n", "`n") + "`n"
    $sshProcessInfo.RedirectStandardInput = $true
    $sshProcessInfo.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $sshProcessInfo.ArgumentList.Add($connection.destination)
    $sshProcessInfo.ArgumentList.Add('bash -s')
}
$sshProcess = [Diagnostics.Process]::Start($sshProcessInfo)
if ($Action -ne 'tunnel') {
    $sshProcess.StandardInput.Write($remoteScript)
    $sshProcess.StandardInput.Close()
}
$sshProcess.WaitForExit()
exit $sshProcess.ExitCode

param(
 [ValidateSet('tunnel','backup')][string]$Action = 'tunnel',
 [ValidateSet('dataset','review','all')][string]$Scope = 'all',
 [int]$LocalPort = 4190
)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$connection = Get-Content -LiteralPath (Join-Path $workspace '.tools/remote/connection.json') -Raw | ConvertFrom-Json
function New-SshProcessInfo([string]$program) {
 $info = [Diagnostics.ProcessStartInfo]::new()
 $info.FileName = Join-Path $env:WINDIR "System32/OpenSSH/$program.exe"
 $info.UseShellExecute = $false
 $info.CreateNoWindow = $true
 foreach ($arg in @('-i',$connection.identityFile,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes')) { $info.ArgumentList.Add($arg) }
 return $info
}
if ($Action -eq 'tunnel') {
 if ($LocalPort -lt 1024 -or $LocalPort -gt 65535) { throw 'Choose a port between 1024 and 65535.' }
 $info = New-SshProcessInfo 'ssh'
 $forward = '127.0.0.1:' + $LocalPort + ':127.0.0.1:7119'
 foreach ($arg in @('-N','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30','-L',$forward,$connection.destination)) { $info.ArgumentList.Add($arg) }
 $proc = [Diagnostics.Process]::Start($info)
 Write-Output "Teacher review: http://127.0.0.1:$LocalPort"
 $proc.WaitForExit()
 exit $proc.ExitCode
}
$command = "services/sdxl-region-sidecar/.venv/bin/python tools/teacher-loop/backup.py --scope $Scope"
$raw = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'remote.ps1') -Command $command
if ($LASTEXITCODE -ne 0) { throw 'Remote backup creation failed.' }
$receipt = ($raw -join [Environment]::NewLine) | ConvertFrom-Json
if (-not $receipt.path.StartsWith($connection.root + '/.tools/cache/teacher-loop-backups/') -or $receipt.id -notmatch '^backup-[a-zA-Z0-9-]+$') { throw 'Unexpected backup path.' }
$directory = Join-Path $workspace ('output/teacher-loop-backups/' + $receipt.id)
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$archive = Join-Path $directory ($receipt.id + '.tar')
$info = New-SshProcessInfo 'scp'
$info.ArgumentList.Add($connection.destination + ':' + $receipt.path)
$info.ArgumentList.Add($archive)
$proc = [Diagnostics.Process]::Start($info)
$proc.WaitForExit()
if ($proc.ExitCode -ne 0) { throw 'Backup transfer failed.' }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $receipt.sha256) { throw 'Backup hash mismatch.' }
$receipt | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $directory 'receipt.json')
Write-Output "Verified backup: $archive"

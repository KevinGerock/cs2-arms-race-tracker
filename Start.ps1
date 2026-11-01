$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'settings.json'))) {
    & (Join-Path $PSScriptRoot 'Setup.ps1')
}
$settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'settings.json') -Raw | ConvertFrom-Json
$statusUrl = "http://127.0.0.1:$($settings.port)/status"
try { $status = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 2 } catch { $status = $null }
if ($status -and $status.service -eq 'armsrace-counter' -and $status.steamid -eq $settings.steamid) {
    Write-Host "Der Empfaenger laeuft bereits. Gespeicherte Siege: $($status.winsSinceInstallation)"
    exit
}
if ($status -and $status.service -eq 'armsrace-counter' -and $status.steamid -ne $settings.steamid) {
    throw 'Es laeuft bereits ein Empfaenger fuer einen anderen Steam-Account. Bitte diesen zuerst mit dessen Stop.cmd beenden.'
}
$nodePath = Join-Path $PSScriptRoot 'runtime/node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) { $nodePath = (Get-Command node.exe).Source }
$dataDir = Join-Path $PSScriptRoot 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$receiverScript = Join-Path $PSScriptRoot 'counter.cjs'
$receiverProcess = Start-Process -FilePath $nodePath -ArgumentList ('"{0}"' -f $receiverScript) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'receiver.log') -RedirectStandardError (Join-Path $dataDir 'receiver-error.log') -PassThru
[IO.File]::WriteAllText((Join-Path $dataDir 'receiver.pid'), [string]$receiverProcess.Id)
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 100
    try { $status = Invoke-RestMethod -Uri $statusUrl -TimeoutSec 1 } catch { $status = $null }
    if ($status -and $status.service -eq 'armsrace-counter' -and $status.steamid -eq $settings.steamid) {
        Write-Host "Empfaenger laeuft im Hintergrund. Gespeicherte Siege: $($status.winsSinceInstallation)" -ForegroundColor Green
        Write-Host 'Dieses Fenster darf geschlossen werden. Status.cmd zeigt den Stand; Stop.cmd beendet den Empfaenger.'
        exit
    }
    if ($receiverProcess.HasExited) { break }
}
throw 'Empfaenger nicht erreichbar. Details stehen in data/receiver-error.log.'

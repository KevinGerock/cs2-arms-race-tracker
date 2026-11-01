$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'data/receiver.pid'
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host 'Kein Hintergrundempfaenger verzeichnet. Ein offenes Start-Fenster bitte schliessen.'
    exit
}
$receiverPid = [int](Get-Content -LiteralPath $pidFile -Raw)
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$receiverPid"
$scriptPath = Join-Path $PSScriptRoot 'counter.cjs'
if ($process -and $process.Name -eq 'node.exe' -and $process.CommandLine.Contains($scriptPath)) {
    Stop-Process -Id $receiverPid
    Write-Host 'Hintergrundempfaenger beendet. Gespeicherte Siege bleiben erhalten.'
} elseif ($process) {
    throw 'Die gespeicherte Prozess-ID gehoert inzwischen zu einem anderen Programm. Nichts beendet.'
} else {
    Write-Host 'Der Hintergrundempfaenger ist bereits beendet.'
}

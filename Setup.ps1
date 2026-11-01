param([string]$Cs2CfgPath, [string]$SteamId)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime/node.exe')) -and -not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Node.js fehlt. Bitte das portable Paket verwenden oder Node.js 20 oder neuer installieren.' }
if (-not $Cs2CfgPath) {
    $steamRoot = (Get-ItemProperty -LiteralPath 'HKCU:/Software/Valve/Steam').SteamPath
    $libraries = @($steamRoot)
    $libraryFile = Join-Path $steamRoot 'steamapps/libraryfolders.vdf'
    if (Test-Path -LiteralPath $libraryFile) {
        $libraries += [regex]::Matches([IO.File]::ReadAllText($libraryFile), '"path"\s+"([^"]+)"') |
            ForEach-Object { $_.Groups[1].Value.Replace('\\', '\') }
    }
    foreach ($library in ($libraries | Select-Object -Unique)) {
        $manifest = Join-Path $library 'steamapps/appmanifest_730.acf'
        if (-not (Test-Path -LiteralPath $manifest)) { continue }
        $match = [regex]::Match([IO.File]::ReadAllText($manifest), '"installdir"\s+"([^"]+)"')
        if ($match.Success) {
            $candidate = Join-Path $library ('steamapps/common/' + $match.Groups[1].Value + '/game/csgo/cfg')
            if (Test-Path -LiteralPath $candidate) { $Cs2CfgPath = $candidate; break }
        }
    }
}
if (-not $Cs2CfgPath -or -not (Test-Path -LiteralPath $Cs2CfgPath -PathType Container)) { throw 'CS2-Konfigurationsordner nicht gefunden.' }
$settingsPath = Join-Path $PSScriptRoot 'settings.json'
if (Test-Path -LiteralPath $settingsPath) {
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
} else {
    if (-not $SteamId) {
        $activeUser = (Get-ItemProperty -LiteralPath 'HKCU:/Software/Valve/Steam/ActiveProcess' -ErrorAction SilentlyContinue).ActiveUser
        if ($activeUser -and [uint64]$activeUser -gt 0) { $SteamId = [string]([uint64]76561197960265728 + [uint64]$activeUser) }
    }
    if ($SteamId -notmatch '^\d{17}$') { throw 'Steam-Account nicht erkannt. Bitte zuerst in Steam anmelden oder Setup.ps1 -SteamId DEINE_STEAMID64 verwenden.' }
    $settings = [pscustomobject]@{steamid=$SteamId; port=37651; token=[guid]::NewGuid().ToString('N')}
}
if ($SteamId -and $SteamId -ne $settings.steamid) {
    if ($SteamId -notmatch '^\d{17}$') { throw 'Ungueltige SteamID64.' }
    if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'data/state.json')) { throw 'Dieser Ordner enthaelt bereits Daten fuer einen anderen Account. Bitte fuer den neuen Account einen frischen Programmordner verwenden.' }
    $settings.steamid = $SteamId
}
$settings | Add-Member -NotePropertyName excludePractice -NotePropertyValue $true -Force
$settings | Add-Member -NotePropertyName consoleLog -NotePropertyValue (Join-Path (Split-Path -Parent $Cs2CfgPath) 'console.log') -Force
$settingsJson = $settings | ConvertTo-Json
$cfg = @"
"Arms Race Local Counter"
{
    "uri" "http://127.0.0.1:$($settings.port)/gsi"
    "timeout" "5.0"
    "buffer" "0.1"
    "throttle" "0.1"
    "heartbeat" "5.0"
    "auth" { "token" "$($settings.token)" }
    "data"
    {
        "provider" "1"
        "map" "1"
        "round" "1"
        "player_id" "1"
        "player_match_stats" "1"
        "player_state" "1"
        "player_weapons" "1"
        "map_round_wins" "1"
        "phase_countdowns" "1"
    }
}
"@
$target = Join-Path $Cs2CfgPath 'gamestate_integration_armsrace_counter.cfg'
if ((Test-Path -LiteralPath $target) -and [IO.File]::ReadAllText($target) -ne $cfg) {
    $backup = $target + '.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Copy-Item -LiteralPath $target -Destination $backup
}
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText($settingsPath, $settingsJson, $utf8)
[IO.File]::WriteAllText($target, $cfg, $utf8)
Write-Host "Live-Daten eingerichtet: $target" -ForegroundColor Green
Write-Host 'Jetzt den Zaehler mit Start.cmd starten und CS2 vollstaendig neu starten.'
Write-Host 'Status.cmd zeigt den Siegstand und die erkannte Verbindungsart.'
Write-Host 'Fuer den Uebungsfilter muss in den Steam-Startoptionen von CS2 -condebug stehen.'

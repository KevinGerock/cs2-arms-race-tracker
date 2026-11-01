param([switch]$IncludeRuntime,[string]$Destination,[string]$WorkDirectory)
$ErrorActionPreference = 'Stop'
if (-not $Destination) { $Destination=Join-Path (Split-Path -Parent $PSScriptRoot) $(if($IncludeRuntime){'ArmsRaceTracker-Windows.zip'}else{'ArmsRaceTracker-Source.zip'}) }
if (-not $WorkDirectory) { $WorkDirectory=Join-Path ([IO.Path]::GetTempPath()) ('armsrace-package-'+[guid]::NewGuid().ToString('N')) }
$stage=Join-Path $WorkDirectory ('package-'+[guid]::NewGuid().ToString('N')+'/ArmsRaceTracker')
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$files=@('.gitignore','README.md','LICENSE','Anleitung.txt','QuickStart.txt','package.json','counter.cjs','connection-log.cjs','Setup.ps1','Setup.cmd','Start.ps1','Start.cmd','Stop.ps1','Stop.cmd','Status.cmd','Build.ps1','Package.ps1','app/TrackerApp.cs','app/Translations.cs','app/MainWindow.xaml','app/HudWindow.xaml','app/Theme.xaml','tests/counter.test.cjs','tests/localization.test.cjs','tests/ui.test.ps1')
$files += Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'app/languages') -Filter '*.json' -File | ForEach-Object { 'app/languages/' + $_.Name }
if($IncludeRuntime){$files+=@('ArmsRaceTracker.exe','runtime/node.exe','runtime/LICENSE-nodejs.txt')}
foreach($file in $files){
    $source=Join-Path $PSScriptRoot $file
    if(-not(Test-Path -LiteralPath $source -PathType Leaf)){throw "Datei fehlt: $file"}
    $target=Join-Path $stage $file
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target
}
Compress-Archive -LiteralPath $stage -DestinationPath $Destination -Force
Write-Host "Paket ohne persoenliche Daten erstellt: $Destination"

$ErrorActionPreference = 'Stop'
$framework = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework 4.x mit WPF wird benoetigt.' }
$references = @('System.dll','System.Core.dll','System.Xaml.dll','System.Net.Http.dll','System.Web.Extensions.dll','System.Windows.Forms.dll','System.Drawing.dll') | ForEach-Object { '/reference:' + (Join-Path $framework $_) }
$references += @('PresentationFramework.dll','PresentationCore.dll','WindowsBase.dll') | ForEach-Object { '/reference:' + (Join-Path $framework ('WPF/' + $_)) }
& $compiler /nologo /target:winexe /platform:x64 /optimize+ ('/out:' + (Join-Path $PSScriptRoot 'ArmsRaceTracker.exe')) $references (Join-Path $PSScriptRoot 'app/TrackerApp.cs')
if ($LASTEXITCODE -ne 0) { throw 'GUI konnte nicht kompiliert werden.' }
Write-Host 'ArmsRaceTracker.exe gebaut.'

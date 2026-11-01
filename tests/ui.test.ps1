param([string]$ApplicationRoot, [string]$WorkDirectory, [string]$ScreenshotDirectory)
$ErrorActionPreference = 'Stop'
if (-not $ApplicationRoot) { $ApplicationRoot = Split-Path -Parent $PSScriptRoot }
if (-not $WorkDirectory) { $WorkDirectory = Join-Path ([IO.Path]::GetTempPath()) ('armsrace-ui-test-' + [guid]::NewGuid().ToString('N')) }
New-Item -ItemType Directory -Path $WorkDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $ApplicationRoot 'app') -Destination $WorkDirectory -Recurse
Add-Type -AssemblyName PresentationFramework
$assembly = [Reflection.Assembly]::LoadFrom((Join-Path $ApplicationRoot 'ArmsRaceTracker.exe'))
$type = $assembly.GetType('ArmsRaceTracker.TrackerUi',$true)
$flags = [Reflection.BindingFlags]'Instance,NonPublic'
function New-TestUi {
    [Activator]::CreateInstance($type,[Reflection.BindingFlags]'Instance,Public,NonPublic',$null,[object[]]@($WorkDirectory),[Globalization.CultureInfo]::InvariantCulture)
}
function Assert-Equal($Actual,$Expected,$Label) { if ($Actual -ne $Expected) { throw ($Label + ': expected ' + $Expected + ', received ' + $Actual) } }
$ui = New-TestUi
$main = $type.GetField('main',$flags).GetValue($ui)
$hud = $type.GetField('hud',$flags).GetValue($ui)
$combo = $main.FindName('LanguageSelector')
Assert-Equal $combo.SelectedItem.code 'en' 'English is the default'
Assert-Equal $main.Title 'Arms Race Tracker' 'English title'
$snapshot = '{"stats":{"wins":4,"practiceExcluded":2,"completedMatches":1},"status":{"lastReceived":"2000-01-01T00:00:00Z","steamid":"test","connection":{"type":"online"}},"history":[{"map":"ar_shoots_night","outcome":"win","endedAt":"2026-11-01T20:00:00Z","kills":30,"deaths":20}],"lastWin":{"map":"ar_shoots_night","endedAt":"2026-11-01T20:00:00Z"}}'
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$summary = $serializer.DeserializeObject($snapshot)
$null = $type.GetMethod('Update',$flags).Invoke($ui,[object[]]@($summary))
$font = New-Object Windows.Media.Typeface('Segoe UI')
$glyph = $null
if (-not $font.TryGetGlyphTypeface([ref]$glyph)) { throw 'Segoe UI font not available' }
foreach ($codepoint in @(0x00E6,0x00F8,0x00E5,0x00C6,0x00D8,0x00C5)) {
    if (-not $glyph.CharacterToGlyphMap.ContainsKey($codepoint)) { throw ('Missing Danish glyph: U+' + $codepoint.ToString('X4')) }
}
foreach ($pack in $combo.Items) {
    $combo.SelectedItem = $pack
    Assert-Equal $main.Title $pack.strings['appTitle'] ('Window title: ' + $pack.code)
    Assert-Equal $hud.Title $pack.strings['hudTitle'] ('HUD title: ' + $pack.code)
    Assert-Equal $main.FindName('CurrentMap').Text $pack.strings['waitingForCs2'] ('Status: ' + $pack.code)
    Assert-Equal $main.FindName('LastWinMap').Text $pack.strings['mapShootsNight'] ('Map: ' + $pack.code)
    Assert-Equal $main.FindName('WinNumber').Text '04' ('Count retained: ' + $pack.code)
    foreach ($value in $pack.strings.Values) { foreach ($character in $value.ToCharArray()) {
        if ([int]$character -gt 127 -and -not $glyph.CharacterToGlyphMap.ContainsKey([int]$character)) { throw ('Missing font glyph: U+' + ([int]$character).ToString('X4')) }
    } }
    foreach ($window in @($main,$hud)) {
        $visual = [Windows.FrameworkElement]$window.Content
        $visual.Width = $window.Width; $visual.Height = $window.Height
        $visual.Measure([Windows.Size]::new($window.Width,$window.Height))
        $visual.Arrange([Windows.Rect]::new(0,0,$window.Width,$window.Height)); $visual.UpdateLayout()
    }
    if ($ScreenshotDirectory) {
        New-Item -ItemType Directory -Path $ScreenshotDirectory -Force | Out-Null
        foreach ($entry in @(@{Name='GUI';Window=$main},@{Name='HUD';Window=$hud})) {
            $window = $entry.Window
            $visual = [Windows.FrameworkElement]$window.Content
            $visual.Width = $window.Width; $visual.Height = $window.Height
            $visual.Measure([Windows.Size]::new($window.Width,$window.Height))
            $visual.Arrange([Windows.Rect]::new(0,0,$window.Width,$window.Height)); $visual.UpdateLayout()
            $bitmap = New-Object Windows.Media.Imaging.RenderTargetBitmap([int]$window.Width,[int]$window.Height,96,96,[Windows.Media.PixelFormats]::Pbgra32)
            $bitmap.Render($visual)
            $encoder = New-Object Windows.Media.Imaging.PngBitmapEncoder
            $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
            $stream = [IO.File]::Create((Join-Path $ScreenshotDirectory ('ArmsRace-' + $entry.Name + '-' + $pack.code + '.png')))
            try { $encoder.Save($stream) } finally { $stream.Dispose() }
        }
    }
    Write-Output ('PASS: immediate language change and font coverage: ' + $pack.code)
}
$combo.SelectedItem = @($combo.Items | Where-Object code -eq 'da')[0]
$restored = New-TestUi
$restoredMain = $type.GetField('main',$flags).GetValue($restored)
Assert-Equal $restoredMain.FindName('LanguageSelector').SelectedItem.code 'da' 'Language restored after restart'
Write-Output 'PASS: saved language survives restart; English is the fresh-install default.'
$preferencesPath = Join-Path $WorkDirectory 'data/ui-settings.json'
$preferences = $serializer.DeserializeObject([IO.File]::ReadAllText($preferencesPath))
$preferences['language'] = 'not-installed'
[IO.File]::WriteAllText($preferencesPath,$serializer.Serialize($preferences),[Text.UTF8Encoding]::new($false))
$fallbackUi = New-TestUi
$fallbackMain = $type.GetField('main',$flags).GetValue($fallbackUi)
Assert-Equal $fallbackMain.FindName('LanguageSelector').SelectedItem.code 'en' 'Unknown language falls back to English'
Write-Output 'PASS: unknown saved language falls back to English.'

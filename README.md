# Arms Race Tracker

A local Windows tracker for Counter-Strike 2 Arms Race, with a desktop GUI and a compact HUD. The counter receives CS2 Game State Integration (GSI) data and excludes locally hosted practice matches using CS2 connection diagnostics.

**[Download for Windows](https://github.com/KevinGerock/cs2-arms-race-tracker/releases)** — choose `ArmsRaceTracker-Windows.zip`, extract the complete folder, then open `ArmsRaceTracker.exe`.

The interface defaults to **English**, including on non-English Windows installations. Choose **English**, **Deutsch**, or **Dansk** from the language selector in the window header. The window, HUD, tray menu, match history, status messages, map variants, and dates update immediately; your choice is saved. German uses CS2's mode name **Wettrüsten**. CS2's Danish localization calls the mode **Arms Race**.

English and German quick-start guides are included as `QuickStart.txt` and `Anleitung.txt`. This is an early release with limited live validation; see the detection details below.

## What it does

- Counts your own Arms Race wins when the game ends and your personal MVP count increases.
- Requires a recognized remote connection. Local loopback practice games are excluded, including practice wins.
- Keeps unverified match results separate from the win total.
- Shows the current map, tracked wins, ignored practice matches, and recent match history.
- Offers a movable, topmost HUD with an optional mouse click-through lock.
- Stores data locally. No Steam Web API key or external tracking service is required.

This tracks future matches while the receiver is running. It does not recover a historical Steam win total. This is an independent tool, not a Valve product.

## Portable Windows package

1. Extract the complete folder. Keep all files together.
2. Sign into your own Steam account and launch `ArmsRaceTracker.exe`. On first use, setup detects the active Steam account and your CS2 installation.
3. Add `-condebug` to **Steam → Counter-Strike 2 → Properties → Launch Options**, preserving any existing launch options.
4. Fully restart CS2 once so GSI and console logging become active.
5. Play online Arms Race. The receiver continues running if you close the GUI.

The portable package includes Node.js and its license. The source package requires Node.js 20.10 or newer on PATH. The GUI requires Windows x64 with .NET Framework 4.8/WPF, included on supported Windows 10/11 installations.

### HUD controls

| Action | Control |
| --- | --- |
| Switch between window and HUD | `Ctrl + Alt + H` |
| Lock/unlock HUD mouse click-through | `Ctrl + Alt + L` |
| Move HUD | Drag the unlocked HUD |
| Open window or unlock HUD | Tracker icon in the Windows notification area |
| Stop background receiver | `Stop.cmd` |

For reliable display above CS2, use **Fullscreen Windowed** in the game's display settings (**Vollbildfenster** in German), then click **Show HUD** or press `Ctrl + Alt + H`. Exclusive fullscreen can cover the HUD. The application displays this requirement below the match history. The HUD is an external desktop window; it does not inject into the game. Borderless visibility was verified with CS2 on the development machine. The last selected window/HUD view is restored when reopening the app.

HUD position and lock preference are saved. There is no automatic Windows login startup: after restarting Windows, open the GUI or `Start.cmd` again. If a keyboard shortcut is already used by another app, use the notification-area menu.

## Account and storage

Each portable folder belongs to one Steam account. A fresh download contains no account, token, or match data. `Setup.ps1` detects Steam's active account on first setup. An explicit account can be supplied with `Setup.ps1 -SteamId YOUR_STEAMID64`; an existing folder containing another account's data is refused.

`settings.json` holds the local Steam ID, a random GSI token, port, and console log path. `data/` contains the win state, local match snapshots, and UI preferences. Both paths are excluded from Git and release packages.

CS2 itself writes console output to `game/csgo/console.log` when `-condebug` is enabled. That file may include other console content. The tracker interprets only host/client connection-state lines and does not copy chat lines into its own files. GSI snapshots contain your own match statistics and equipment. No desktop video, audio, game-memory reads, or screen capture are used by the running tracker.

## Source build

```powershell
node --test tests/*.test.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File Build.ps1
powershell -NoProfile -STA -ExecutionPolicy Bypass -File tests/ui.test.ps1
```

`Build.ps1` uses the Windows .NET Framework C# compiler with explicit UTF-8 source encoding; no .NET SDK or npm dependencies are required. Run the WPF tests using Windows PowerShell 5.1 (`powershell.exe`), the same .NET Framework runtime as the application. Source: `counter.cjs`, `connection-log.cjs`, and `app/`. All icons are explicitly drawn geometry.

## Language packs

Translations live in `app/languages/*.json` as UTF-8. Every release includes the complete language-pack directory. Each pack has `code`, `nativeName`, `culture`, and a `strings` dictionary. To contribute a language, copy `en.json`, retain all keys and `{0}` format arguments, translate the values, and use the actual CS2 mode/map names for that language. New packs appear in the selector automatically. Missing keys fall back to English; an unknown saved language falls back to English too.

Dates follow the selected locale. The UI uses Windows' Segoe UI font, which includes German and Danish glyphs; the WPF tests verify every non-ASCII character in the shipped translations, including `æ`, `ø`, `å`, and `Å`. No transliteration, emoji flags, or Unicode symbols are used as icons.

## Detection and current validation

The GSI receiver accepts only the configured Steam account. A win requires observing a live Arms Race match, then gameover with an increased personal MVP count. Duplicate end packets and receiver restarts are deduplicated. Warmup, already-finished matches at receiver startup, other players, and other game modes do not produce wins.

Connection filtering recognizes CS2 host remote-connect events, client remote connections, and explicit remote changelevel reconnect jobs. Server map rotations preserve the existing connection type; a level-load event alone does not identify practice. Actual loopback connections exclude local practice matches. Missing or unrecognized connection evidence prevents adding a win to the total. Unknown results remain available in the match history for inspection.

Live validation confirmed genuine Arms Race wins were counted, reported losses were not counted, and won local practice matches were excluded. Captured connection logs and GSI results reproduce the corrected server-map-rotation filter; regression tests cover repeated rotations and online/practice transitions. Version 0.2.0 adds runtime language selection, locale-specific dates, UTF-8 language packs, and font-coverage tests. Native WPF rendering, live language switching, and HUD visibility above CS2 in Fullscreen Windowed mode were checked. Other screen setups still need broader testing.

## Sharing on GitHub

Publish the source files with `.gitignore`. Do not commit `settings.json`, `data/`, or `runtime/`. Build a separate release ZIP from the explicit file list in `Package.ps1`; do not ZIP your live working folder directly. The included runtime's third-party license must stay in portable releases.

## Reference

GSI interface reference: https://github.com/antonpup/CounterStrike2GSI. No code from that library is required by this implementation.

Project source is MIT-licensed. Node.js retains its own license and bundled third-party notices.

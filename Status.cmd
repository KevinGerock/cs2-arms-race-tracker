@echo off
powershell.exe -NoLogo -NoProfile -Command "try { Invoke-RestMethod 'http://127.0.0.1:37651/status' | ConvertTo-Json -Depth 6 } catch { Write-Host 'Der Empfaenger laeuft noch nicht. Start.cmd starten.' }"
pause

# Start the headless browser the e2e suite drives (CDP on 127.0.0.1:9333), unless it is already up.
#
# It is chrome-headless-shell (Chrome for Testing), not Edge. Since 2026-10-18:
# - headless Edge (--headless=new) gives every tab a window that shows in Alt+Tab (Chromium 359921643);
# - the private-desktop workaround made Edge crash at start (crashpad dumps on every launch, any profile,
#   any desktop name), after it had worked earlier the same day;
# - Edge runs a blank-password check per fresh profile, and ten bad logons lock the Windows account.
# The headless shell creates no windows at all and has no password manager, so none of that applies.
# Install it once (portable, no installer):
#   npx -y @puppeteer/browsers install chrome-headless-shell@stable --path C:\Thor\tools\chrome-headless-shell
# or point VALKYRIE_E2E_BROWSER at any chrome-headless-shell.exe.
#   powershell -NoProfile -File e2e/browser.ps1           start (or report it is running)
#   powershell -NoProfile -File e2e/browser.ps1 -Stop     stop it
param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$prof = Join-Path $env:LOCALAPPDATA 'valkyrie-e2e-shell'
if ($Stop) {
    Get-CimInstance Win32_Process -Filter "Name='chrome-headless-shell.exe'" |
        Where-Object { $_.CommandLine -like "*$prof*" } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
    'stopped'
    return
}
try { Invoke-RestMethod 'http://127.0.0.1:9333/json/version' -TimeoutSec 2 | Out-Null; 'already running'; return } catch {}
$exe = $env:VALKYRIE_E2E_BROWSER
if (-not $exe) {
    $exe = Get-ChildItem 'C:\Thor\tools\chrome-headless-shell' -Recurse -Filter 'chrome-headless-shell.exe' -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $exe -or -not (Test-Path $exe)) { throw 'chrome-headless-shell.exe not found: install it (see the header) or set VALKYRIE_E2E_BROWSER' }
New-Item -ItemType Directory -Force $prof | Out-Null
$shellArgs = @('--remote-debugging-port=9333', '--remote-allow-origins=*', "--user-data-dir=`"$prof`"",
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--disable-gpu',
    '--renderer-process-limit=2', 'about:blank')
Start-Process -FilePath $exe -ArgumentList $shellArgs -WindowStyle Hidden | Out-Null
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    try { Invoke-RestMethod 'http://127.0.0.1:9333/json/version' -TimeoutSec 2 | Out-Null; 'started'; return } catch {}
}
throw 'chrome-headless-shell did not come up on :9333'

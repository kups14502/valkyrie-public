# Start the headless Edge the e2e suite drives (CDP on 127.0.0.1:9333), unless it is already up.
# Runs on a private desktop: --headless=new on Windows still gives every tab a window that shows in
# Alt+Tab (Chromium 359921643), so a plain launch leaks windows onto the user's desktop.
# Uses one persistent profile whose Local State already caches Edge's blank-password check: every
# fresh profile costs one bad Windows logon, and ten in ten minutes lock the account.
#   powershell -NoProfile -File e2e/browser.ps1           start (or report it is running)
#   powershell -NoProfile -File e2e/browser.ps1 -Stop     stop it
param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$prof = Join-Path $env:LOCALAPPDATA 'valkyrie-lab-edge'
if ($Stop) {
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
        Where-Object { $_.CommandLine -like "*$prof*" } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
    'stopped'
    return
}
try { Invoke-RestMethod 'http://127.0.0.1:9333/json/version' -TimeoutSec 2 | Out-Null; 'already running'; return } catch {}
if (-not (Test-Path (Join-Path $prof 'Local State'))) {
    New-Item -ItemType Directory -Force $prof | Out-Null
    $age = ([ADSI]"WinNT://$env:COMPUTERNAME/$env:USERNAME,user").PasswordAge.Value
    $changed = [math]::Floor([DateTime]::UtcNow.AddSeconds(-$age).ToFileTimeUtc() / 10)
    $json = '{"password_manager":{"os_password_blank":false,"os_password_last_changed":"' + $changed + '"}}'
    [IO.File]::WriteAllText((Join-Path $prof 'Local State'), $json)
}
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ValkyrieE2eDesktop {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr sa);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
        uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    public static int Start(string desktop, string exe, string cmdLine) {
        var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si); si.lpDesktop = desktop;
        PROCESS_INFORMATION pi;
        if (!CreateProcess(exe, new System.Text.StringBuilder(cmdLine), IntPtr.Zero, IntPtr.Zero, false, 0,
                IntPtr.Zero, null, ref si, out pi))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        return pi.dwProcessId;
    }
}
'@
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$edgeArgs = @('--headless=new', '--disable-gpu', '--remote-debugging-port=9333', '--remote-allow-origins=*',
    "--user-data-dir=`"$prof`"", '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--mute-audio', '--renderer-process-limit=2', 'about:blank')
# The desktop lives while Edge has threads on it; this handle only has to outlast Edge's start.
$desk = [ValkyrieE2eDesktop]::CreateDesktop('valkyrie-e2e', [IntPtr]::Zero, [IntPtr]::Zero, 0, 0x10000000, [IntPtr]::Zero)
if ($desk -eq [IntPtr]::Zero) { throw "CreateDesktop failed: $([ComponentModel.Win32Exception]::new().Message)" }
try {
    [void][ValkyrieE2eDesktop]::Start('WinSta0\valkyrie-e2e', $edge, "`"$edge`" " + ($edgeArgs -join ' '))
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 250
        try { Invoke-RestMethod 'http://127.0.0.1:9333/json/version' -TimeoutSec 2 | Out-Null; 'started'; return } catch {}
    }
    throw 'headless Edge did not come up on :9333'
} finally { [void][ValkyrieE2eDesktop]::CloseDesktop($desk) }

param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath,
    [ValidateRange(0, 10)]
    [int]$LaunchDelaySeconds = 0
)

$ErrorActionPreference = 'Stop'
$applicationPath = (Resolve-Path -LiteralPath $ExecutablePath).Path
$existing = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $applicationPath })
if ($existing.Count -gt 0) {
    throw 'The test executable is already running. Use a separate test copy; existing application sessions will not be closed.'
}

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ImageConversionProcessTest {
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    public static IntPtr FindApplicationWindow(int processId) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hwnd, data) => {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            var title = new StringBuilder(256);
            GetWindowText(hwnd, title, title.Capacity);
            if (owner == processId && title.ToString() == "Image Conversion") {
                found = hwnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@

function Wait-Until([scriptblock]$Condition, [int]$TimeoutSeconds = 15) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (& $Condition) { return $true }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Get-TestProcesses {
    @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $applicationPath })
}

$started = [System.Collections.Generic.List[int]]::new()
$children = @()
$failures = [System.Collections.Generic.List[string]]::new()
$previousUserDataFolder = $env:WEBVIEW2_USER_DATA_FOLDER
$testUserDataFolder = Join-Path ([System.IO.Path]::GetTempPath()) "ImageConversion-process-test-$([Guid]::NewGuid())"
[void][System.IO.Directory]::CreateDirectory($testUserDataFolder)
$env:WEBVIEW2_USER_DATA_FOLDER = $testUserDataFolder
try {
    $first = Start-Process -FilePath $applicationPath -WindowStyle Hidden -PassThru
    $started.Add($first.Id)
    $ready = Wait-Until {
        $window = [ImageConversionProcessTest]::FindApplicationWindow($first.Id)
        $window -ne [IntPtr]::Zero -and [ImageConversionProcessTest]::IsWindowVisible($window)
    }
    if (-not $ready) { throw 'The first instance did not create a window.' }
    if ($LaunchDelaySeconds -gt 0) { Start-Sleep -Seconds $LaunchDelaySeconds }
    $firstWindow = [ImageConversionProcessTest]::FindApplicationWindow($first.Id)
    [void][ImageConversionProcessTest]::ShowWindow($firstWindow, 6)
    if (-not (Wait-Until { [ImageConversionProcessTest]::IsIconic($firstWindow) } 3)) {
        throw 'The first window could not be minimized for the restore check.'
    }

    $second = Start-Process -FilePath $applicationPath -WindowStyle Hidden -PassThru
    $started.Add($second.Id)
    $secondaryExited = Wait-Until { -not (Get-Process -Id $second.Id -ErrorAction SilentlyContinue) } 5
    $instances = @(Get-TestProcesses)
    Write-Output "Instances after repeated launch: $($instances.Count) (expected 1)"
    if (-not $secondaryExited -or $instances.Count -ne 1 -or $instances[0].ProcessId -ne $first.Id) {
        $failures.Add('Repeated launch leaves an additional application process running.')
    }
    $restored = Wait-Until { -not [ImageConversionProcessTest]::IsIconic($firstWindow) } 3
    Write-Output "Repeated launch restores the existing minimized window: $restored"
    if (-not $restored) { $failures.Add('Repeated launch does not restore the existing window.') }

    # Capture only descendants of processes launched by this test, never other WebView apps.
    $snapshot = @(Get-CimInstance Win32_Process)
    $owned = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($processId in $started) { [void]$owned.Add($processId) }
    do {
        $added = $false
        foreach ($process in $snapshot) {
            if ($owned.Contains([int]$process.ParentProcessId) -and $owned.Add([int]$process.ProcessId)) { $added = $true }
        }
    } while ($added)
    $children = @($snapshot | Where-Object { $owned.Contains([int]$_.ProcessId) -and $_.Name -eq 'msedgewebview2.exe' })
    Write-Output "Owned WebView2 processes before close: $($children.Count)"
    if ($children.Count -eq 0) { $failures.Add('No isolated WebView2 child processes were observed; the lifecycle check is incomplete.') }
} finally {
    foreach ($process in @(Get-TestProcesses)) {
        $window = [ImageConversionProcessTest]::FindApplicationWindow($process.ProcessId)
        if ($window -ne [IntPtr]::Zero) {
            [void][ImageConversionProcessTest]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
        }
    }
    $closed = Wait-Until { @(Get-TestProcesses).Count -eq 0 }
    Write-Output "Application exits after closing its window: $closed"
    if (-not $closed) {
        $failures.Add('An application process remains after closing its window.')
        # Cleanup is restricted to this test's exact executable path.
        Get-TestProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
    }
    $childrenClosed = Wait-Until {
        @($children | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).Count -eq 0
    }
    Write-Output "Owned WebView2 processes exit after close: $childrenClosed"
    if (-not $childrenClosed) { $failures.Add('Owned WebView2 processes remain after application exit.') }
    $env:WEBVIEW2_USER_DATA_FOLDER = $previousUserDataFolder
    # Delete only the unique test profile created above, after its processes have exited.
    $resolvedTestFolder = [System.IO.Path]::GetFullPath($testUserDataFolder)
    $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($closed -and $childrenClosed -and $resolvedTestFolder.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and
        [System.IO.Path]::GetFileName($resolvedTestFolder).StartsWith('ImageConversion-process-test-')) {
        Remove-Item -LiteralPath $resolvedTestFolder -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($failures.Count -gt 0) { throw ($failures -join [Environment]::NewLine) }
Write-Output 'PASS: repeated launch keeps one instance; closing the window releases its processes.'

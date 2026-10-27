param([Parameter(Mandatory=$true)][int]$FixtureProcessId)
$ErrorActionPreference='Stop'
$desktopRoot=Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$expectedExe=Join-Path $desktopRoot 'src-tauri/target/debug/srvprotianti-desktop.exe'
$fixture=Get-Process -Id $FixtureProcessId
if(-not [string]::Equals($fixture.Path,$expectedExe,[StringComparison]::OrdinalIgnoreCase)){throw 'Only the isolated debug fixture may be targeted'}
if($fixture.MainWindowHandle -eq 0){throw 'Fixture main window is unavailable'}
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NativePageMenuSmoke {
  public delegate bool WindowCallback(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetSubMenu(IntPtr menu,int index);
  [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr menu,int index);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window,uint message,IntPtr wParam,IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(WindowCallback callback,IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint processId);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window,StringBuilder name,int size);
}
'@
$menu=[NativePageMenuSmoke]::GetSubMenu([NativePageMenuSmoke]::GetMenu($fixture.MainWindowHandle),0)
$command=[NativePageMenuSmoke]::GetMenuItemID($menu,0)
if($menu -eq [IntPtr]::Zero -or $command -eq [uint32]::MaxValue){throw 'Native recovery menu was not registered'}
if(-not [NativePageMenuSmoke]::PostMessage($fixture.MainWindowHandle,0x111,[IntPtr]::new($command),[IntPtr]::Zero)){throw 'Native menu command could not be posted'}
$statePath=Join-Path $desktopRoot 'src-tauri/target/native-smoke/game/srvprotianti-desktop-data/page-packages/state.json'
$saved=$false
for($attempt=0;$attempt -lt 20;$attempt++){
  Start-Sleep -Milliseconds 100
  $state=Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  if($state.forceBuiltin){$saved=$true;break}
}
if(-not $saved){throw 'Native menu did not persist builtin recovery'}
$callback=[NativePageMenuSmoke+WindowCallback]{param($window,$parameter)
  $owner=[uint32]0
  [void][NativePageMenuSmoke]::GetWindowThreadProcessId($window,[ref]$owner)
  if($owner -eq $FixtureProcessId){
    $name=New-Object System.Text.StringBuilder 128
    [void][NativePageMenuSmoke]::GetClassName($window,$name,128)
    if($name.ToString() -eq '#32770'){[void][NativePageMenuSmoke]::PostMessage($window,0x111,[IntPtr]::new(1),[IntPtr]::Zero)}
  }
  return $true
}
[void][NativePageMenuSmoke]::EnumWindows($callback,[IntPtr]::Zero)
Write-Output "Native menu recovery persisted with JavaScript disabled; highestSequence=$($state.highestSequence)"

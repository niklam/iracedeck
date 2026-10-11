# Lists every render session on every active output device, with the process
# that owns it and the display name and icon path Windows holds for it: the
# outside view of whether the addon's session identity landed (#1253, #1411).
# Read-only: it calls no setter and changes no device or session.
#
#   pwsh -File packages/audio-native/scripts/list-audio-sessions.ps1 [-ProcessId <pid>]
#
# One "endpoint" line per device (marked "default" for the console role), then
# one line per session on it. state: 0 = inactive, 1 = active, 2 = expired.
# A session nobody named has an empty name, and the Volume Mixer then shows the
# executable's. -ProcessId keeps only that process's sessions.
param(
  [uint32]$ProcessId = 0
)

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

// Every method is [PreserveSig]: the int it returns is the HRESULT. Without the
// attribute the runtime turns a failure into an exception and the return value
// into a hidden out parameter, so a device going away mid-listing — which is
// when this script gets run — would abort it.
namespace Ird {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject {}

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int Item(int index, out IMMDevice device);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  }

  // Only GetSessionEnumerator is called; the two before it hold its vtable slot.
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr a, int b, out IntPtr c);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr a, int b, out IntPtr c);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }

  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
  }

  // Only the getters are called; the setters are declared for their vtable slots.
  [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
    [PreserveSig] int GetGroupingParam(out Guid grouping);
    [PreserveSig] int SetGroupingParam(ref Guid grouping, ref Guid context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr n);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out uint pid);
    [PreserveSig] int IsSystemSoundsSession();
    [PreserveSig] int SetDuckingPreference(bool optOut);
  }

  public class Session {
    public int Device;
    public uint ProcessId;
    public int State;
    public string Name;
    public string Icon;
  }

  public class Endpoint {
    public int Device;
    public string Id;
    public bool IsDefault;
    public List<Session> Sessions = new List<Session>();
  }

  public static class Sessions {
    public static List<Endpoint> List() {
      var endpoints = new List<Endpoint>();
      var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());

      string defaultId = null;
      IMMDevice defaultDevice;
      if (enumerator.GetDefaultAudioEndpoint(0, 0, out defaultDevice) == 0 && defaultDevice != null) { // eRender, eConsole
        defaultDevice.GetId(out defaultId);
      }

      IMMDeviceCollection devices;
      int deviceCount;
      if (enumerator.EnumAudioEndpoints(0, 1, out devices) != 0 || devices == null // eRender, DEVICE_STATE_ACTIVE
          || devices.GetCount(out deviceCount) != 0) {
        return endpoints;
      }
      var iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

      // A device or a session that fails to answer is skipped, not fatal: both
      // come and go while the default is being switched.
      for (int d = 0; d < deviceCount; d++) {
        IMMDevice device;
        if (devices.Item(d, out device) != 0 || device == null) { continue; }
        var endpoint = new Endpoint { Device = d };
        device.GetId(out endpoint.Id);
        endpoint.IsDefault = endpoint.Id != null && endpoint.Id == defaultId;
        endpoints.Add(endpoint);

        object managerObject;
        if (device.Activate(ref iid, 23, IntPtr.Zero, out managerObject) != 0 || managerObject == null) { continue; } // CLSCTX_ALL
        var manager = (IAudioSessionManager2)managerObject;
        IAudioSessionEnumerator sessions;
        int count;
        if (manager.GetSessionEnumerator(out sessions) != 0 || sessions == null || sessions.GetCount(out count) != 0) { continue; }

        for (int s = 0; s < count; s++) {
          IAudioSessionControl2 control;
          if (sessions.GetSession(s, out control) != 0 || control == null) { continue; }
          var session = new Session { Device = d };
          control.GetState(out session.State);
          control.GetDisplayName(out session.Name);
          control.GetIconPath(out session.Icon);
          control.GetProcessId(out session.ProcessId);
          endpoint.Sessions.Add(session);
        }
      }

      return endpoints;
    }
  }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

# A deck host runs every plugin as node.exe, so the command line is what tells them apart.
$nodeCommandLines = @{}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | ForEach-Object {
  $nodeCommandLines[[uint32]$_.ProcessId] = $_.CommandLine
}

foreach ($endpoint in [Ird.Sessions]::List()) {
  $marker = if ($endpoint.IsDefault) { ' default' } else { '' }
  Write-Output "endpoint device=$($endpoint.Device) id=$($endpoint.Id)$marker"

  foreach ($session in $endpoint.Sessions) {
    if ($ProcessId -ne 0 -and $session.ProcessId -ne $ProcessId) { continue }

    $process = Get-Process -Id $session.ProcessId -ErrorAction SilentlyContinue
    $processName = if ($process) { $process.ProcessName } else { '?' }
    Write-Output ("  device={0} pid={1} state={2} name=[{3}] icon=[{4}] proc={5}" -f `
        $session.Device, $session.ProcessId, $session.State, $session.Name, $session.Icon, $processName)

    if ($nodeCommandLines.ContainsKey($session.ProcessId)) {
      $commandLine = [string]$nodeCommandLines[$session.ProcessId]
      if ($commandLine.Length -gt 200) { $commandLine = $commandLine.Substring(0, 200) }
      Write-Output "      cmd: $commandLine"
    }
  }
}

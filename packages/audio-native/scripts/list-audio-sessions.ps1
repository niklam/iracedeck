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

namespace Ird {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject {}

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    int GetCount(out int count);
    int Item(int index, out IMMDevice device);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    int OpenPropertyStore(int access, out IntPtr store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  }

  // Only GetSessionEnumerator is called; the two before it hold its vtable slot.
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int GetAudioSessionControl(IntPtr a, int b, out IntPtr c);
    int GetSimpleAudioVolume(IntPtr a, int b, out IntPtr c);
    int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
  }

  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    int GetCount(out int count);
    int GetSession(int index, out IAudioSessionControl2 session);
  }

  // Only the getters are called; the setters are declared for their vtable slots.
  [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int GetState(out int state);
    int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
    int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
    int GetGroupingParam(out Guid grouping);
    int SetGroupingParam(ref Guid grouping, ref Guid context);
    int RegisterAudioSessionNotification(IntPtr n);
    int UnregisterAudioSessionNotification(IntPtr n);
    int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetProcessId(out uint pid);
    int IsSystemSoundsSession();
    int SetDuckingPreference(bool optOut);
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
      enumerator.EnumAudioEndpoints(0, 1, out devices); // eRender, DEVICE_STATE_ACTIVE
      int deviceCount;
      devices.GetCount(out deviceCount);
      var iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

      for (int d = 0; d < deviceCount; d++) {
        IMMDevice device;
        devices.Item(d, out device);
        var endpoint = new Endpoint { Device = d };
        device.GetId(out endpoint.Id);
        endpoint.IsDefault = endpoint.Id != null && endpoint.Id == defaultId;
        endpoints.Add(endpoint);

        object managerObject;
        device.Activate(ref iid, 23, IntPtr.Zero, out managerObject); // CLSCTX_ALL
        var manager = (IAudioSessionManager2)managerObject;
        IAudioSessionEnumerator sessions;
        manager.GetSessionEnumerator(out sessions);
        int count;
        sessions.GetCount(out count);

        for (int s = 0; s < count; s++) {
          IAudioSessionControl2 control;
          sessions.GetSession(s, out control);
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

using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.Text;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;
class DesktopShim {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking;
    public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  static IntPtr lifetimeJob;
  static void OwnDescendants() {
    lifetimeJob = CreateJobObject(IntPtr.Zero, null);
    var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
    if (lifetimeJob == IntPtr.Zero || !SetInformationJobObject(lifetimeJob, 9, ref limits, (uint)Marshal.SizeOf(limits)) ||
        !AssignProcessToJobObject(lifetimeJob, Process.GetCurrentProcess().Handle)) throw new Exception("Cannot own process tree");
    // The non-inheritable handle lives until this shim exits, including abrupt termination.
  }
  static Thread Pump(Stream source, Stream target) {
    var thread = new Thread(delegate() {
      try { var buffer = new byte[16384]; int size; while ((size = source.Read(buffer, 0, buffer.Length)) > 0) { target.Write(buffer, 0, size); target.Flush(); } }
      catch (IOException) { } finally { try { target.Close(); } catch { } }
    });
    thread.IsBackground = true; thread.Start(); return thread;
  }
  // Windows CommandLineToArgvW / CRT quoting, including empty args and trailing slashes.
  static string Quote(string value) {
    var b = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') b.Append('\\', slashes * 2 + 1); else b.Append('\\', slashes);
      b.Append(c); slashes = 0;
    }
    b.Append('\\', slashes * 2); return b.Append('"').ToString();
  }
  static bool IsStdioServer(string[] args) {
    int command = -1;
    for (int i = 0; i < args.Length; i++) {
      string a = args[i];
      if (a == "-c" || a == "--config" || a == "-C" || a == "--cd" || a == "-p" || a == "--profile" || a == "--enable" || a == "--disable") { i++; continue; }
      if (a.StartsWith("-c") || a.StartsWith("--config=") || a.StartsWith("--enable=") || a.StartsWith("--disable=")) continue;
      if (a.StartsWith("-")) return false;
      command = i; break;
    }
    if (command < 0 || args[command] != "app-server") return false;
    for (int i = command + 1; i < args.Length; i++) {
      string a = args[i];
      if (a == "generate-ts" || a == "generate-json-schema" || a == "--help" || a == "-h" || a == "--version") return false;
      if (a == "-c" || a == "--config") { i++; continue; }
      if (a == "--listen" && (i + 1 >= args.Length || args[++i] != "stdio://")) return false;
      if (a.StartsWith("--listen=") && a != "--listen=stdio://") return false;
    }
    return true;
  }
  static int Main(string[] args) {
    try {
      string backend = Environment.GetEnvironmentVariable("JEV_DESKTOP_CODEX");
      if (String.IsNullOrEmpty(backend)) return 1;
      OwnDescendants();
      bool server = IsStdioServer(args);
      var argv = new List<string>();
      string exe = backend;
      if (server) {
        exe = Environment.GetEnvironmentVariable("JEV_DESKTOP_NODE");
        argv.Add("--import"); argv.Add(Environment.GetEnvironmentVariable("JEV_DESKTOP_TSX"));
        argv.Add(Environment.GetEnvironmentVariable("JEV_DESKTOP_ENTRY"));
      }
      argv.AddRange(args);
      var info = new ProcessStartInfo(exe, String.Join(" ", argv.ConvertAll(Quote).ToArray()));
      info.UseShellExecute = false; info.CreateNoWindow = true;
      info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
      // Explicit binary pumps also work when the parent is a GUI process with pipe handles.
      if (!server) {
        var keys = new List<string>();
        foreach (string key in info.EnvironmentVariables.Keys) if (key.Equals("TYPESAFE_API_KEY", StringComparison.OrdinalIgnoreCase) || key.StartsWith("JEV_DESKTOP_", StringComparison.OrdinalIgnoreCase)) keys.Add(key);
        foreach (string key in keys) info.EnvironmentVariables.Remove(key);
        info.EnvironmentVariables["CODEX_CLI_PATH"] = backend;
      }
      using (var child = Process.Start(info)) {
        Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream);
        var output = Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
        var errors = Pump(child.StandardError.BaseStream, Console.OpenStandardError());
        child.WaitForExit();
        if (!output.Join(3000) || !errors.Join(3000)) return 1;
        return child.ExitCode;
      }
    } catch { Console.Error.WriteLine("Desktop shim failed."); return 1; }
  }
}

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
[assembly: AssemblyCompany("Financial Brain LLC")]
[assembly: AssemblyProduct("Financial Brain Setup")]
[assembly: AssemblyTitle("Financial Brain Setup")]
[assembly: AssemblyVersion("0.4.36.0")]
[assembly: AssemblyFileVersion("0.4.36.0")]
internal static class Program
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FontInfo
    {
        public uint Size; public uint Index; public short X; public short Y;
        public int Family; public int Weight;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Face;
    }
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern bool SetCurrentConsoleFontEx(IntPtr output, bool maximum, ref FontInfo font);
    private static void ReadableConsole()
    {
        try {
            Console.Title = "Financial Brain Setup";
            FontInfo font = new FontInfo();
            font.Size = (uint)Marshal.SizeOf(typeof(FontInfo));
            font.Y = 24; font.Family = 54; font.Weight = 400; font.Face = "Consolas";
            SetCurrentConsoleFontEx(GetStdHandle(-11), false, ref font);
        } catch { /* Console hosts may manage font size themselves. */ }
    }
    private static int Main()
    {
        ReadableConsole();
        string work = null;
        try {
            // A new directory per run; preserve it for review after any stop.
            work = Path.Combine(Path.GetTempPath(), "FinancialBrainSetup-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(work);
            string script = Path.Combine(work, "setup.ps1");
            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("setup.ps1"))
            using (FileStream output = new FileStream(script, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                if (resource == null) throw new InvalidOperationException();
                resource.CopyTo(output);
            }
            // x64 build selects the system's 64-bit Windows PowerShell 5.1.
            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            string powershell = Path.Combine(windows, @"System32\WindowsPowerShell\v1.0\powershell.exe");
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = powershell;
            info.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"";
            info.WorkingDirectory = work;
            info.UseShellExecute = false;
            info.CreateNoWindow = false;
            using (Process process = Process.Start(info)) {
                if (process == null) throw new InvalidOperationException();
                process.WaitForExit();
                return process.ExitCode;
            }
        } catch {
            Console.WriteLine("I'm finishing this with your installer.");
            Console.WriteLine("Next: keep this window open and ask your installer to review Setup (about 5 minutes).");
            try {
                if (work == null) {
                    work = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "FinancialBrain-Help-" + Guid.NewGuid().ToString("N"));
                    Directory.CreateDirectory(work);
                }
                File.WriteAllLines(Path.Combine(work, "SEND-TO-INSTALLER.txt"), new string[] {
                    "Financial Brain setup stopped.", "Stage: launcher", "Launcher result: stopped (1)",
                    "Next: ask your installer to review Setup before trying again.",
                    "Share only this note with your installer if you choose."
                }, new UTF8Encoding(false));
                Console.WriteLine("Share only SEND-TO-INSTALLER.txt in " + work + " if you choose.");
            } catch { Console.WriteLine("A support note could not be saved; tell your installer Setup did not open."); }
            Console.WriteLine("Press Enter when your installer has read this window.");
            Console.ReadLine();
            return 1;
        }
    }
}

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace AudioIsolator
{
    class Program
    {
        static void Main(string[] args)
        {
            Console.WriteLine("[AudioIsolator] Extension active for StreamGrid Desktop.");
            if (args.Length > 0 && args[0] == "--list")
            {
                ListAudioProcesses();
            }
            else if (args.Length > 1 && args[0] == "--isolate")
            {
                int pid = 0;
                if (int.TryParse(args[1], out pid))
                {
                    Console.WriteLine("[AudioIsolator] Isolating process PID: " + pid);
                }
            }
            else
            {
                Console.WriteLine("[AudioIsolator] Usage: AudioIsolator.exe --list OR --isolate <PID>");
                ListAudioProcesses();
            }
        }

        static void ListAudioProcesses()
        {
            try
            {
                Process[] processes = Process.GetProcesses();
                Console.WriteLine("--- ACTIVE WINDOW PROCESSES ---");
                foreach (Process p in processes)
                {
                    try
                    {
                        if (!string.IsNullOrEmpty(p.MainWindowTitle))
                        {
                            Console.WriteLine(string.Format("PID: {0} | Name: {1} | Title: {2}", p.Id, p.ProcessName, p.MainWindowTitle));
                        }
                    }
                    catch { }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("Error listing processes: " + ex.Message);
            }
        }
    }
}

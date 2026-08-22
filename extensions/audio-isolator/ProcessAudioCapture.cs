using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace ProcessAudioCapture
{
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct AUDIOCLIENT_ACTIVATION_PARAMS
    {
        public int ActivationType; // 1 = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
        public uint TargetProcessId;
        public uint ProcessLoopbackMode; // 0 = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [Guid("1CB9A8F9-724E-4440-B515-1415F8C7F002"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, [In] ref WAVEFORMATEX pFormat, [In] ref Guid audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint pNumBufferFrames);
        [PreserveSig] int GetStreamLatency(out long phnsLatency);
        [PreserveSig] int GetCurrentPadding(out uint pNumPaddingFrames);
        [PreserveSig] int IsFormatSupported(int shareMode, [In] ref WAVEFORMATEX pFormat, out IntPtr ppClosestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr ppDeviceFormat);
        [PreserveSig] int GetDevicePeriod(out long phnsDefaultDevicePeriod, out long phnsMinimumDevicePeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService([In] ref Guid riid, out IntPtr ppv);
    }

    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr ppData, out uint pNumFramesToRead, out uint pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);
        [PreserveSig] int ReleaseBuffer(uint NumFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint pNumFramesInNextPacket);
    }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, uint dwStateMask, out IntPtr ppDevices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr pClient);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr pClient);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice
    {
        [PreserveSig] int Activate([In] ref Guid iid, [In] uint dwClsCtx, [In] IntPtr pActivationParams, out IntPtr ppInterface);
        [PreserveSig] int OpenPropertyStore(uint stgmAccess, out IntPtr ppProperties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        [PreserveSig] int GetState(out uint pdwState);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject
    {
    }

    [Guid("41D949AB-9370-4B50-9D64-149BBDA81FFB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    [Guid("72A2E436-4EFA-4657-A84F-499D7098F392"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig] int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    class CompletionHandler : IActivateAudioInterfaceCompletionHandler
    {
        public ManualResetEvent CompletedEvent = new ManualResetEvent(false);
        public object ActivatedInterface = null;
        public int ResultHResult = 0;

        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation)
        {
            activateOperation.GetActivateResult(out ResultHResult, out ActivatedInterface);
            CompletedEvent.Set();
            return 0;
        }
    }

    class Program
    {
        [DllImport("ole32.dll")]
        static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);

        [DllImport("ole32.dll")]
        static extern void CoUninitialize();

        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
        public static extern int ActivateAudioInterfaceAsync(
            [In, MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [In, MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            [In] IntPtr activationParams,
            [In] IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);

        public const string VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = "VAD\\Process_Loopback";
        public static Guid IID_IAudioClient = new Guid("1CB9A8F9-724E-4440-B515-1415F8C7F002");
        public static Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

        static HttpListener httpListener;
        static Thread captureThread;
        static volatile bool isCapturing = false;
        static uint currentPid = 0;
        static readonly object clientLock = new object();
        static List<HttpListenerResponse> activeClients = new List<HttpListenerResponse>();

        static void Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            Console.WriteLine("[ProcessAudioCapture] Service started.");

            // Start HTTP PCM audio streaming server on localhost:8989
            StartHttpServer();

            // Interactive command loop from stdin
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.StartsWith("START_CAPTURE "))
                {
                    string pidStr = line.Substring("START_CAPTURE ".Length).Trim();
                    uint pid;
                    if (uint.TryParse(pidStr, out pid))
                    {
                        StartProcessAudioCapture(pid);
                    }
                }
                else if (line.StartsWith("STOP_CAPTURE"))
                {
                    StopProcessAudioCapture();
                }
                else if (line == "EXIT")
                {
                    break;
                }
            }

            StopProcessAudioCapture();
            if (httpListener != null) httpListener.Close();
        }

        static void StartHttpServer()
        {
            try
            {
                httpListener = new HttpListener();
                httpListener.Prefixes.Add("http://127.0.0.1:8989/");
                httpListener.Prefixes.Add("http://localhost:8989/");
                httpListener.Start();
                Console.WriteLine("[ProcessAudioCapture] HTTP PCM Server listening on http://127.0.0.1:8989/");

                Thread serverThread = new Thread(() =>
                {
                    while (httpListener.IsListening)
                    {
                        try
                        {
                            HttpListenerContext ctx = httpListener.GetContext();
                            HandleHttpRequest(ctx);
                        }
                        catch { }
                    }
                });
                serverThread.IsBackground = true;
                serverThread.Start();
            }
            catch (Exception ex)
            {
                Console.WriteLine("[ProcessAudioCapture] HTTP Server Error: " + ex.Message);
            }
        }

        static void HandleHttpRequest(HttpListenerContext ctx)
        {
            HttpListenerRequest req = ctx.Request;
            HttpListenerResponse res = ctx.Response;

            // CORS headers
            res.AddHeader("Access-Control-Allow-Origin", "*");
            res.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.AddHeader("Access-Control-Allow-Headers", "*");

            if (req.HttpMethod == "OPTIONS")
            {
                res.StatusCode = 200;
                res.Close();
                return;
            }

            if (req.Url.AbsolutePath == "/processes")
            {
                var sb = new StringBuilder();
                sb.Append("[");
                Process[] processes = Process.GetProcesses();
                bool first = true;
                foreach (Process p in processes)
                {
                    try
                    {
                        if (!string.IsNullOrEmpty(p.MainWindowTitle))
                        {
                            if (!first) sb.Append(",");
                            sb.Append(string.Format("{{\"pid\":{0},\"name\":\"{1}\",\"title\":\"{2}\"}}",
                                p.Id,
                                EscapeJson(p.ProcessName),
                                EscapeJson(p.MainWindowTitle)));
                            first = false;
                        }
                    }
                    catch { }
                }
                sb.Append("]");
                byte[] jsonBytes = Encoding.UTF8.GetBytes(sb.ToString());
                res.ContentType = "application/json; charset=utf-8";
                res.ContentLength64 = jsonBytes.Length;
                res.StatusCode = 200;
                res.OutputStream.Write(jsonBytes, 0, jsonBytes.Length);
                res.OutputStream.Flush();
                res.Close();
                return;
            }

            if (req.Url.AbsolutePath.StartsWith("/select"))
            {
                string pidStr = req.QueryString["pid"];
                uint pid;
                if (uint.TryParse(pidStr, out pid))
                {
                    StartProcessAudioCapture(pid);
                    byte[] okBytes = Encoding.UTF8.GetBytes("{\"status\":\"ok\",\"pid\":" + pid + "}");
                    res.ContentType = "application/json; charset=utf-8";
                    res.ContentLength64 = okBytes.Length;
                    res.StatusCode = 200;
                    res.OutputStream.Write(okBytes, 0, okBytes.Length);
                    res.OutputStream.Flush();
                }
                res.Close();
                return;
            }

            if (req.Url.AbsolutePath == "/audio.wav" || req.Url.AbsolutePath == "/stream")
            {
                res.ContentType = "audio/wav";
                res.SendChunked = true;

                // Write initial 44-byte WAV header with 48000Hz, 16-bit, Stereo PCM
                byte[] wavHeader = CreateWavHeader(48000, 16, 2);
                res.OutputStream.Write(wavHeader, 0, wavHeader.Length);
                res.OutputStream.Flush();

                lock (clientLock)
                {
                    activeClients.Add(res);
                }
                return;
            }

            res.StatusCode = 404;
            res.Close();
        }

        static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "");
        }

        static byte[] CreateWavHeader(int sampleRate, short bitsPerSample, short channels)
        {
            byte[] header = new byte[44];
            int byteRate = sampleRate * channels * bitsPerSample / 8;
            short blockAlign = (short)(channels * bitsPerSample / 8);

            Encoding.ASCII.GetBytes("RIFF").CopyTo(header, 0);
            BitConverter.GetBytes(0x7fffffff).CopyTo(header, 4);
            Encoding.ASCII.GetBytes("WAVE").CopyTo(header, 8);
            Encoding.ASCII.GetBytes("fmt ").CopyTo(header, 12);
            BitConverter.GetBytes(16).CopyTo(header, 16);
            BitConverter.GetBytes((short)1).CopyTo(header, 20); // PCM
            BitConverter.GetBytes(channels).CopyTo(header, 22);
            BitConverter.GetBytes(sampleRate).CopyTo(header, 24);
            BitConverter.GetBytes(byteRate).CopyTo(header, 28);
            BitConverter.GetBytes(blockAlign).CopyTo(header, 32);
            BitConverter.GetBytes(bitsPerSample).CopyTo(header, 34);
            Encoding.ASCII.GetBytes("data").CopyTo(header, 36);
            BitConverter.GetBytes(0x7fffffff).CopyTo(header, 40);
            return header;
        }

        static void StartProcessAudioCapture(uint pid)
        {
            StopProcessAudioCapture();
            currentPid = pid;
            isCapturing = true;

            captureThread = new Thread(() => CaptureLoop(pid));
            captureThread.SetApartmentState(ApartmentState.MTA);
            captureThread.IsBackground = true;
            captureThread.Start();
            Console.WriteLine("[ProcessAudioCapture] Capture thread started for PID: " + pid);
        }

        static void StopProcessAudioCapture()
        {
            isCapturing = false;
            if (captureThread != null && captureThread.IsAlive)
            {
                captureThread.Join(500);
            }
        }

        static void CaptureLoop(uint pid)
        {
            // Initialize COM for Multi-Threaded Apartment (MTA)
            CoInitializeEx(IntPtr.Zero, 0);

            try
            {
                IAudioClient audioClient = null;

                // Try Windows 10/11 Process Loopback First
                if (pid > 0)
                {
                    try
                    {
                        AUDIOCLIENT_ACTIVATION_PARAMS activateParams = new AUDIOCLIENT_ACTIVATION_PARAMS();
                        activateParams.ActivationType = 1; // PROCESS_LOOPBACK
                        activateParams.TargetProcessId = pid;
                        activateParams.ProcessLoopbackMode = 0; // INCLUDE_TARGET_PROCESS_TREE

                        IntPtr pActivationParams = Marshal.AllocHGlobal(Marshal.SizeOf(activateParams));
                        Marshal.StructureToPtr(activateParams, pActivationParams, false);

                        CompletionHandler handler = new CompletionHandler();
                        IActivateAudioInterfaceAsyncOperation asyncOp;

                        int hrActivate = ActivateAudioInterfaceAsync(
                            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                            IID_IAudioClient,
                            pActivationParams,
                            handler,
                            out asyncOp);

                        Marshal.FreeHGlobal(pActivationParams);

                        if (hrActivate == 0)
                        {
                            handler.CompletedEvent.WaitOne(1500);
                            if (handler.ResultHResult == 0 && handler.ActivatedInterface != null)
                            {
                                audioClient = (IAudioClient)handler.ActivatedInterface;
                                Console.WriteLine(string.Format("[ProcessAudioCapture] Process loopback activated successfully for PID: {0}", pid));
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine("[ProcessAudioCapture] Process loopback exception: " + ex.Message);
                    }
                }

                // Fallback to Standard WASAPI Loopback on Default Audio Endpoint if Process Loopback unavailable
                if (audioClient == null)
                {
                    Console.WriteLine("[ProcessAudioCapture] Using WASAPI System Loopback Capture...");
                    IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                    IMMDevice defaultDevice;
                    // 0 = eRender, 0 = eConsole/eMultimedia
                    int hrEnum = enumerator.GetDefaultAudioEndpoint(0, 0, out defaultDevice);
                    if (hrEnum != 0 || defaultDevice == null)
                    {
                        Console.WriteLine(string.Format("[ProcessAudioCapture] GetDefaultAudioEndpoint failed: 0x{0:X}", hrEnum));
                        return;
                    }

                    IntPtr pClientPtr;
                    Guid iidAudioClient = new Guid("1CB9A8F9-724E-4440-B515-1415F8C7F002");
                    int hrAct = defaultDevice.Activate(ref iidAudioClient, 23 /* CLSCTX_ALL */, IntPtr.Zero, out pClientPtr);
                    if (hrAct != 0 || pClientPtr == IntPtr.Zero)
                    {
                        Console.WriteLine(string.Format("[ProcessAudioCapture] Device.Activate failed: 0x{0:X}", hrAct));
                        return;
                    }
                    audioClient = (IAudioClient)Marshal.GetObjectForIUnknown(pClientPtr);
                }

                // Format setup (48kHz, 16-bit stereo PCM)
                WAVEFORMATEX waveFormat = new WAVEFORMATEX();
                waveFormat.wFormatTag = 1; // PCM
                waveFormat.nChannels = 2;
                waveFormat.nSamplesPerSec = 48000;
                waveFormat.wBitsPerSample = 16;
                waveFormat.nBlockAlign = (ushort)(waveFormat.nChannels * waveFormat.wBitsPerSample / 8);
                waveFormat.nAvgBytesPerSec = waveFormat.nSamplesPerSec * waveFormat.nBlockAlign;
                waveFormat.cbSize = 0;

                Guid sessionGuid = Guid.Empty;
                const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
                const long REFTIMES_PER_SEC = 10000000; // 1 sec buffer

                int hrInit = audioClient.Initialize(0, AUDCLNT_STREAMFLAGS_LOOPBACK, REFTIMES_PER_SEC, 0, ref waveFormat, ref sessionGuid);
                if (hrInit != 0)
                {
                    IntPtr pMixFormat;
                    audioClient.GetMixFormat(out pMixFormat);
                    if (pMixFormat != IntPtr.Zero)
                    {
                        WAVEFORMATEX mixFormat = (WAVEFORMATEX)Marshal.PtrToStructure(pMixFormat, typeof(WAVEFORMATEX));
                        audioClient.Initialize(0, AUDCLNT_STREAMFLAGS_LOOPBACK, REFTIMES_PER_SEC, 0, ref mixFormat, ref sessionGuid);
                    }
                }

                IntPtr pCapturePtr;
                Guid iidCapture = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
                int hrSvc = audioClient.GetService(ref iidCapture, out pCapturePtr);
                if (hrSvc != 0 || pCapturePtr == IntPtr.Zero)
                {
                    Console.WriteLine(string.Format("[ProcessAudioCapture] GetService(IAudioCaptureClient) failed: 0x{0:X}", hrSvc));
                    return;
                }
                IAudioCaptureClient captureClient = (IAudioCaptureClient)Marshal.GetObjectForIUnknown(pCapturePtr);

                audioClient.Start();
                Console.WriteLine("[ProcessAudioCapture] Audio loopback active and streaming!");

                byte[] buffer = new byte[16384];

                while (isCapturing)
                {
                    uint packetLength = 0;
                    captureClient.GetNextPacketSize(out packetLength);

                    while (packetLength > 0 && isCapturing)
                    {
                        IntPtr pData;
                        uint numFramesToRead;
                        uint flags;
                        ulong pos, qpc;

                        int hrBuf = captureClient.GetBuffer(out pData, out numFramesToRead, out flags, out pos, out qpc);
                        if (hrBuf == 0 && numFramesToRead > 0)
                        {
                            int bytesToRead = (int)(numFramesToRead * waveFormat.nBlockAlign);
                            if (bytesToRead > buffer.Length) buffer = new byte[bytesToRead];

                            if ((flags & 0x01) != 0) // AUDCLNT_BUFFERFLAGS_SILENT
                            {
                                Array.Clear(buffer, 0, bytesToRead);
                            }
                            else
                            {
                                Marshal.Copy(pData, buffer, 0, bytesToRead);
                            }

                            captureClient.ReleaseBuffer(numFramesToRead);

                            // Broadcast audio chunk to all active HTTP stream clients
                            BroadcastAudioChunk(buffer, bytesToRead);
                        }

                        captureClient.GetNextPacketSize(out packetLength);
                    }

                    Thread.Sleep(10);
                }

                audioClient.Stop();
                Console.WriteLine("[ProcessAudioCapture] Capture stopped.");
            }
            catch (Exception ex)
            {
                Console.WriteLine("[ProcessAudioCapture] CaptureLoop Exception: " + ex.Message);
            }
            finally
            {
                CoUninitialize();
            }
        }

        static void BroadcastAudioChunk(byte[] data, int length)
        {
            lock (clientLock)
            {
                for (int i = activeClients.Count - 1; i >= 0; i--)
                {
                    try
                    {
                        activeClients[i].OutputStream.Write(data, 0, length);
                    }
                    catch
                    {
                        activeClients.RemoveAt(i);
                    }
                }
            }
        }
    }
}

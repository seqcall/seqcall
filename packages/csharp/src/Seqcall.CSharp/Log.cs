namespace Seqcall.CSharp;

/// <summary>All diagnostics go to stderr; stdout carries the protocol only.</summary>
public static class Log
{
    public static bool Verbose { get; set; }

    public static void Info(string message) => Write("info", message);

    public static void Warn(string message) => Write("warn", message);

    public static void Error(string message) => Write("error", message);

    public static void Debug(string message)
    {
        if (Verbose) Write("debug", message);
    }

    private static void Write(string level, string message)
    {
        try
        {
            Console.Error.WriteLine($"[seqcall-cs {DateTime.Now:HH:mm:ss.fff} {level}] {message}");
        }
        catch
        {
            // stderr closed: nothing to do
        }
    }
}

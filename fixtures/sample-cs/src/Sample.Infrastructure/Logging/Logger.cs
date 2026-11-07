namespace Sample.Infrastructure.Logging;

/// <summary>Static logger (all members static).</summary>
public static class Logger
{
    private static int _count;

    public static void Info(string message)
    {
        _count++;
        Console.Error.WriteLine($"[{_count}] {message}");
    }
}

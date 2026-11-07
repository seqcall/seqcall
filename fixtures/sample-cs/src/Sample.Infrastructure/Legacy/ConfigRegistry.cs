namespace Sample.Infrastructure.Legacy;

/// <summary>Classic singleton.</summary>
public sealed class ConfigRegistry
{
    private readonly Dictionary<string, string> _values = new();

    private ConfigRegistry()
    {
        _values["conn"] = "Server=memory";
    }

    public static ConfigRegistry Instance { get; } = new();

    public string Get(string key) => _values.TryGetValue(key, out var v) ? v : string.Empty;
}

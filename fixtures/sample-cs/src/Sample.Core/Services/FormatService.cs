using Sample.Core.Domain;
using Sample.Core.Util;

namespace Sample.Core.Services;

/// <summary>Delegates passed as arguments and invoked through a parameter (FR-1.13).</summary>
public class FormatService
{
    public IReadOnlyList<string> FormatAll(IReadOnlyList<User> users)
    {
        var plain = Render(users, UserFormat.Plain);
        var loud = Render(users, Shout);
        var ids = Render(users, u => u.Id);
        return [.. plain, .. loud, .. ids];
    }

    private IReadOnlyList<string> Render(IReadOnlyList<User> users, Func<User, string> format) => Each(users, format);

    private static IReadOnlyList<string> Each(IReadOnlyList<User> users, Func<User, string> f)
    {
        var result = new List<string>();
        foreach (var user in users) result.Add(f(user));
        return result;
    }

    public string First(User user, Func<User, string> pick) => pick.Invoke(user);

    public string Via(User user) => user.Apply(UserFormat.Plain);

    public string Named(User user, Formatter formatter) => formatter(user);

    // overloaded generic receivers (like a data layer's QueryWithRetryAsync<T>)
    public T Read<T>(User user, Func<User, T> read) => read(user);

    public Task<T> Read<T>(User user, Func<User, Task<T>> read) => read(user);

    public string Overloaded(User user) => Read(user, Describe);

    public string NamedArgs(User user) => Pick(format: UserFormat.Plain, user: user);

    private static string Pick(User user, Func<User, string> format) => format(user);

    private static string Describe(User user) => user.Name;

    private string Shout(User user) => UserFormat.Plain(user).ToUpperInvariant();

    // a method group kept in an options property: the code holding the options calls it later (FR-31.1)
    public static void Configure(ReportOptions options) => options.Fallback = UserFormat.Loud;

    public static string QuietName() => nameof(UserFormat.Quiet);
}

/// <summary>Options with a delegate the code reading them calls (FR-31.1).</summary>
public class ReportOptions
{
    public Func<User, string>? Fallback { get; set; }
}

/// <summary>A port declared as a delegate type (FR-1.13).</summary>
public delegate string Formatter(User user);

/// <summary>A formatter used as a method group.</summary>
public static class UserFormat
{
    public static string Plain(User user) => Format.Title(user.Name);

    /// <summary>Only stored as a value (<see cref="Quiet"/> names the other one).</summary>
    public static string Loud(User user) => user.Name.ToUpperInvariant();

    /// <summary>Only named: <c>nameof</c> is no use.</summary>
    public static string Quiet(User user) => user.Name.ToLowerInvariant();

    /// <summary>Extension taking a delegate: the receiver is parameter 0.</summary>
    public static string Apply(this User user, Func<User, string> format) => format(user);
}

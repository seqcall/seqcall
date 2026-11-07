using Sample.Core.Domain;
using Sample.Core.Interfaces;
using Sample.Core.Util;

namespace Sample.Core.Services;

/// <summary>Runs an action with retries: invokes the lambda it is given (FR-1.11).</summary>
public class Retrier
{
    public async Task<T> RunAsync<T>(Func<Task<T>> action)
    {
        Format.Title("attempt");
        return await action();
    }
}

/// <summary>Lambdas passed to library methods (drawn inline) and to project methods (FR-1.11).</summary>
public class SyncService(IUserRepository repo)
{
    private readonly Retrier _retrier = new();

    public async Task SyncAllAsync(IReadOnlyList<User> users)
    {
        var names = users.Where(u => u.ManagerId is not null).Select(u => Label(u)).ToList();
        await Task.WhenAll(users.Select(u => repo.SaveAsync(u)));
        await _retrier.RunAsync(() => repo.FindByIdAsync(names[0]));
        _ = repo.FindByIdAsync("x").ContinueWith(t => Format.Title(t.Result?.Name ?? ""));
    }

    private static string Label(User user) => user.Name;
}

using Sample.Core.Domain;
using Sample.Core.Interfaces;
using Sample.Core.Util;

namespace Sample.Core.Services;

/// <summary>Conditional and repeated calls: combined fragments (FR-1.10).</summary>
public class ImportService(IUserRepository repo)
{
    public async Task<int> ImportAllAsync(IReadOnlyList<User> users, bool announce)
    {
        var imported = 0;
        foreach (var user in users)
        {
            if (user.Name.Length == 0)
            {
                Format.Title("invalid");
            }
            else if (user.ManagerId is not null)
            {
                await repo.SaveAsync(user);
                imported++;
            }
            else
            {
                user.Rename(user.Name);
                await repo.SaveAsync(user);
            }
        }
        if (announce)
        {
            Format.Title($"imported {imported}");
        }
        try
        {
            await repo.FindByIdAsync("last");
        }
        catch (InvalidOperationException ex) when (ex.Message.Length > 0)
        {
            Format.Title("lookup failed");
        }
        finally
        {
            Format.Title("done");
        }
        return imported;
    }

    /// <summary>FR-1.17 the error is logged and becomes a value.</summary>
    public async Task<User?> TryFindAsync(string id)
    {
        try
        {
            return await repo.FindByIdAsync(id);
        }
        catch (InvalidOperationException)
        {
            Console.Error.WriteLine("lookup failed");
            return null;
        }
    }

    /// <summary>FR-19.1 a call that leaves the loop (return / throw after it) runs once per loop.</summary>
    public async Task<User?> FirstKnownAsync(IReadOnlyList<string> ids)
    {
        foreach (var id in ids)
        {
            var user = await repo.FindByIdAsync(id);
            switch (user?.Name.Length)
            {
                case 0:
                    continue;
                case > 3:
                    return await repo.FindByIdAsync(user!.Id);
            }
            if (user is null)
            {
                Format.Title("missing");
                throw new InvalidOperationException(id);
            }
        }
        return null;
    }

    public async Task SyncAsync(User user, string mode)
    {
        switch (mode)
        {
            case "full":
            case "deep":
                await repo.SaveAsync(user);
                break;
            default:
                Format.Title("skipped");
                break;
        }
        var attempts = 0;
        while (attempts < 3)
        {
            attempts++;
            var found = await repo.FindByIdAsync(user.Id);
            var label = found is not null ? Describe(found) : Fallback();
        }
        var text = mode switch
        {
            "full" => Describe(user),
            _ => Fallback(),
        };
        for (var i = 0; i < 2; i++)
        {
            if (user.Active)
            {
                if (text.Length > 0)
                {
                    user.Rename(text);
                }
            }
        }
        users().ForEach(u => Describe(u));

        List<User> users() => [user];
    }

    private string Describe(User user) => user.Name;

    private string Fallback() => "?";
}

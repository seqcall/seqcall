using Sample.Core.Domain;
using Sample.Core.Interfaces;
using Sample.Core.Util;

namespace Sample.Core.Services;

/// <summary>Application service with two dependencies of the same port type.</summary>
public class UserService
{
    private readonly IUserRepository _primary;
    private readonly IUserRepository _replica;
    private readonly Func<string, bool> _isBlocked;

    public UserService(IUserRepository primary, IUserRepository replica)
    {
        _primary = primary;
        _replica = replica;
        _isBlocked = id => id.StartsWith('x');
    }

    public async Task<User> FindUserAsync(string id)
    {
        var cached = await _replica.FindByIdAsync(id);
        if (cached is not null)
        {
            return cached;
        }
        var user = await _primary.FindByIdAsync(id);
        return user ?? throw new InvalidOperationException($"User {id} not found");
    }

    public async Task<UserDto> GetUserDtoAsync(string id)
    {
        var user = await FindUserAsync(id);
        var dto = new UserDto(user.Id, Format.Title(user.Name), user.Name.Slugify());
        return dto;
    }

    public async Task RenameAsync(string id, string name)
    {
        if (_isBlocked(id))
        {
            return;
        }
        var user = await this.FindUserAsync(id);
        user.Rename(name);
        await _primary.SaveAsync(user);
    }

    public IReadOnlyList<string> ActiveNames()
    {
        return _primary.All()
            .Where(u => u.Active && IsVisible(u))
            .Select(u => Format.Title(u.Name))
            .ToList();
    }

    /// <summary>Recursive: walks up the management chain.</summary>
    public async Task<IReadOnlyList<User>> ManagementChainAsync(string id)
    {
        var user = await FindUserAsync(id);
        if (user.ManagerId is null)
        {
            return [user];
        }
        var chain = await ManagementChainAsync(user.ManagerId);
        return [user, .. chain];
    }

    public string? FirstReplicaName(IUserRepository? fallback)
    {
        var name = fallback?.All().FirstOrDefault()?.Name;
        return name ?? Describe(_replica.All().Count);

        string Describe(int count) => Format.Title(count.ToString());
    }

    private static bool IsVisible(User u) => !u.Name.StartsWith('_');
}

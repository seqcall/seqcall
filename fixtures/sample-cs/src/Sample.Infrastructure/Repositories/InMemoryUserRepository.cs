using Sample.Core.Domain;
using Sample.Core.Interfaces;

namespace Sample.Infrastructure.Repositories;

public class InMemoryUserRepository : IUserRepository
{
    private readonly Dictionary<string, User> _users = new();

    public Task<User?> FindByIdAsync(string id, CancellationToken ct = default) =>
        Task.FromResult(_users.GetValueOrDefault(id));

    public Task SaveAsync(User user, CancellationToken ct = default)
    {
        _users[user.Id] = user;
        return Task.CompletedTask;
    }

    public IReadOnlyList<User> All() => _users.Values.ToList();
}

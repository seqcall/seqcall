using Sample.Core.Domain;
using Sample.Core.Interfaces;
using Sample.Infrastructure.Legacy;
using Sample.Infrastructure.Logging;

namespace Sample.Infrastructure.Repositories;

public class SqlUserRepository : IUserRepository
{
    private readonly string _connectionString = ConfigRegistry.Instance.Get("conn");
    private readonly List<User> _rows = [];

    public async Task<User?> FindByIdAsync(string id, CancellationToken ct = default)
    {
        Logger.Info($"SELECT * FROM users WHERE id = {id} ({_connectionString})");
        await Task.Delay(1, ct);
        return _rows.FirstOrDefault(r => r.Id == id);
    }

    public Task SaveAsync(User user, CancellationToken ct = default)
    {
        Logger.Info("UPDATE users");
        _rows.Add(user);
        return Task.CompletedTask;
    }

    public IReadOnlyList<User> All() => _rows;
}

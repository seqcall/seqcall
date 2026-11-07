using Sample.Core.Domain;

namespace Sample.Core.Interfaces;

/// <summary>Port: user persistence.</summary>
public interface IUserRepository
{
    Task<User?> FindByIdAsync(string id, CancellationToken ct = default);

    Task SaveAsync(User user, CancellationToken ct = default);

    IReadOnlyList<User> All();
}

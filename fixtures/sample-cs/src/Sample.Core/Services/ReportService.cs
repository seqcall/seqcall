using Sample.Core.Domain;
using Sample.Core.Interfaces;

namespace Sample.Core.Services;

/// <summary>Partial class, part 1.</summary>
public partial class ReportService
{
    private readonly UserService _users;
    private readonly IStore<Order> _orders;

    public ReportService(UserService users, IStore<Order> orders)
    {
        _users = users;
        _orders = orders;
    }

    public async Task<string> BuildAsync(string userId)
    {
        var dto = await _users.GetUserDtoAsync(userId);
        return Header(dto) + Lines();
    }
}

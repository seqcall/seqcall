using Microsoft.AspNetCore.Mvc;
using Sample.Core.Domain;
using Sample.Core.Services;

namespace Sample.Web.Controllers;

[ApiController]
[Route("api/users")]
public class UsersController : ControllerBase
{
    private readonly UserService _users;
    private readonly BillingService _billing;

    public UsersController(UserService users, BillingService billing)
    {
        _users = users;
        _billing = billing;
    }

    [HttpGet("{id}")]
    public async Task<ActionResult<UserDto>> Get(string id)
    {
        var dto = await _users.GetUserDtoAsync(id);
        return Ok(dto);
    }

    [HttpPost("{id}/charge")]
    public Task<bool> Charge(string id, decimal amount) => _billing.ChargeAsync(id, amount);
}

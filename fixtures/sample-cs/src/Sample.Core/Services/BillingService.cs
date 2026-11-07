using Sample.Core.Domain;
using Sample.Core.Interfaces;
using Sample.Core.Util;

namespace Sample.Core.Services;

/// <summary>Primary-constructor (C# 12) injected dependencies.</summary>
public class BillingService(IPaymentClient payments, UserService users)
{
    public async Task<bool> ChargeAsync(string userId, decimal amount)
    {
        var user = await users.FindUserAsync(userId);
        var order = new Order(Guid.NewGuid().ToString(), user.Id, amount);
        var ok = await payments.ChargeAsync(order);
        return ok;
    }

    /// <summary>Two orders created and called on the spot: each call goes to the order just created.</summary>
    public decimal Quote(decimal amount) => new Order("a", "u", amount).WithVat() + new Order("b", "u", amount).WithVat();

    public string Describe(decimal amount) => Format.Money(amount);

    public string Describe(decimal amount, string currency) => Format.Money(amount, /* ISO 4217 */ currency);
}

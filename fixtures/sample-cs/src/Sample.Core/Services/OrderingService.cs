using Sample.Core.Domain;
using Sample.Core.Util;

namespace Sample.Core.Services;

/// <summary>FR-5.8: an order returned in a tuple, destructured by the caller and passed on.</summary>
public class OrderingService
{
    public async Task<decimal> PlaceAsync(string userId, decimal amount)
    {
        bool ok;
        (var order, ok) = await CreateAsync(userId, amount);
        return ok ? Total(order!) : 0m;
    }

    private async Task<(Order? Order, bool Ok)> CreateAsync(string userId, decimal amount)
    {
        if (amount <= 0)
        {
            return (null, false);
        }
        await Task.Yield();
        var order = new Order("o-1", userId, amount);
        return (order, true);
    }

    private static decimal Total(Order order) => order.WithVat();

    /// <summary>FR-5.9: the caller names the class the generic method creates.</summary>
    public OrderEnvelope Envelope(Order order)
    {
        return order.Wrap<Order, OrderEnvelope>();
    }

    public OrderEnvelope EnvelopeVia(Order order)
    {
        return order.WrapVia<Order, OrderEnvelope>();
    }
}

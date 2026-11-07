using static Sample.Core.Util.Enums;

namespace Sample.Core.Domain;

/// <summary>Domain rule that only *uses* the enums of an outer-layer file: no calls (FR-12.12).</summary>
public static class OrderPolicy
{
    public static bool CanShip(Order order, OrderStatus status)
    {
        if (status == OrderStatus.Cancelled) return false;
        var kind = typeof(OrderStatus).Name;
        return order.Amount > 0 && (int)status >= (int)OrderStatus.Paid && kind.Length > 0 && Limit(order) > 0;
    }

    private static decimal Limit(Order order) => order.Amount;
}

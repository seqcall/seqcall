using Sample.Core.Domain;
using Sample.Core.Util;

namespace Sample.Core.Services;

/// <summary>Calls the domain rule and the enum extension (FR-12.12).</summary>
public class ShippingService
{
    public bool Ship(Order order, Enums.ProviderStatus provider)
    {
        var status = provider.ToOrderStatus();
        return OrderPolicy.CanShip(order, status);
    }
}

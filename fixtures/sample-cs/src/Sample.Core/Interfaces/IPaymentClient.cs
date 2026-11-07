using Sample.Core.Domain;

namespace Sample.Core.Interfaces;

/// <summary>Port: external payment provider.</summary>
public interface IPaymentClient
{
    Task<bool> ChargeAsync(Order order);
}

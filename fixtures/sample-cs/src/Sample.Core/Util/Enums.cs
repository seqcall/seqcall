namespace Sample.Core.Util;

/// <summary>Nested enums in a static class (like the C# reference solution's Enums), imported with `using static` (FR-12.12).</summary>
public static class Enums
{
    public enum OrderStatus
    {
        Open,
        Paid,
        Cancelled,
    }

    public enum ProviderStatus
    {
        Ok,
        Failed,
    }

    /// <summary>Its signature mentions only its own nested enums (no evidence for a layer, FR-7.4).</summary>
    public static OrderStatus ToOrderStatus(this ProviderStatus status) =>
        status == ProviderStatus.Ok ? OrderStatus.Paid : OrderStatus.Open;
}

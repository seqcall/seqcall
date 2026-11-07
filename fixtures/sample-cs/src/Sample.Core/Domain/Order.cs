using Sample.Core.Util;

namespace Sample.Core.Domain;

public record Order(string Id, string UserId, decimal Amount)
{
    public decimal WithVat() => Amount * 1.2m;

    public string Label => Format.Money(WithVat(), "EUR");
}

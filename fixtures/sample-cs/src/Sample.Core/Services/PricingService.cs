using Sample.Core.Domain;

namespace Sample.Core.Services;

/// <summary>FR-5.12 values on one lifeline per class; mutable objects one each.</summary>
public class PricingService
{
    public Outcome<Price> Total(decimal a, decimal b)
    {
        var first = new Price(a, "EUR");
        var sum = first.Add(new Price(b, "EUR"));
        if (sum.Amount < 0) return Outcome<Price>.Fail("negative");
        var checkedSum = Outcome<Price>.Ok(sum);
        return checkedSum.IsOk ? checkedSum : Outcome<Price>.Fail("unchecked");
    }

    public string Labels() => new Draft().Describe() + new Draft().Describe();
}

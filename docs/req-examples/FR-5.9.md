# FR-5.9 — an object created through a generic type parameter (C#)

```csharp
public static class ResponseUtil
{
    public static TResponse ToEnvelope<TData, TResponse>(this TData data)
        where TResponse : Envelope<TData>, new()
        => new TResponse { Data = data };
}

public CouponListResponse List()
    => _coupons.All().ToEnvelope<CouponDto[], CouponListResponse>();
```

Opened from `List`, the creation inside `ToEnvelope` is `:CouponListResponse` (the type argument the caller
named), not `unknown`. Opened on `ToEnvelope` alone, it is `:Envelope<TData>` (the constraint).

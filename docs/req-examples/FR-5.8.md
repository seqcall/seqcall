# FR-5.8 — a returned object through a variable and a tuple (C#)

```csharp
public async Task<(Enrollment?, Status)> EnrollAsync(long customerId, long couponId)
{
    if (!await _rules.CanEnrollAsync(customerId, couponId))
        return (null, Status.NotAllowed);          // null: no object
    var e = new Enrollment { CustomerId = customerId, CouponId = couponId };
    return (e, Status.Ok);
}

public async Task JoinAsync(long customerId, long couponId)
{
    (var enrollment, var status) = await _service.EnrollAsync(customerId, couponId);
    await _notifier.ConfirmAsync(enrollment);      // goes to the created :Enrollment
    enrollment.Activate();                         // same object
}
```

With `EnrollAsync` expanded, `enrollment` in `JoinAsync` is the object created there: one `:Enrollment`
lifeline instead of two.

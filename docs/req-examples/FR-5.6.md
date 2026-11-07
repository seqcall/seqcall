# FR-5.6 — mutually exclusive creations share a lifeline (C#)

```csharp
public async Task<(long?, OrderResult)> PlaceOrderAsync(OrderRequest request)
{
    if (request.Lines.Count == 0)
        return (null, new OrderResult { Status = Status.Empty });       // early return
    if (!await _stock.IsAvailableAsync(request))
        return (null, new OrderResult { Status = Status.OutOfStock });  // early return
    try
    {
        var id = await _orders.InsertAsync(request);
        return (id, new OrderResult { Status = Status.Ok });            // last call of the try
    }
    catch (DbException)
    {
        return (null, new OrderResult { Status = Status.Failed });      // catch
    }
}
```

The four `OrderResult` objects can never exist together in one run, so they are drawn on **one** lifeline
`:OrderResult` (*one of 4*); each «create» says *Alternative i of 4*.

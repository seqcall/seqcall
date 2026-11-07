# FR-1.17 — a catch that swallows the error (C#)

```csharp
public async Task HandleMessageAsync(InvoiceMessage message)
{
    try
    {
        await _invoices.SettleAsync(message.InvoiceId);
    }
    catch (Exception e)
    {
        _logger.LogError(e, "Settling failed");   // logged, then dropped
    }
}
```

The `try` is drawn although its catch has no visible call: the catch is a guard-only row
`[catch Exception] logged, swallowed` (amber). Without it, the diagram would look as if a failed
settlement could not go unnoticed.

# FR-8.6 — DI registrations: chosen, listed, per application (C#)

```csharp
// Shop.Core/ServiceRegistration.cs (a library used by two executables)
services.AddScoped<IOrderRepository, SqlOrderRepository>();           // chosen for IOrderRepository
services.TryAddScoped<IOrderRepository, MemoryOrderRepository>();     // ignored: a binding exists
services.AddKeyedSingleton<IPaymentGateway, CardGateway>(nameof(CardGateway));       // listed, never chosen
services.AddKeyedSingleton<IPaymentGateway, InvoiceGateway>(nameof(InvoiceGateway)); // listed, never chosen

// Shop.Feed/Program.cs (Autofac)
if (isReplay)
    builder.RegisterType<ReplayFeedService>().As<IFeedService>();     // when isReplay
else
    builder.RegisterType<LiveFeedService>().As<IFeedService>();       // when !isReplay
```

`IOrderRepository` calls run `SqlOrderRepository` (*bound · ServiceRegistration.cs:2*). The keyed gateways and
the two feed services are listed in the dropdown with their key / condition; the user chooses. A registration in
`Shop.Web` does not count for `Shop.Feed` unless `Shop.Feed` references `Shop.Web`.

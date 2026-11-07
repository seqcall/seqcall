using Microsoft.Extensions.DependencyInjection.Extensions;
using Sample.Core.Domain;
using Sample.Core.Interfaces;
using Sample.Core.Services;
using Sample.Infrastructure.Clients;
using Sample.Infrastructure.Repositories;
using Sample.Infrastructure.Storage;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddSingleton<IUserRepository, SqlUserRepository>();
builder.Services.AddSingleton<IStore<Order>, InMemoryStore<Order>>();
builder.Services.AddHttpClient<IPaymentClient, PaymentApiClient>();
builder.Services.AddScoped<UserService>();
builder.Services.AddScoped<BillingService>();
builder.Services.AddScoped<ReportService>();
// FR-8.6: a TryAdd does not replace the binding above; a keyed one is chosen by its key at run time
builder.Services.TryAddSingleton<IUserRepository, InMemoryUserRepository>();
builder.Services.AddKeyedSingleton<IUserRepository, InMemoryUserRepository>("cache");
builder.Services.AddSingleton<IStore<Order>>(sp => new InMemoryStore<Order>());

var app = builder.Build();
app.MapControllers();
app.Run();

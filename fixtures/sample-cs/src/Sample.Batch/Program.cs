using Autofac;
using Sample.Core.Interfaces;
using Sample.Core.Services;
using Sample.Infrastructure.Clients;
using Sample.Infrastructure.Repositories;

// FR-8.6 a second application wiring the same classes with Autofac: its registrations are not Sample.Web's
var builder = new ContainerBuilder();
var live = args.Length > 0;
var repositoryType = live ? typeof(SqlUserRepository) : typeof(InMemoryUserRepository);
builder.RegisterType(repositoryType).As<IUserRepository>().SingleInstance();
builder.RegisterType<SqlUserRepository>().Keyed<IUserRepository>("sql");
builder.RegisterType<PaymentApiClient>().AsImplementedInterfaces();
builder.RegisterType<UserService>().AsSelf().InstancePerLifetimeScope();
if (live)
{
    builder.RegisterType<ReportService>();
}
using var container = builder.Build();
await container.Resolve<UserService>().FindUserAsync("1");

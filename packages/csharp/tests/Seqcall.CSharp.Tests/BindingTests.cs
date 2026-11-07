using Seqcall.CSharp.Protocol;

namespace Seqcall.CSharp.Tests;

/// <summary>FR-8.6: the solution's DI registrations (Microsoft DI in Sample.Web, Autofac in Sample.Batch) and their hosts.</summary>
[Collection(SampleCollection.Name)]
public sealed class BindingTests(SampleFixture f)
{
    private static string Short(string key) => key[(key.LastIndexOf('#') + 1)..];

    private static string Describe(ContainerBinding b) =>
        $"{Short(b.Abstract)} → {Short(b.Concrete)} {b.Lifetime}{(b.Fallback == true ? " fallback" : "")}{(b.Key is null ? "" : $" {b.KeyKind} {b.Key}")} [{string.Join(",", b.Hosts ?? [])}]";

    [Fact]
    public async Task FR_8_6_registrations_of_both_containers_with_lifetime_key_condition_fallback_and_hosts()
    {
        var bindings = await f.Adapter.GetBindingsAsync();
        Assert.Equal(
            [
                // Autofac: a type chosen by a condition is one registration per branch; keyed; AsImplementedInterfaces; AsSelf
                "IUserRepository → SqlUserRepository singleton condition live [Sample.Batch]",
                "IUserRepository → InMemoryUserRepository singleton condition !live [Sample.Batch]",
                "IUserRepository → SqlUserRepository transient key \"sql\" [Sample.Batch]",
                "IPaymentClient → PaymentApiClient transient [Sample.Batch]",
                "UserService → UserService scoped [Sample.Batch]",
                // inside `if (live)`
                "ReportService → ReportService transient condition live [Sample.Batch]",
                // Microsoft DI
                "IUserRepository → SqlUserRepository singleton [Sample.Web]",
                "IStore`1 → InMemoryStore`1 singleton [Sample.Web]",
                "IPaymentClient → PaymentApiClient transient [Sample.Web]",
                "UserService → UserService scoped [Sample.Web]",
                "BillingService → BillingService scoped [Sample.Web]",
                "ReportService → ReportService scoped [Sample.Web]",
                "IUserRepository → InMemoryUserRepository singleton fallback [Sample.Web]",
                "IUserRepository → InMemoryUserRepository singleton key \"cache\" [Sample.Web]",
                "IStore`1 → InMemoryStore`1 singleton [Sample.Web]",
            ],
            bindings.Select(Describe));
        var web = bindings.First(b => b.Hosts!.Contains("Sample.Web"));
        Assert.Equal("src/Sample.Infrastructure/Repositories/SqlUserRepository.cs#SqlUserRepository", web.Concrete);
        Assert.Equal(TestPaths.File("src/Sample.Web/Program.cs"), web.Range.File);
        Assert.Null(web.Consumer);
        // a constructed generic service carries its type arguments: one registration per argument
        Assert.All(bindings.Where(b => b.Abstract.EndsWith("#IStore`1")), b => Assert.Equal(["src/Sample.Core/Domain/Order.cs#Order"], b.AbstractArgs!));
        Assert.All(bindings.Where(b => !b.Abstract.Contains('`')), b => Assert.Null(b.AbstractArgs));
    }

    [Fact]
    public async Task FR_8_6_hosts_of_a_file_are_the_executables_referencing_its_project()
    {
        Assert.Equal(["Sample.Batch", "Sample.Web"], await f.Adapter.GetHostsOfAsync(TestPaths.File("src/Sample.Core/Services/UserService.cs")));
        Assert.Equal(["Sample.Web"], await f.Adapter.GetHostsOfAsync(TestPaths.File("src/Sample.Web/Controllers/UsersController.cs")));
    }
}

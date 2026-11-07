namespace Seqcall.CSharp.Tests;

[Collection(SampleCollection.Name)]
public sealed class NavigationTests(SampleFixture f)
{
    [Fact]
    public async Task Interface_member_implementations_are_sorted_by_owner()
    {
        var impls = await f.Adapter.GetImplementationsAsync("src/Sample.Core/Interfaces/IUserRepository.cs#IUserRepository.FindByIdAsync(string, CancellationToken)");
        Assert.Equal(
        [
            "src/Sample.Infrastructure/Repositories/InMemoryUserRepository.cs#InMemoryUserRepository.FindByIdAsync(string, CancellationToken)",
            "src/Sample.Infrastructure/Repositories/SqlUserRepository.cs#SqlUserRepository.FindByIdAsync(string, CancellationToken)",
        ], impls.Select(i => i.Key));
        Assert.All(impls, i => Assert.True(i.HasBody));
    }

    [Fact]
    public async Task Generic_interface_implementations()
    {
        var impl = Assert.Single(await f.Adapter.GetImplementationsAsync("src/Sample.Core/Interfaces/IStore.cs#IStore`1.Add(T)"));
        Assert.Equal("src/Sample.Infrastructure/Storage/InMemoryStore.cs#InMemoryStore`1.Add(T)", impl.Key);
        Assert.Equal("InMemoryStore<T>", impl.Owner.Name);
    }

    [Fact]
    public async Task Abstract_and_virtual_overrides()
    {
        var area = await f.Adapter.GetImplementationsAsync("src/Sample.Core/Domain/Shape.cs#Shape.Area()");
        Assert.Equal(["src/Sample.Core/Domain/Shape.cs#Circle.Area()", "src/Sample.Core/Domain/Shape.cs#Square.Area()"], area.Select(i => i.Key));
        var describe = await f.Adapter.GetImplementationsAsync("src/Sample.Core/Domain/Shape.cs#Shape.Describe()");
        Assert.Equal(["src/Sample.Core/Domain/Shape.cs#Square.Describe()"], describe.Select(i => i.Key));
        Assert.Empty(await f.Adapter.GetImplementationsAsync("src/Sample.Core/Services/UserService.cs#UserService.FindUserAsync(string)"));
    }

    [Fact]
    public async Task Callers_map_to_enclosing_methods_with_previews()
    {
        var callers = await f.Adapter.GetCallersAsync("src/Sample.Core/Services/UserService.cs#UserService.GetUserDtoAsync(string)");
        Assert.Equal(2, callers.Count);
        Assert.Equal("src/Sample.Core/Services/ReportService.Formatting.cs#ReportService.BuildAsync(string)", callers[0].Enclosing.Key);
        Assert.Equal("src/Sample.Web/Controllers/UsersController.cs#UsersController.Get(string)", callers[1].Enclosing.Key);
        Assert.Equal("var dto = await _users.GetUserDtoAsync(userId);", callers[0].Preview);
        Assert.StartsWith("src/Sample.Core/Services/ReportService.cs:", callers[0].Id);
        Assert.Equal("_users.GetUserDtoAsync(userId)", ReadRange(callers[0].Range));
    }

    [Fact]
    public async Task Callers_include_calls_through_the_interface_and_inside_lambdas()
    {
        var callers = await f.Adapter.GetCallersAsync("src/Sample.Infrastructure/Repositories/SqlUserRepository.cs#SqlUserRepository.FindByIdAsync(string, CancellationToken)");
        Assert.Equal(2, callers.Count(c => c.Enclosing.Key == "src/Sample.Core/Services/UserService.cs#UserService.FindUserAsync(string)"));

        // Format.Title is called inside a lambda of ActiveNames: the caller is ActiveNames
        var title = await f.Adapter.GetCallersAsync("src/Sample.Core/Util/Format.cs#Format.Title(string)");
        Assert.Contains(title, c => c.Enclosing.Key == "src/Sample.Core/Services/UserService.cs#UserService.ActiveNames()");
        Assert.Contains(title, c => c.Enclosing.Key.EndsWith(".FirstReplicaName(IUserRepository).Describe(int)"));
        Assert.Equal(title.Select(c => c.Id).Distinct(), title.Select(c => c.Id));
    }

    [Fact]
    public async Task Constructor_callers_are_creations()
    {
        var callers = await f.Adapter.GetCallersAsync("src/Sample.Core/Domain/Shape.cs#Circle..ctor(double)");
        var c = Assert.Single(callers);
        Assert.Equal("src/Sample.Web/Controllers/ReportsController.cs#ReportsController.Shapes()", c.Enclosing.Key);
        Assert.Equal("new Circle(1)", ReadRange(c.Range));
    }

    [Fact]
    public async Task Parameter_names()
    {
        Assert.Equal(["amount", "currency"], await f.Adapter.GetParameterNamesAsync("src/Sample.Core/Services/BillingService.cs#BillingService.Describe(decimal, string)"));
        Assert.Equal(["payments", "users"], await f.Adapter.GetParameterNamesAsync("src/Sample.Core/Services/BillingService.cs#BillingService..ctor(IPaymentClient, UserService)"));
    }

    private static string ReadRange(Seqcall.CSharp.Protocol.SourceRange r)
    {
        var lines = File.ReadAllLines(r.File);
        Assert.Equal(r.Start.Line, r.End.Line);
        return lines[r.Start.Line][r.Start.Character..r.End.Character];
    }
}

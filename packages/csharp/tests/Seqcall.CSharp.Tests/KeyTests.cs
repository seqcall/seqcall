namespace Seqcall.CSharp.Tests;

[Collection(SampleCollection.Name)]
public sealed class KeyTests(SampleFixture f)
{
    [Fact]
    public async Task Constructor_keys_drop_nullable_annotations()
    {
        var ctor = await f.MethodAt("src/Sample.Core/Domain/User.cs", "Id = id;");
        Assert.Equal("src/Sample.Core/Domain/User.cs#User..ctor(string, string, string)", ctor.Key);
        Assert.Equal("constructor", ctor.Name);
        Assert.Equal("User", ctor.Owner.Name);
        Assert.Equal("class", ctor.Owner.Kind);
        // declaration = the constructor's name identifier
        Assert.Equal(TestPaths.PositionOf("src/Sample.Core/Domain/User.cs", "public User(", "public ".Length), ctor.Declaration!.Start);
    }

    [Fact]
    public async Task Method_keys_round_trip_through_getMethod()
    {
        string[] keys =
        [
            "src/Sample.Core/Services/UserService.cs#UserService.FindUserAsync(string)",
            "src/Sample.Core/Interfaces/IStore.cs#IStore`1.Get(int)",
            "src/Sample.Infrastructure/Storage/InMemoryStore.cs#InMemoryStore`1.Add(T)",
            "src/Sample.Core/Util/Format.cs#Format.Money(decimal, string)",
            "src/Sample.Core/Domain/Shape.cs#Square..ctor(double)",
            "src/Sample.Core/Domain/Order.cs#Order.WithVat()",
        ];
        foreach (var key in keys)
        {
            var m = await f.Method(key);
            Assert.Equal(key, m.Key);
        }
        Assert.Null(await f.Adapter.GetMethodAsync("src/Sample.Core/Services/UserService.cs#UserService.Nope()"));
        Assert.Null(await f.Adapter.GetMethodAsync("src/Nope.cs#X.Y()"));
    }

    [Fact]
    public async Task Interface_and_abstract_members_have_no_body()
    {
        Assert.False((await f.Method("src/Sample.Core/Interfaces/IStore.cs#IStore`1.Get(int)")).HasBody);
        Assert.False((await f.Method("src/Sample.Core/Domain/Shape.cs#Shape.Area()")).HasBody);
        Assert.True((await f.Method("src/Sample.Core/Domain/Shape.cs#Shape.Describe()")).HasBody);
        var store = await f.Method("src/Sample.Core/Interfaces/IStore.cs#IStore`1.Get(int)");
        Assert.Equal("IStore<T>", store.Owner.Name);
        Assert.Equal("interface", store.Owner.Kind);
    }

    [Fact]
    public async Task Partial_type_members_use_the_first_file_by_path_order()
    {
        var m = await f.MethodAt("src/Sample.Core/Services/ReportService.cs", "Header(dto) + Lines()");
        Assert.Equal("src/Sample.Core/Services/ReportService.Formatting.cs#ReportService.BuildAsync(string)", m.Key);
        Assert.Equal(TestPaths.File("src/Sample.Core/Services/ReportService.cs"), m.Declaration!.File);
        var calls = await f.Calls(m);
        Assert.Equal(["GetUserDtoAsync", "Header", "Lines"], calls.Select(c => c.MethodName));
        Assert.Equal("src/Sample.Core/Services/ReportService.Formatting.cs#ReportService.Header(UserDto)", calls[1].Target!.Key);
    }

    [Fact]
    public async Task Library_keys_resolve_to_metadata_symbols()
    {
        var where = await f.Method("lib:System.Linq#System.Linq.Enumerable.Where`1(IEnumerable<TSource>, Func<TSource, bool>)");
        Assert.False(where.HasBody);
        Assert.Equal("external", where.Owner.Kind);
        Assert.Equal("lib:System.Linq#System.Linq.Enumerable", where.Owner.Key);
    }

    [Fact]
    public async Task Property_accessors_and_field_initializers()
    {
        var getter = await f.MethodAt("src/Sample.Core/Domain/Order.cs", "Format.Money(WithVat()");
        Assert.Equal("src/Sample.Core/Domain/Order.cs#Order.Label.get", getter.Key);
        Assert.Equal("Label", getter.Name);
        Assert.Equal(["WithVat", "Money"], (await f.Calls(getter)).Select(c => c.MethodName));
        Assert.Equal(getter.Key, (await f.Method(getter.Key)).Key);

        var init = await f.MethodAt("src/Sample.Infrastructure/Repositories/SqlUserRepository.cs", "ConfigRegistry.Instance.Get");
        Assert.Equal("src/Sample.Infrastructure/Repositories/SqlUserRepository.cs#SqlUserRepository..ctor()", init.Key);
    }

    [Fact]
    public async Task Expression_bodied_members_and_positions_outside_callables()
    {
        var area = await f.MethodAt("src/Sample.Core/Domain/Shape.cs", "side * side");
        Assert.Equal("src/Sample.Core/Domain/Shape.cs#Square.Area()", area.Key);
        Assert.Null(await f.Adapter.FindEnclosingCallableAsync(TestPaths.File("src/Sample.Core/Domain/Shape.cs"), new(0, 0)));
        Assert.Null(await f.Adapter.FindEnclosingCallableAsync(TestPaths.File("src/Sample.Core/Domain/Nope.cs"), new(0, 0)));
    }
}

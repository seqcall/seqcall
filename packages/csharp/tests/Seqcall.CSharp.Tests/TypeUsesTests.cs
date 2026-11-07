using Seqcall.CSharp.Protocol;

namespace Seqcall.CSharp.Tests;

/// <summary>FR-12.12: getTypeUses — project types a method references without (necessarily) calling them.</summary>
[Collection(SampleCollection.Name)]
public sealed class TypeUsesTests(SampleFixture f)
{
    private const string Enums = "src/Sample.Core/Util/Enums.cs#Enums";
    private const string Order = "src/Sample.Core/Domain/Order.cs#Order";
    private const string OrderPolicy = "src/Sample.Core/Domain/OrderPolicy.cs#OrderPolicy";

    private static string[] Keys(IEnumerable<TypeUse> uses) => uses.Select(u => u.Type.Key).ToArray();

    [Fact]
    public async Task FR_12_12_nested_enums_via_using_static_map_to_the_top_level_type()
    {
        var m = await f.MethodAt("src/Sample.Core/Domain/OrderPolicy.cs", "OrderStatus.Cancelled");
        var uses = await f.Adapter.GetTypeUsesAsync(m.Key);
        // parameter types first (Order, OrderStatus → Enums); typeof / casts / enum constants dedupe into Enums
        Assert.Equal([Order, Enums], Keys(uses));
        var e = uses[1];
        Assert.Equal("Enums", e.Type.Name);
        Assert.Equal("class", e.Type.Kind);
        // first reference: the parameter type `OrderStatus status`
        var pos = TestPaths.PositionOf("src/Sample.Core/Domain/OrderPolicy.cs", "OrderStatus status");
        Assert.Equal(pos, e.Range.Start);
        Assert.Equal(TestPaths.File("src/Sample.Core/Domain/OrderPolicy.cs"), e.Range.File);
    }

    [Fact]
    public async Task FR_12_12_own_type_library_types_and_type_parameters_are_skipped_static_calls_count()
    {
        var m = await f.MethodAt("src/Sample.Core/Services/ShippingService.cs", "provider.ToOrderStatus()");
        var uses = await f.Adapter.GetTypeUsesAsync(m.Key);
        // Order (parameter), Enums (Enums.ProviderStatus, var → OrderStatus, extension), OrderPolicy (static call)
        Assert.Equal([Order, Enums, OrderPolicy], Keys(uses));
        Assert.DoesNotContain(uses, u => u.Type.Key.StartsWith("lib:") || u.Type.Key.EndsWith("#ShippingService"));
    }

    [Fact]
    public async Task FR_12_12_a_type_whose_methods_use_only_its_own_nested_types_has_no_uses()
    {
        var m = await f.Method($"{Enums}.ToOrderStatus(Enums.ProviderStatus)");
        Assert.Empty(await f.Adapter.GetTypeUsesAsync(m.Key));
    }

    [Fact]
    public async Task FR_12_12_unknown_method_has_no_uses()
    {
        Assert.Empty(await f.Adapter.GetTypeUsesAsync("src/Nope.cs#Nope.M()"));
    }

    [Fact]
    public async Task FR_7_4_class_info_lists_nested_types()
    {
        var info = await f.Adapter.GetClassInfoAsync(Enums);
        Assert.Equal(["OrderStatus", "ProviderStatus"], info!.NestedTypes);
        Assert.Null((await f.Adapter.GetClassInfoAsync(Order))!.NestedTypes);
    }
}

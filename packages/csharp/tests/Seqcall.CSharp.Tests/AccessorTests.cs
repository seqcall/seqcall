using Seqcall.CSharp.Analysis;
using Microsoft.CodeAnalysis;

namespace Seqcall.CSharp.Tests;

/// <summary>
/// FR-1.18 a property whose getter / setter has a body runs it when read / assigned: a step <c>«get» Total</c> in the
/// flow, and those reads / assignments are the accessor's callers. Fields, auto-properties and library properties are
/// plain reads.
/// </summary>
public sealed class AccessorTests
{
    private const string Shop = """
        using System.Collections.Generic;
        using System.Linq;
        public class Tax { public static int Rate => Lookup(); private static int Lookup() => 20; }
        public class Order
        {
            private int _discount;
            public List<int> Lines { get; } = new();
            public string Name { get; set; } = "";
            public int Count;
            public int Total => Lines.Sum() - _discount;
            public int Discount
            {
                get => _discount;
                set { _discount = Clamp(value); }
            }
            private static int Clamp(int v) => v;
            public static Order Make() => new();
        }
        public class Till
        {
            public int Ring(Order order, Order? maybe)
            {
                order.Discount = Compute();
                order.Discount += 1;
                var name = order.Name + order.Count + order.Name.Length;
                var label = nameof(order.Total);
                var fresh = new Order { Discount = 2 };
                var total = order.Total + (maybe?.Total ?? 0) + Order.Make().Total;
                return total * Tax.Rate;
            }
            private int Compute() => 1;
        }
        """;

    private static async Task<(AnalysisContext Ctx, Compilation C)> Load()
    {
        var ctx = await Snippets.ContextAsync(("src/Shop.cs", Shop));
        return (ctx, ctx.Compilations.Single());
    }

    private static string Named(string? name) => name is null ? "" : $" {name}";

    private static IMethodSymbol Accessor(Compilation c, string type, string property, bool set = false)
    {
        var p = (IPropertySymbol)c.GetTypeByMetadataName(type)!.GetMembers(property).Single();
        return set ? p.SetMethod! : p.GetMethod!;
    }

    [Fact]
    public async Task FR_1_18_a_read_or_assignment_of_a_property_with_an_accessor_body_is_a_step_in_evaluation_order()
    {
        var (ctx, c) = await Load();
        var ring = c.GetTypeByMetadataName("Till")!.GetMembers("Ring").OfType<IMethodSymbol>().Single();
        var calls = new OutgoingCalls(ctx).Of(ring);
        Assert.Equal(
            [
                // the setter after the assigned value is computed; `+=` reads and writes
                "Compute | - | <self>",
                "Discount | set | <parameter order>",
                "Discount | get | <parameter order>",
                // auto-properties, fields, library properties, nameof: no step; the object initializer's setter neither
                "constructor | - | <none>",
                "Total | get | <parameter order>",
                "Total | get | <parameter maybe>",
                "Make | - | <static>",
                // (on the result of a call, like a method call there)
                "Total | get | <expression Order.Make()>",
                "Rate | get | <static>",
            ],
            calls.Select(x => $"{x.MethodName} | {x.Accessor ?? "-"} | <{x.Receiver.Kind}{Named(x.Receiver.Name ?? x.Receiver.Text)}>"));
        var total = calls.First(x => x.MethodName == "Total");
        Assert.Equal("src/Shop.cs#Order.Total.get", total.Target!.Key);
        Assert.True(total.Target.HasBody);
        Assert.Equal("int", total.ReturnType);
        Assert.Equal("order.Discount", calls[1].ExpressionText);
        Assert.Empty(calls[1].Args);
        // an accessor's own body: its calls, as before
        Assert.Equal(["Clamp"], new OutgoingCalls(ctx).Of(Accessor(c, "Order", "Discount", set: true)).Select(x => x.MethodName));
    }

    [Fact]
    public async Task FR_1_18_the_callers_of_an_accessor_are_the_reads_or_the_assignments_of_its_property()
    {
        var (ctx, c) = await Load();
        var nav = new Navigation(ctx);
        Assert.Equal(
            ["src/Shop.cs:28:21", "src/Shop.cs:28:42", "src/Shop.cs:28:57"],
            (await nav.CallersAsync(Accessor(c, "Order", "Total"))).Select(x => x.Id));
        // `=` writes, `+=` reads and writes, the object initializer sets it too
        Assert.Equal(
            ["order.Discount = Compute();", "order.Discount += 1;", "var fresh = new Order { Discount = 2 };"],
            (await nav.CallersAsync(Accessor(c, "Order", "Discount", set: true))).Select(x => x.Preview));
        Assert.Equal(["order.Discount += 1;"], (await nav.CallersAsync(Accessor(c, "Order", "Discount"))).Select(x => x.Preview));
        Assert.Equal(["Ring"], (await nav.CallersAsync(Accessor(c, "Tax", "Rate"))).Select(x => x.Enclosing.Name));
    }
}

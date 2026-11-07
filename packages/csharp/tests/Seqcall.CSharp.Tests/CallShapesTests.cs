using Seqcall.CSharp.Analysis;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Seqcall.CSharp.Tests;

/// <summary>
/// FR-1 / FR-1.13 calls of shapes the sample solution has not: delegates held by another object or a local, a call
/// that does not compile, a static using, chained and primary-constructor base calls, initializers, accessors.
/// </summary>
public sealed class CallShapesTests
{
    private const string Shop = """
        using System;
        using static Helpers;
        public static class Helpers { public static string Format(int n) => n.ToString(); }
        public class Clock { public static Clock Create() => new(); public int Now() => 0; }
        public class Shop
        {
            public Action<int> OnSold = _ => { };
            public event Action Closed = Clock.Create;
            private readonly int _opened = new Clock().Now();
            private static readonly Clock Shared = Clock.Create();
            static Shop() { }
            public int Hour { get { return new Clock().Now(); } }
            public string Label => Format(Hour);
        }
        public class Till
        {
            public void Sell(Shop s, Func<Func<int, int>> make)
            {
                s.OnSold(1);
                var log = (int x) => { };
                log(2);
                make()(3);
                Format(4);
                missing.Ring();
                Missing();
            }
        }
        public class Delivery { public Delivery(int days) { } public Delivery() : this(Clock.Create().Now()) { } }
        public class Express(int days) : Delivery(days + 1) { }
        public class Courier : Delivery { public Courier() : base(2) { } }
        """;

    private static async Task<(AnalysisContext Ctx, Compilation C)> Load()
    {
        var ctx = await Snippets.ContextAsync(("src/Shop.cs", Shop));
        return (ctx, ctx.Compilations.Single());
    }

    private static List<string> Calls(AnalysisContext ctx, IMethodSymbol m) =>
        new OutgoingCalls(ctx).Of(m).Select(c => $"{c.Kind} {c.MethodName} <{c.Receiver.Kind}{Named(c.Receiver.Name ?? c.Receiver.Text)}>").ToList();

    private static string Named(string? name) => name is null ? "" : $" {name}";

    private static IMethodSymbol Method(Compilation c, string type, string name) =>
        c.GetTypeByMetadataName(type)!.GetMembers(name).OfType<IMethodSymbol>().First();

    [Fact]
    public async Task Delegates_held_elsewhere_a_call_that_does_not_compile_and_a_static_using()
    {
        var (ctx, c) = await Load();
        Assert.Equal(
            [
                "call OnSold <parameter s>",
                "call log <local log>",
                "call make <parameter make>",
                "call Invoke <expression make()>",
                "call Format <static>",
                "call Ring <expression missing>",
                "call Missing <self>",
            ],
            Calls(ctx, Method(c, "Till", "Sell")));
    }

    [Fact]
    public async Task Constructors_run_their_chained_and_base_calls_and_the_initializers()
    {
        var (ctx, c) = await Load();
        var delivery = c.GetTypeByMetadataName("Delivery")!.InstanceConstructors.Single(m => m.Parameters.Length == 0);
        Assert.Equal(["call Create <static>", "call Now <expression Clock.Create()>", "call constructor <self>"], Calls(ctx, delivery));
        Assert.Equal(["call constructor <super>"], Calls(ctx, c.GetTypeByMetadataName("Courier")!.InstanceConstructors.Single()));
        // a primary constructor with a base call: the base call is its body
        var express = c.GetTypeByMetadataName("Express")!.InstanceConstructors.Single();
        Assert.True(Callables.HasBody(express));
        Assert.Equal(["call constructor <super>"], Calls(ctx, express));
        // the implicit constructor runs the instance initializers (the event's method group), the static one the static fields
        var shop = c.GetTypeByMetadataName("Shop")!;
        // (a delegate or method group assigned is not called: only the field's own call runs)
        Assert.Equal(["create constructor <none>", "call Now <created>"], Calls(ctx, shop.InstanceConstructors.Single()));
        Assert.Equal(["call Create <static>"], Calls(ctx, shop.StaticConstructors.Single()));
    }

    [Fact]
    public async Task Accessors_have_bodies_and_their_calls_and_a_position_in_an_initializer_belongs_to_the_constructor()
    {
        var (ctx, c) = await Load();
        var shop = c.GetTypeByMetadataName("Shop")!;
        var hour = ((IPropertySymbol)shop.GetMembers("Hour").Single()).GetMethod!;
        Assert.True(Callables.HasBody(hour));
        Assert.Equal(["create constructor <none>", "call Now <created>"], Calls(ctx, hour));
        var tree = c.SyntaxTrees.Single();
        var model = c.GetSemanticModel(tree);
        var label = tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>().First(i => i.ToString() == "Format(Hour)");
        Assert.Equal("get_Label", Callables.EnclosingCallable(model, label)?.Name);
        var shared = tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>().First(i => i.ToString() == "Clock.Create()" && i.Ancestors().OfType<FieldDeclarationSyntax>().Any());
        Assert.Equal(MethodKind.StaticConstructor, Callables.EnclosingCallable(model, shared)?.MethodKind);
        // an abstract-looking member without a body: none
        Assert.False(Callables.HasBody(c.GetTypeByMetadataName("System.Action")!.DelegateInvokeMethod!));
    }
}

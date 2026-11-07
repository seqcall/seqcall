using Seqcall.CSharp.Analysis;

namespace Seqcall.CSharp.Tests;

/// <summary>FR-8.6 registrations of shapes the sample solution has not: switch / else conditions, typeof pairs, Autofac factories and instances.</summary>
public sealed class BindingShapesTests
{
    // the containers' APIs as far as the analysis looks at them (namespace, method name, type arguments)
    private const string Containers = """
        using System;
        namespace Microsoft.Extensions.DependencyInjection
        {
            public interface IServiceCollection { }
            public static class ServiceCollectionExtensions
            {
                public static IServiceCollection AddScoped<TService, TImpl>(this IServiceCollection s) where TImpl : TService => s;
                public static IServiceCollection AddSingleton(this IServiceCollection s, Type service) => s;
                public static IServiceCollection AddSingleton(this IServiceCollection s, Type service, Type impl) => s;
            }
        }
        namespace Autofac
        {
            public class ContainerBuilder
            {
                public Registration RegisterType(Type t) => new();
                public Registration Register<T>(Func<object, T> factory) => new();
                public Registration RegisterInstance<T>(T instance) => new();
            }
            public class Registration
            {
                public Registration As<T>() => this;
                public Registration InstancePerDependency() => this;
                public Registration PreserveExistingDefaults() => this;
            }
        }
        """;

    private const string Shop = """
        public interface IPayments { }
        public class LivePayments : IPayments { }
        public class FakePayments : IPayments { }
        public interface IClock { }
        public class SystemClock : IClock { }
        """;

    private static async Task<List<string>> Bindings(string code)
    {
        var ctx = await Snippets.ContextAsync(("Containers.cs", Containers), ("src/Shop.cs", Shop), ("src/Startup.cs", code));
        static string Name(string key) => key[(key.IndexOf('#') + 1)..];
        return new Bindings(ctx).Find(default)
            .Select(b => $"{Name(b.Abstract)} → {Name(b.Concrete)} | {b.KeyKind}: {b.Key} | {b.Lifetime}{(b.Fallback == true ? " | fallback" : "")}")
            .ToList();
    }

    [Fact]
    public async Task A_registration_in_a_switch_case_or_an_else_branch_holds_under_that_condition()
    {
        Assert.Equal(
            [
                "IPayments → LivePayments | condition: mode == \"live\" || mode == \"prod\" | scoped",
                "IPayments → FakePayments | condition: default | scoped",
                "IPayments → FakePayments | condition: !(mode == \"live\") | scoped",
            ],
            await Bindings("""
                using Microsoft.Extensions.DependencyInjection;
                public static class Startup
                {
                    public static void Configure(IServiceCollection services, string mode)
                    {
                        switch (mode)
                        {
                            case "live":
                            case "prod":
                                services.AddScoped<IPayments, LivePayments>();
                                break;
                            default:
                                services.AddScoped<IPayments, FakePayments>();
                                break;
                        }
                        if (mode == "live") { }
                        else services.AddScoped<IPayments, FakePayments>();
                    }
                }
                """));
    }

    [Fact]
    public async Task Typeof_pairs_and_a_single_typeof_register_project_types_only()
    {
        Assert.Equal(
            ["IClock → SystemClock | :  | singleton", "SystemClock → SystemClock | :  | singleton"],
            await Bindings("""
                using Microsoft.Extensions.DependencyInjection;
                public static class Startup
                {
                    public static void Configure(IServiceCollection services)
                    {
                        services.AddSingleton(typeof(IClock), typeof(SystemClock));
                        services.AddSingleton(typeof(SystemClock));
                        services.AddSingleton(typeof(System.Random)); // a library type: not the project's
                    }
                }
                """));
    }

    [Fact]
    public async Task Autofac_factories_instances_and_a_type_picked_through_parentheses()
    {
        Assert.Equal(
            [
                "IPayments → LivePayments | :  | transient",
                "IPayments → IPayments | :  | transient | fallback", // a factory that does not show the class: the service itself
                "IPayments → FakePayments | :  | transient",
                "SystemClock → SystemClock | condition: live | transient",
            ],
            await Bindings("""
                using Autofac;
                public static class Startup
                {
                    public static void Configure(ContainerBuilder builder, bool live, System.Type other)
                    {
                        builder.Register(c => new LivePayments()).As<IPayments>().InstancePerDependency();
                        builder.Register<IPayments>(c => Make()).PreserveExistingDefaults();
                        builder.RegisterInstance(new FakePayments()).As<IPayments>();
                        builder.RegisterType((live ? typeof(SystemClock) : typeof(System.Random)));
                        builder.RegisterType(other); // a parameter: no type known
                    }
                    private static IPayments Make() => new FakePayments();
                }
                """));
    }
}

using Seqcall.CSharp.Analysis;

namespace Seqcall.CSharp.Tests;

/// <summary>FR-16.1 / FR-16.13 entry points of shapes the sample solution has not: functions, tests, hosted services, handlers, API versions.</summary>
public sealed class EntryPointShapesTests
{
    private const string Framework = """
        using System;
        using System.Threading;
        using System.Threading.Tasks;
        public class FunctionAttribute(string name) : Attribute { }
        public class FunctionNameAttribute : Attribute { }
        public class FactAttribute : Attribute { }
        public class TestMethodAttribute : Attribute { }
        public class RouteAttribute(string template) : Attribute { }
        public class HttpGetAttribute(string template) : Attribute { }
        public class ApiVersionAttribute : Attribute
        {
            public ApiVersionAttribute(string v) { }
            public ApiVersionAttribute(double v, string? status = null) { }
            public ApiVersionAttribute(int major) { }
            public ApiVersionAttribute(int year, int month, int day) { }
            public ApiVersionAttribute(int major, int minor, bool lookAlike) { }
        }
        public interface IHostedService { Task StartAsync(CancellationToken ct); }
        public interface IConsumer<T> { Task Consume(T message); }
        public interface ICommandHandler { Task HandleAsync(); }
        """;

    private static async Task<List<string>> EntryPoints(string code)
    {
        var ctx = await Snippets.ContextAsync(("Framework.cs", Framework), ("src/Shop.cs", code));
        return new EntryPoints(ctx).Find(default).Select(e => $"{e.Kind} | {e.Label} | {e.Detail}").ToList();
    }

    [Fact]
    public async Task Azure_Functions_are_handlers_named_by_their_attribute()
    {
        Assert.Equal(
            ["handler | OrderFunctions.Expire | Azure Function", "handler | PlaceOrder (OrderFunctions.Run) | Azure Function"],
            await EntryPoints("""
                public class OrderFunctions
                {
                    [Function("PlaceOrder")] public void Run() { }
                    [FunctionName] public void Expire() { }
                }
                """));
    }

    [Fact]
    public async Task Test_methods_name_their_framework_and_hosted_services_and_handlers_are_found_by_interface()
    {
        Assert.Equal(
            [
                "job | Mailer.StartAsync | IHostedService",
                "handler | OrderPlacedConsumer.Consume | MassTransit consumer (OrderPlaced)",
                "handler | RefundHandler.HandleAsync | command handler",
                "test | OrderTests.Creates | xUnit",
                "test | OrderTests.Totals | MSTest",
            ],
            await EntryPoints("""
                using System.Threading;
                using System.Threading.Tasks;
                public class OrderTests
                {
                    [Fact] public void Creates() { }
                    [TestMethod] public void Totals() { }
                }
                public class Mailer : IHostedService { public Task StartAsync(CancellationToken ct) => Task.CompletedTask; }
                public record OrderPlaced;
                public class OrderPlacedConsumer : IConsumer<OrderPlaced> { public Task Consume(OrderPlaced m) => Task.CompletedTask; }
                public class RefundHandler : ICommandHandler { public Task HandleAsync() => Task.CompletedTask; public static void Helper() { } }
                """));
    }

    [Fact]
    public async Task A_route_on_a_base_class_and_every_ApiVersion_form_give_the_routes()
    {
        Assert.Equal(
            [
                "http | GET /api/Orders/{id} | controller",
                "http | GET /v1.0|2.0|2.5-beta|2025-01-15/Shops | controller",
                "http | GET /v4.0/Stock | controller",
            ],
            await EntryPoints("""
                [Route("api/[controller]")] public abstract class ApiBase { }
                public class OrdersController : ApiBase { [HttpGet("{id}")] public void Get(int id) { } }

                [Route("v{version:apiVersion}/[controller]")]
                [ApiVersion(1)] [ApiVersion(2.0)] [ApiVersion(2.5, "beta")] [ApiVersion(2025, 1, 15)] [ApiVersion(1, 3, true)]
                public class ShopsController { [HttpGet("")] public void List() { } }

                // Asp.Versioning not restored: the attribute is unknown, its literal is read as written
                [Route("v{version:apiVersion}/[controller]")]
                public class StockController { [HttpGet("")] [MapToApiVersion(4)] public void List() { } }
                """));
    }
}

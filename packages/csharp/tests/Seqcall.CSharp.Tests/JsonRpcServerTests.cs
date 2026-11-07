using System.Text.Json.Nodes;
using Seqcall.CSharp.Rpc;

namespace Seqcall.CSharp.Tests;

/// <summary>
/// The JSON-RPC layer in-process, over the loaded sample (the end-to-end test runs it in a child process, where
/// coverage is not collected): errors by code, notifications, shutdown, and every method reaching the adapter.
/// </summary>
[Collection(SampleCollection.Name)]
public sealed class JsonRpcServerTests(SampleFixture f)
{
    private const string Service = "src/Sample.Core/Services/BillingService.cs";
    private const string Describe = Service + "#BillingService.Describe(decimal)";

    private JsonRpcServer Server() => new(f.Adapter, TestPaths.SampleRoot, null);

    private async Task<JsonObject> Call(string line)
    {
        var (response, _) = await Server().HandleLineAsync(line);
        Assert.NotNull(response);
        return (JsonObject)JsonNode.Parse(response!)!;
    }

    private Task<JsonObject> Request(string method, object? parameters, int id = 1) =>
        Call(System.Text.Json.JsonSerializer.Serialize(new { jsonrpc = "2.0", id, method, @params = parameters }));

    private static (int Code, string Message) ErrorOf(JsonObject r)
    {
        Assert.False(r.ContainsKey("result"), r.ToJsonString());
        return (r["error"]!["code"]!.GetValue<int>(), r["error"]!["message"]!.GetValue<string>());
    }

    [Fact]
    public async Task A_line_that_is_no_JSON_object_or_has_no_method_is_an_error_with_its_code()
    {
        var parse = await Call("{not json");
        Assert.Equal(JsonRpcServer.ParseError, ErrorOf(parse).Code);
        Assert.StartsWith("Parse error: ", ErrorOf(parse).Message);
        Assert.Null(parse["id"]);
        Assert.Equal((JsonRpcServer.InvalidRequest, "Request must be a JSON object"), ErrorOf(await Call("[1, 2]")));
        var noMethod = await Call("""{"jsonrpc":"2.0","id":7}""");
        Assert.Equal((JsonRpcServer.InvalidRequest, "Missing method"), ErrorOf(noMethod));
        Assert.Equal(7, noMethod["id"]!.GetValue<int>());
        Assert.Equal((JsonRpcServer.MethodNotFound, "Method not found: getEverything"), ErrorOf(await Request("getEverything", new { })));
    }

    [Theory]
    [InlineData("getMethod", "Missing params")]
    [InlineData("getOutgoingCalls", "Missing params")]
    public async Task A_method_without_params_says_so(string method, string message)
    {
        Assert.Equal((JsonRpcServer.InvalidParams, message), ErrorOf(await Request(method, null)));
    }

    [Theory]
    [InlineData("getMethod", "{}", "Missing parameter: key")]
    [InlineData("findEnclosingCallable", """{"file":"a.cs"}""", "Missing parameter: position")]
    [InlineData("findEnclosingCallable", """{"position":{"line":1,"character":0}}""", "Missing parameter: file")]
    [InlineData("getCallers", "{}", "Missing parameter: method")]
    [InlineData("getCallers", """{"method":{}}""", "Missing parameter: method.key")]
    [InlineData("getClassInfo", "{}", "Missing parameter: classKey")]
    [InlineData("getModuleFacts", "{}", "Missing parameter: classKey")]
    [InlineData("getHostsOf", "{}", "Missing parameter: file")]
    [InlineData("getFileTypes", "{}", "Missing parameter: file")]
    [InlineData("updateFile", "{}", "Missing parameter: file")]
    public async Task A_missing_parameter_is_named(string method, string parameters, string message)
    {
        var r = await Call($$"""{"jsonrpc":"2.0","id":1,"method":"{{method}}","params":{{parameters}}}""");
        Assert.Equal((JsonRpcServer.InvalidParams, message), ErrorOf(r));
    }

    [Fact]
    public async Task Params_of_the_wrong_shape_are_invalid_params()
    {
        var (code, message) = ErrorOf(await Call("""{"jsonrpc":"2.0","id":1,"method":"getMethod","params":{"key":42}}"""));
        Assert.Equal(JsonRpcServer.InvalidParams, code);
        Assert.StartsWith("Invalid params: ", message);
    }

    [Fact]
    public async Task A_failure_in_the_adapter_is_an_internal_error_and_the_server_answers_the_next_request()
    {
        using var fresh = new CSharpAdapter(); // not initialized: every call fails
        var server = new JsonRpcServer(fresh, TestPaths.SampleRoot, null);
        var (failed, stop) = await server.HandleLineAsync($$$"""{"jsonrpc":"2.0","id":"a","method":"getMethod","params":{"key":"{{{Describe}}}"}}""");
        var error = (JsonObject)JsonNode.Parse(failed!)!;
        Assert.Equal((JsonRpcServer.InternalError, "InvalidOperationException: Not initialized: call initialize first"), ErrorOf(error));
        Assert.Equal("a", error["id"]!.GetValue<string>());
        Assert.False(stop);
        // initialize with its own root: a missing folder is reported, not a crash
        var (init, _) = await server.HandleLineAsync("""{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"projectRoot":"/no/such/root"}}""");
        Assert.Equal((JsonRpcServer.InternalError, "DirectoryNotFoundException: Project root not found: /no/such/root"), ErrorOf((JsonObject)JsonNode.Parse(init!)!));
    }

    [Fact]
    public async Task FR_34_1_getMemory_reports_this_process_with_its_working_set_and_managed_heap()
    {
        var r = (await Request("getMemory", new { }))["result"]!;
        Assert.Equal(Environment.ProcessId, r["pid"]!.GetValue<int>());
        var workingSet = r["workingSet"]!.GetValue<long>();
        var heap = r["managedHeap"]!.GetValue<long>();
        Assert.True(heap > 0 && workingSet > heap, $"working set {workingSet}, managed heap {heap}");
    }

    [Fact]
    public async Task A_notification_gets_no_answer_and_shutdown_or_exit_end_the_loop()
    {
        Assert.Equal((null, false), await Server().HandleLineAsync($$$"""{"jsonrpc":"2.0","method":"getMethod","params":{"key":"{{{Describe}}}"}}"""));
        Assert.Equal((null, true), await Server().HandleLineAsync("""{"jsonrpc":"2.0","method":"shutdown"}"""));
        var (exit, stop) = await Server().HandleLineAsync("""{"jsonrpc":"2.0","id":3,"method":"exit"}""");
        Assert.Equal("""{"jsonrpc":"2.0","id":3,"result":null}""", exit);
        Assert.False(stop, "exit answers; only shutdown stops the loop");
    }

    [Fact]
    public async Task The_loop_answers_line_by_line_skips_blank_lines_and_stops_at_shutdown()
    {
        var input = new StringReader(string.Join("\n",
            $$$"""{"jsonrpc":"2.0","id":1,"method":"getMethod","params":{"key":"{{{Describe}}}"}}""",
            "",
            "   ",
            """{"jsonrpc":"2.0","id":2,"method":"shutdown"}""",
            """{"jsonrpc":"2.0","id":3,"method":"getEntryPoints"}"""));
        var output = new StringWriter();
        await Server().RunAsync(input, output);
        var lines = output.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(2, lines.Length);
        Assert.Equal(Describe, JsonNode.Parse(lines[0])!["result"]!["key"]!.GetValue<string>());
        Assert.Equal("""{"jsonrpc":"2.0","id":2,"result":null}""", lines[1]);
        // stdin closed: the loop ends
        var closed = new StringWriter();
        await Server().RunAsync(new StringReader(""), closed);
        Assert.Equal("", closed.ToString());
    }

    [Fact]
    public async Task Every_method_reaches_the_adapter_with_its_params()
    {
        var file = TestPaths.File(Service);
        var method = new { key = Describe };
        var at = TestPaths.PositionOf(Service, "Format.Money(amount);");
        var enclosing = await Request("findEnclosingCallable", new { file, position = new { line = at.Line, character = at.Character } });
        Assert.Equal(Describe, enclosing["result"]!["key"]!.GetValue<string>());
        Assert.NotEmpty(Results(await Request("getOutgoingCalls", new { method })));
        Assert.IsType<JsonArray>((await Request("getImplementations", new { method }))["result"]);
        Assert.IsType<JsonArray>((await Request("getCallers", new { method }))["result"]);
        Assert.IsType<JsonArray>((await Request("getTypeUses", new { method }))["result"]);
        Assert.Equal(0, (await Request("getValueUses", new { method }))["result"]!.GetValue<int>());
        Assert.IsType<JsonArray>((await Request("getEarlyExits", new { method }))["result"]);
        Assert.IsType<JsonArray>((await Request("getReturns", new { method }))["result"]);
        Assert.Equal(["amount"], Results(await Request("getParameterNames", new { method })).Select(n => n!.GetValue<string>()));
        Assert.Equal(Service + "#BillingService", (await Request("getClassInfo", new { classKey = Service + "#BillingService" }))["result"]!["ref"]!["key"]!.GetValue<string>());
        Assert.NotNull((await Request("getModuleFacts", new { classKey = Service + "#BillingService" }))["result"]);
        Assert.NotNull((await Request("getBindings", null))["result"]);
        Assert.IsType<JsonArray>((await Request("getHostsOf", new { file }))["result"]);
        Assert.NotEmpty(Results(await Request("getEntryPoints", null)));
        Assert.Contains("BillingService", Results(await Request("getFileTypes", new { file })).Select(n => n!["type"]!["name"]!.GetValue<string>()));
        // FR-31.1 the types of every file of the solution (a partial class once per file), each method once
        var types = Results(await Request("getProjectTypes", null));
        Assert.Contains(types, n => n!["type"]!["key"]!.GetValue<string>().EndsWith("#BillingService"));
        var methods = types.SelectMany(n => n!["methods"]!.AsArray()).Select(m => m!["key"]!.GetValue<string>()).ToList();
        Assert.NotEmpty(methods);
        Assert.Equal(methods.Count, methods.Distinct().Count());
        // updateFile with the file's own text: nothing changes, the answer is null
        var update = await Request("updateFile", new { file, content = File.ReadAllText(file) });
        Assert.True(update.ContainsKey("result") && update["result"] is null, update.ToJsonString());
    }

    private static JsonArray Results(JsonObject r) => Assert.IsType<JsonArray>(r["result"], exactMatch: false);
}

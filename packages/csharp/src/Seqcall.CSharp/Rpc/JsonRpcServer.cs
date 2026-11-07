using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Seqcall.CSharp.Protocol;

namespace Seqcall.CSharp.Rpc;

/// <summary>JSON-RPC error with a protocol error code.</summary>
public sealed class RpcException(int code, string message) : Exception(message)
{
    public int Code { get; } = code;
}

/// <summary>
/// Newline-delimited JSON-RPC 2.0 over stdio: one request per line on the input, one response per
/// line on the output; requests are processed in order; a failing request returns an error and the
/// server keeps running.
/// </summary>
public sealed class JsonRpcServer
{
    public const int ParseError = -32700;
    public const int InvalidRequest = -32600;
    public const int MethodNotFound = -32601;
    public const int InvalidParams = -32602;
    public const int InternalError = -32603;

    private readonly CSharpAdapter _adapter;
    private readonly string _defaultRoot;
    private readonly string? _defaultSolution;

    public JsonRpcServer(CSharpAdapter adapter, string defaultRoot, string? defaultSolution)
    {
        _adapter = adapter;
        _defaultRoot = defaultRoot;
        _defaultSolution = defaultSolution;
    }

    public async Task RunAsync(TextReader input, TextWriter output, CancellationToken ct = default)
    {
        while (!ct.IsCancellationRequested)
        {
            var line = await input.ReadLineAsync(ct).ConfigureAwait(false);
            if (line is null) break; // stdin closed
            if (string.IsNullOrWhiteSpace(line)) continue;
            var (response, shutdown) = await HandleLineAsync(line, ct).ConfigureAwait(false);
            if (response is not null)
            {
                await output.WriteAsync(response + "\n").ConfigureAwait(false);
                await output.FlushAsync(ct).ConfigureAwait(false);
            }
            if (shutdown) break;
        }
    }

    /// <summary>Handles one request line; returns the response line (null for notifications).</summary>
    public async Task<(string? Response, bool Shutdown)> HandleLineAsync(string line, CancellationToken ct = default)
    {
        JsonNode? id = null;
        string? method = null;
        try
        {
            JsonObject request;
            try
            {
                request = JsonNode.Parse(line) as JsonObject ?? throw new RpcException(InvalidRequest, "Request must be a JSON object");
            }
            catch (JsonException ex)
            {
                return (Error(null, ParseError, $"Parse error: {ex.Message}"), false);
            }
            id = request["id"]?.DeepClone();
            var isNotification = !request.ContainsKey("id");
            method = request["method"]?.GetValue<string>() ?? throw new RpcException(InvalidRequest, "Missing method");
            var parameters = request["params"];
            var started = DateTime.UtcNow;
            var result = await DispatchAsync(method, parameters, ct).ConfigureAwait(false);
            Log.Debug($"{method} {(DateTime.UtcNow - started).TotalMilliseconds:0} ms");
            var shutdown = method == "shutdown";
            if (isNotification) return (null, shutdown);
            return (Success(id, result), shutdown);
        }
        catch (RpcException ex)
        {
            Log.Warn($"{method ?? "?"}: {ex.Message}");
            return (Error(id, ex.Code, ex.Message), false);
        }
        catch (Exception ex)
        {
            Log.Error($"{method ?? "?"} failed: {ex}");
            return (Error(id, InternalError, $"{ex.GetType().Name}: {ex.Message}"), false);
        }
    }

    private async Task<object?> DispatchAsync(string method, JsonNode? parameters, CancellationToken ct)
    {
        switch (method)
        {
            case "initialize":
                {
                    var p = parameters is null ? null : Params<InitializeParams>(parameters);
                    return await _adapter.InitializeAsync(p?.ProjectRoot ?? _defaultRoot, p?.Solution ?? _defaultSolution, ct).ConfigureAwait(false);
                }
            case "findEnclosingCallable":
                {
                    var p = Params<FileParams>(parameters);
                    Require(p.File, "file");
                    Require(p.Position, "position");
                    return await _adapter.FindEnclosingCallableAsync(p.File, p.Position, ct).ConfigureAwait(false);
                }
            case "getMethod":
                {
                    var p = Params<KeyParams>(parameters);
                    Require(p.Key, "key");
                    return await _adapter.GetMethodAsync(p.Key, ct).ConfigureAwait(false);
                }
            case "getOutgoingCalls":
                return await _adapter.GetOutgoingCallsAsync(MethodKey(parameters), ct).ConfigureAwait(false);
            case "getImplementations":
                return await _adapter.GetImplementationsAsync(MethodKey(parameters), ct).ConfigureAwait(false);
            case "getCallers":
                return await _adapter.GetCallersAsync(MethodKey(parameters), ct).ConfigureAwait(false);
            case "getValueUses":
                return await _adapter.GetValueUsesAsync(MethodKey(parameters), ct).ConfigureAwait(false);
            case "getClassInfo":
                {
                    var p = Params<ClassKeyParams>(parameters);
                    Require(p.ClassKey, "classKey");
                    return await _adapter.GetClassInfoAsync(p.ClassKey, ct).ConfigureAwait(false);
                }
            case "getTypeUses":
                return await _adapter.GetTypeUsesAsync(MethodKey(parameters), ct).ConfigureAwait(false);
            case "getModuleFacts":
                {
                    var p = Params<ClassKeyParams>(parameters);
                    Require(p.ClassKey, "classKey");
                    return await _adapter.GetModuleFactsAsync(p.ClassKey, ct).ConfigureAwait(false);
                }
            case "getBindings":
                return await _adapter.GetBindingsAsync(ct).ConfigureAwait(false);
            case "getHostsOf":
                {
                    var p = Params<FilePathParams>(parameters);
                    Require(p.File, "file");
                    return await _adapter.GetHostsOfAsync(p.File, ct).ConfigureAwait(false);
                }
            case "getEntryPoints":
                return await _adapter.GetEntryPointsAsync(ct).ConfigureAwait(false);
            case "getEarlyExits":
                return await _adapter.GetEarlyExitsAsync(MethodKey(parameters), ct).ConfigureAwait(false);
            case "getReturns":
                return await _adapter.GetReturnsAsync(MethodKey(parameters), ct).ConfigureAwait(false);
            case "getParameterNames":
                return await _adapter.GetParameterNamesAsync(MethodKey(parameters), ct).ConfigureAwait(false);
            case "getFileTypes":
                {
                    var p = Params<FilePathParams>(parameters);
                    Require(p.File, "file");
                    return await _adapter.GetFileTypesAsync(p.File, ct).ConfigureAwait(false);
                }
            case "getProjectTypes":
                return await _adapter.GetProjectTypesAsync(ct).ConfigureAwait(false);
            case "updateFile":
                {
                    var p = Params<UpdateFileParams>(parameters);
                    Require(p.File, "file");
                    await _adapter.UpdateFileAsync(p.File, p.Content, ct).ConfigureAwait(false);
                    return null;
                }
            case "getMemory":
                {
                    // FR-34.1 what this process holds: the loaded solution, Roslyn's compilations and caches
                    using var self = System.Diagnostics.Process.GetCurrentProcess();
                    return new MemoryResult(self.Id, self.WorkingSet64, GC.GetTotalMemory(false));
                }
            case "shutdown":
            case "exit":
                return null;
            default:
                throw new RpcException(MethodNotFound, $"Method not found: {method}");
        }
    }

    private static string MethodKey(JsonNode? parameters)
    {
        var p = Params<MethodParams>(parameters);
        Require(p.Method, "method");
        Require(p.Method.Key, "method.key");
        return p.Method.Key;
    }

    private static T Params<T>(JsonNode? parameters)
    {
        if (parameters is null) throw new RpcException(InvalidParams, "Missing params");
        try
        {
            return parameters.Deserialize<T>(Json.Options) ?? throw new RpcException(InvalidParams, "Invalid params");
        }
        catch (JsonException ex)
        {
            throw new RpcException(InvalidParams, $"Invalid params: {ex.Message}");
        }
    }

    private static void Require(object? value, string name)
    {
        if (value is null) throw new RpcException(InvalidParams, $"Missing parameter: {name}");
    }

    private static string Success(JsonNode? id, object? result)
    {
        var sb = new StringBuilder();
        sb.Append("{\"jsonrpc\":\"2.0\",\"id\":");
        sb.Append(id?.ToJsonString() ?? "null");
        sb.Append(",\"result\":");
        sb.Append(result is null ? "null" : JsonSerializer.Serialize(result, result.GetType(), Json.Options));
        sb.Append('}');
        return sb.ToString();
    }

    private static string Error(JsonNode? id, int code, string message)
    {
        var error = new JsonObject
        {
            ["jsonrpc"] = "2.0",
            ["id"] = id?.DeepClone(),
            ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
        };
        return error.ToJsonString();
    }
}

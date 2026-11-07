using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Seqcall.CSharp.Tests;

/// <summary>Launches the built sidecar and talks newline-delimited JSON-RPC over stdio.</summary>
public sealed class EndToEndTests
{
    private static string SidecarDll()
    {
        // tests/Seqcall.CSharp.Tests/bin/<Configuration>/net10.0 → src/Seqcall.CSharp/bin/<Configuration>/net10.0
        var baseDir = new DirectoryInfo(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar));
        var configuration = baseDir.Parent!.Name;
        var packageDir = Path.GetFullPath(Path.Combine(TestPaths.RepoRoot, "packages", "csharp"));
        foreach (var c in new[] { configuration, "Release", "Debug" })
        {
            var dll = Path.Combine(packageDir, "src", "Seqcall.CSharp", "bin", c, "net10.0", "Seqcall.CSharp.dll");
            if (File.Exists(dll)) return dll;
        }
        throw new FileNotFoundException("Seqcall.CSharp.dll not built");
    }

    [Fact]
    public async Task Initialize_find_calls_and_shutdown_over_stdio()
    {
        var root = TestPaths.SampleRoot;
        var psi = new ProcessStartInfo("dotnet")
        {
            WorkingDirectory = root,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add(SidecarDll());
        psi.ArgumentList.Add("--root");
        psi.ArgumentList.Add(root);
        using var process = Process.Start(psi)!;
        var stderr = new System.Text.StringBuilder();
        process.ErrorDataReceived += (_, e) => { lock (stderr) stderr.AppendLine(e.Data); };
        process.BeginErrorReadLine();
        var id = 0;

        async Task<JsonObject> Call(string method, object parameters)
        {
            var request = JsonSerializer.Serialize(new { jsonrpc = "2.0", id = ++id, method, @params = parameters });
            await process.StandardInput.WriteLineAsync(request);
            await process.StandardInput.FlushAsync();
            var line = await process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromMinutes(2));
            Assert.True(line is not null, $"no response to {method}; stderr:\n{stderr}");
            var response = JsonNode.Parse(line!)!.AsObject();
            Assert.Equal("2.0", (string?)response["jsonrpc"]);
            Assert.Equal(id, (int)response["id"]!);
            return response;
        }

        var init = await Call("initialize", new { projectRoot = root });
        Assert.Equal(4, init["result"]!["projects"]!.AsArray().Count);

        const string rel = "src/Sample.Core/Services/UserService.cs";
        var file = TestPaths.File(rel);
        var position = TestPaths.PositionOf(rel, "new UserDto(");
        var found = await Call("findEnclosingCallable", new { file, position = new { line = position.Line, character = position.Character } });
        var method = found["result"]!.AsObject();
        Assert.Equal("src/Sample.Core/Services/UserService.cs#UserService.GetUserDtoAsync(string)", (string?)method["key"]);
        Assert.Equal("UserService", (string?)method["owner"]!["name"]);

        var calls = await Call("getOutgoingCalls", new { method });
        var names = calls["result"]!.AsArray().Select(c => (string)c!["methodName"]!).ToArray();
        Assert.Equal(["FindUserAsync", "Title", "Slugify", "constructor"], names);
        Assert.Equal("create", (string?)calls["result"]![3]!["kind"]);
        Assert.Null(calls["result"]![1]!["argOrigins"]); // nulls are omitted

        // FR-12.12: type uses over stdio
        var shipFile = TestPaths.File("src/Sample.Core/Services/ShippingService.cs");
        var shipPos = TestPaths.PositionOf("src/Sample.Core/Services/ShippingService.cs", "provider.ToOrderStatus()");
        var ship = (await Call("findEnclosingCallable", new { file = shipFile, position = new { line = shipPos.Line, character = shipPos.Character } }))["result"]!.AsObject();
        var uses = await Call("getTypeUses", new { method = ship });
        var used = uses["result"]!.AsArray().Select(u => (string)u!["type"]!["key"]!).ToArray();
        Assert.Contains("src/Sample.Core/Util/Enums.cs#Enums", used);
        Assert.NotNull(uses["result"]![0]!["range"]!["start"]);

        // a failing request returns an error and the process keeps serving
        var bad = await Call("noSuchMethod", new { });
        Assert.Equal(-32601, (int)bad["error"]!["code"]!);
        var missing = await Call("getMethod", new { key = "src/Nope.cs#Nope.M()" });
        Assert.True(missing.ContainsKey("result"));
        Assert.Null(missing["result"]);

        var shutdown = await Call("shutdown", new { });
        Assert.True(shutdown.ContainsKey("result"));
        Assert.True(process.WaitForExit(30_000), "sidecar did not exit after shutdown");
        Assert.Equal(0, process.ExitCode);
    }
}

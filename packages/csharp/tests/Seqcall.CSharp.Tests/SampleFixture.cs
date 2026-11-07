using Seqcall.CSharp.Protocol;
using Seqcall.CSharp.Workspace;

namespace Seqcall.CSharp.Tests;

public static class TestPaths
{
    /// <summary>fixtures/sample-cs (found by walking up from the test binaries), restored before first use.</summary>
    public static string SampleRoot { get; } = Restored(FindUp(Path.Combine("fixtures", "sample-cs")));

    public static string RepoRoot { get; } = Path.GetFullPath(Path.Combine(SampleRoot, "..", ".."));

    public static string File(string rel) => Path.Combine(SampleRoot, rel).Replace('\\', '/');

    private static string FindUp(string relative)
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, relative);
            if (Directory.Exists(candidate)) return candidate;
        }
        throw new DirectoryNotFoundException($"{relative} not found above {AppContext.BaseDirectory}");
    }

    // Sample.Batch uses a NuGet package (Autofac): without a restore its registrations are not found (issue #1).
    // Not done as a build step: a `dotnet restore` started from inside a build hangs the build.
    private static string Restored(string root)
    {
        if (System.IO.File.Exists(Path.Combine(root, "src", "Sample.Batch", "obj", "project.assets.json"))) return root;
        var dotnet = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH") is { Length: > 0 } host ? host : "dotnet";
        var start = new System.Diagnostics.ProcessStartInfo(dotnet, ["restore", "Sample.sln", "-nologo", "-nodeReuse:false"])
        {
            WorkingDirectory = root,
            RedirectStandardOutput = true,
        };
        using var restore = System.Diagnostics.Process.Start(start)!;
        var output = restore.StandardOutput.ReadToEnd();
        restore.WaitForExit();
        if (restore.ExitCode != 0) throw new InvalidOperationException($"dotnet restore of {root} failed:\n{output}");
        return root;
    }

    /// <summary>0-based position of the first occurrence of <paramref name="needle"/> (plus offset) in a fixture file.</summary>
    public static Position PositionOf(string rel, string needle, int offset = 0)
    {
        var lines = System.IO.File.ReadAllLines(File(rel));
        for (var i = 0; i < lines.Length; i++)
        {
            var c = lines[i].IndexOf(needle, StringComparison.Ordinal);
            if (c >= 0) return new Position(i, c + offset);
        }
        throw new InvalidOperationException($"'{needle}' not found in {rel}");
    }
}

/// <summary>One loaded adapter over fixtures/sample-cs shared by the read-only tests.</summary>
public sealed class SampleFixture : IAsyncLifetime
{
    public CSharpAdapter Adapter { get; } = new();

    public InitializeResult Init { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        MsBuildRegistration.Register(TestPaths.SampleRoot);
        Init = await Adapter.InitializeAsync(TestPaths.SampleRoot, null);
    }

    public Task DisposeAsync()
    {
        Adapter.Dispose();
        return Task.CompletedTask;
    }

    public async Task<MethodRef> MethodAt(string rel, string needle, int offset = 0)
    {
        var m = await Adapter.FindEnclosingCallableAsync(TestPaths.File(rel), TestPaths.PositionOf(rel, needle, offset));
        Assert.NotNull(m);
        return m!;
    }

    public async Task<MethodRef> Method(string key)
    {
        var m = await Adapter.GetMethodAsync(key);
        Assert.True(m is not null, $"method not resolved: {key}");
        return m!;
    }

    public Task<IReadOnlyList<CallSite>> Calls(MethodRef m) => Adapter.GetOutgoingCallsAsync(m.Key);
}

[CollectionDefinition(Name)]
public sealed class SampleCollection : ICollectionFixture<SampleFixture>
{
    public const string Name = "sample-cs";
}

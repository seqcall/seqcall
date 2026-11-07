using Seqcall.CSharp.Workspace;

namespace Seqcall.CSharp.Tests;

/// <summary>Mutates its own adapter instance (never the files on disk).</summary>
public sealed class UpdateFileTests : IAsyncLifetime
{
    private readonly CSharpAdapter _adapter = new();

    public async Task InitializeAsync()
    {
        MsBuildRegistration.Register(TestPaths.SampleRoot);
        await _adapter.InitializeAsync(TestPaths.SampleRoot, null);
    }

    public Task DisposeAsync()
    {
        _adapter.Dispose();
        return Task.CompletedTask;
    }

    [Fact]
    public async Task Changed_added_and_removed_files_are_picked_up()
    {
        const string rel = "src/Sample.Core/Services/BillingService.cs";
        const string key = rel + "#BillingService.Describe(decimal)";
        var file = TestPaths.File(rel);
        var original = await File.ReadAllTextAsync(file);

        // changed content
        var changed = original.Replace("public string Describe(decimal amount) => Format.Money(amount);",
            "public string Describe(decimal amount) => Format.Title(Format.Money(amount));");
        Assert.NotEqual(original, changed);
        await _adapter.UpdateFileAsync(file, changed);
        Assert.Equal(["Money", "Title"], (await _adapter.GetOutgoingCallsAsync(key)).Select(c => c.MethodName));

        // re-read from disk restores the original
        await _adapter.UpdateFileAsync(file, null);
        Assert.Equal(["Money"], (await _adapter.GetOutgoingCallsAsync(key)).Select(c => c.MethodName));

        // a new file (content given, not on disk) joins its project
        var added = TestPaths.File("src/Sample.Core/Services/AuditService.cs");
        await _adapter.UpdateFileAsync(added, """
            namespace Sample.Core.Services;

            public class AuditService(UserService users)
            {
                public Task Audit(string id) => users.FindUserAsync(id);
            }
            """);
        var audit = await _adapter.GetMethodAsync("src/Sample.Core/Services/AuditService.cs#AuditService.Audit(string)");
        Assert.NotNull(audit);
        var call = Assert.Single(await _adapter.GetOutgoingCallsAsync(audit!.Key));
        Assert.Equal("src/Sample.Core/Services/UserService.cs#UserService.FindUserAsync(string)", call.Target!.Key);
        var callers = await _adapter.GetCallersAsync("src/Sample.Core/Services/UserService.cs#UserService.FindUserAsync(string)");
        Assert.Contains(callers, c => c.Enclosing.Key == audit.Key);

        // deleted (no content, not on disk)
        await _adapter.UpdateFileAsync(added, null);
        Assert.Null(await _adapter.GetMethodAsync(audit.Key));
    }
}

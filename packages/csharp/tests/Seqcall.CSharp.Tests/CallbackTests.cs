using Seqcall.CSharp.Protocol;

namespace Seqcall.CSharp.Tests;

/// <summary>FR-1.11: calls inside lambdas — inline for library methods, carried for project methods.</summary>
[Collection(SampleCollection.Name)]
public sealed class CallbackTests(SampleFixture f)
{
    private const string File = "src/Sample.Core/Services/SyncService.cs";

    private static string Scopes(CallSite c) =>
        c.Fragments is null ? "" : " " + string.Join(" ", c.Fragments.Select(s => $"{s.Kind}[{s.Guard}]"));

    [Fact]
    public async Task FR_1_11_lambdas_passed_to_library_methods_follow_the_call_in_loop_or_callback_scopes()
    {
        var calls = await f.Calls(await f.MethodAt(File, "var names = users.Where("));
        Assert.Equal(
            [
                "Where",
                "Select",
                "Label loop[each u in users.Where(…)]",
                "ToList",
                "Select",
                "SaveAsync loop[each u in users]",
                "WhenAll",
                "RunAsync",
                "FindByIdAsync",
                "ContinueWith",
                "Title callback[repo.FindByIdAsync(…).ContinueWith]",
            ],
            calls.Select(c => c.MethodName + Scopes(c)));
        Assert.Equal(Enumerable.Range(0, calls.Count), calls.Select(c => c.Ordinal));
        // inside the lambda the primary-constructor parameter is still the field
        Assert.Equal(ReceiverOrigin.Field("repo"), calls[5].Receiver);
        Assert.Equal(new ArgumentOrigin("parameter", "u"), calls[5].ArgOrigins![0]);
    }

    [Fact]
    public async Task FR_1_11_a_lambda_passed_to_a_project_method_carries_its_body()
    {
        var calls = await f.Calls(await f.MethodAt(File, "var names = users.Where("));
        var run = calls.Single(c => c.MethodName == "RunAsync");
        var fn = run.ArgFunctions![0]!;
        Assert.Equal("lambda", fn.Kind);
        Assert.Equal([], fn.Params!);
        Assert.Equal(["FindByIdAsync"], fn.Calls!.Select(c => c.MethodName));
        Assert.Equal(0, fn.Calls![0].Ordinal);
        Assert.Equal(ReceiverOrigin.Field("repo"), fn.Calls[0].Receiver);
        // a library method's lambda carries no body (it is inlined instead)
        Assert.Null(calls.Single(c => c.MethodName == "ContinueWith").ArgFunctions![0]!.Calls);
    }
}

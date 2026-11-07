using Seqcall.CSharp.Protocol;

namespace Seqcall.CSharp.Tests;

/// <summary>FR-1.13: method groups / lambdas passed as arguments, delegate parameters invoked.</summary>
[Collection(SampleCollection.Name)]
public sealed class DelegateTests(SampleFixture f)
{
    private const string File = "src/Sample.Core/Services/FormatService.cs";
    private const string Key = File + "#";

    private async Task<IReadOnlyList<CallSite>> CallsOf(string needle) => await f.Calls(await f.MethodAt(File, needle));

    [Fact]
    public async Task FR_1_13_method_groups_and_lambdas_passed_as_arguments()
    {
        var renders = (await CallsOf("var plain = Render(")).Where(c => c.MethodName == "Render").ToList();
        Assert.Equal(3, renders.Count);
        var plain = renders[0].ArgFunctions![1]!;
        Assert.Equal("method", plain.Kind);
        Assert.Equal($"{Key}UserFormat.Plain(User)", plain.Target!.Key);
        Assert.Equal("static", plain.Receiver!.Kind);
        Assert.False(plain.IsLibrary);
        var shout = renders[1].ArgFunctions![1]!;
        Assert.Equal($"{Key}FormatService.Shout(User)", shout.Target!.Key);
        Assert.Equal("self", shout.Receiver!.Kind);
        Assert.Equal("lambda", renders[2].ArgFunctions![1]!.Kind);
        Assert.Null(renders[0].ArgFunctions![0]); // users is not a function
        // a delegate parameter passed on is bound through argOrigins, not as a function value
        var each = (await CallsOf("=> Each(users, format)")).Single();
        Assert.Null(each.ArgFunctions);
        Assert.Equal(new ArgumentOrigin("parameter", "format"), each.ArgOrigins![1]);
    }

    [Fact]
    public async Task FR_1_13_extension_calls_list_the_receiver_as_first_argument()
    {
        var apply = (await CallsOf("user.Apply(UserFormat.Plain)")).Single();
        Assert.Equal(["UserFormat.Plain"], apply.Args); // labels show the written arguments
        Assert.Equal(new ArgumentOrigin("parameter", "user"), apply.ArgOrigins![0]);
        Assert.Null(apply.ArgFunctions![0]);
        Assert.Equal($"{Key}UserFormat.Plain(User)", apply.ArgFunctions![1]!.Target!.Key);
    }

    [Fact]
    public async Task FR_1_13_a_delegate_type_declared_in_the_solution_is_reported_as_the_port()
    {
        var named = (await CallsOf("=> formatter(user)")).Single();
        Assert.Equal("formatter", named.InvokedParameter);
        Assert.Equal($"{Key}Formatter", named.InvokedParameterType!.Key);
        // Func<…> is a library type: no port
        Assert.Null((await CallsOf("result.Add(f(user))")).Single(c => c.MethodName == "f").InvokedParameterType);
    }

    [Fact]
    public async Task FR_1_13_a_method_group_passed_to_an_overloaded_generic_method_is_resolved()
    {
        var read = (await CallsOf("=> Read(user, Describe)")).Single();
        Assert.Equal($"{Key}FormatService.Describe(User)", read.ArgFunctions![1]!.Target!.Key);
    }

    [Fact]
    public async Task FR_6_5_named_arguments_are_aligned_with_their_parameters()
    {
        var pick = (await CallsOf("=> Pick(format: UserFormat.Plain, user: user)")).Single();
        Assert.Equal(new ArgumentOrigin("parameter", "user"), pick.ArgOrigins![0]); // parameter 0 is `user`
        Assert.Null(pick.ArgOrigins[1]);
        Assert.Equal($"{Key}UserFormat.Plain(User)", pick.ArgFunctions![1]!.Target!.Key);
    }

    [Fact]
    public async Task FR_4_5_a_method_group_passed_as_an_argument_has_the_receiving_call_as_caller()
    {
        var callers = await f.Adapter.GetCallersAsync($"{Key}UserFormat.Plain(User)");
        string Of(string method) => string.Join(",", callers.Where(c => c.Enclosing.Name == method).Select(c => c.Passed == true ? "passed" : "call"));
        Assert.Equal("call", Of("Shout"));          // UserFormat.Plain(user)
        Assert.Equal("passed", Of("FormatAll"));    // Render(users, UserFormat.Plain)
        Assert.Equal("passed", Of("Via"));          // user.Apply(UserFormat.Plain)
        var via = callers.Single(c => c.Enclosing.Name == "Via");
        Assert.Contains("user.Apply(UserFormat.Plain)", via.Preview);
    }

    [Fact]
    public async Task FR_31_1_a_method_group_stored_is_a_value_use_calls_passing_nameof_and_docs_are_not()
    {
        Assert.Equal(1, await f.Adapter.GetValueUsesAsync($"{Key}UserFormat.Loud(User)"));  // options.Fallback = UserFormat.Loud
        Assert.Equal(0, await f.Adapter.GetValueUsesAsync($"{Key}UserFormat.Quiet(User)")); // nameof, <see cref>
        Assert.Equal(0, await f.Adapter.GetValueUsesAsync($"{Key}UserFormat.Plain(User)")); // called and passed
        Assert.Equal(0, await f.Adapter.GetValueUsesAsync($"{Key}UserFormat.Missing(User)"));
        Assert.Empty(await f.Adapter.GetCallersAsync($"{Key}UserFormat.Quiet(User)")); // nameof passes no method
    }

    [Fact]
    public async Task FR_1_13_invoking_a_delegate_parameter_directly_or_with_Invoke()
    {
        var f1 = (await CallsOf("result.Add(f(user))")).Single(c => c.MethodName == "f");
        Assert.Equal("f", f1.InvokedParameter);
        Assert.Null(f1.Target);
        Assert.False(f1.IsLibrary);
        var pick = (await CallsOf("pick.Invoke(user)")).Single();
        Assert.Equal(("pick", "pick"), (pick.MethodName, pick.InvokedParameter));
        Assert.Null(pick.Target);
        Assert.False(pick.IsLibrary);
    }
}

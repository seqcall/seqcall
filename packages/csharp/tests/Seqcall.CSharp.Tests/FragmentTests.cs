using Seqcall.CSharp.Analysis;
using Seqcall.CSharp.Protocol;

namespace Seqcall.CSharp.Tests;

/// <summary>FR-1.10: enclosing control-flow constructs of call sites (combined fragments).</summary>
[Collection(SampleCollection.Name)]
public sealed class FragmentTests(SampleFixture f)
{
    private const string Import = "src/Sample.Core/Services/ImportService.cs";

    private static string Describe(CallSite c) =>
        c.Fragments is null ? "-" : string.Join(" / ", c.Fragments.Select(s => $"{s.Kind}#{s.Operand}[{s.Guard}]"));

    private async Task<IReadOnlyList<CallSite>> CallsOf(string needle) => await f.Calls(await f.MethodAt(Import, needle));

    [Fact]
    public async Task FR_1_10_loop_if_chain_opt_and_try_catch()
    {
        var calls = await CallsOf("var imported = 0;");
        Assert.Equal(
            [
                "Title: loop#0[each user in users] / alt#0[user.Name.Length == 0]",
                "SaveAsync: loop#0[each user in users] / alt#1[user.ManagerId is not null]",
                "Rename: loop#0[each user in users] / alt#2[else]",
                "SaveAsync: loop#0[each user in users] / alt#2[else]",
                "Title: opt#0[announce]",
                "FindByIdAsync: try#0[]",
                "Title: try#1[catch InvalidOperationException when ex.Message.Length > 0]",
                "Title: -",
            ],
            calls.Select(c => $"{c.MethodName}: {Describe(c)}"));
        // all scopes of one construct share the id; the condition range is the navigation target
        var alt = calls.Take(4).Select(c => c.Fragments![1].Id).Distinct();
        Assert.Single(alt);
        Assert.Equal(TestPaths.PositionOf(Import, "user.Name.Length == 0"), calls[0].Fragments![1].Range!.Start);
        Assert.Null(calls[0].Fragments![1].NegatedGuard);
        // FR-1.17 the try scope lists its catch clauses and what they do with the error
        var handler = Assert.Single(calls[5].Fragments![0].Handlers!);
        Assert.Equal((1, "catch InvalidOperationException when ex.Message.Length > 0", "swallow", (string?)null, false), (handler.Operand, handler.Guard, handler.Outcome, handler.Value, handler.Logged));
    }

    [Fact]
    public async Task FR_19_1_a_call_that_leaves_the_loop_is_marked()
    {
        var calls = await CallsOf("var user = await repo.FindByIdAsync(id);");
        Assert.Equal(
            ["FindByIdAsync: False", "FindByIdAsync: True", "Title: True", "constructor: True"],
            calls.Select(c => $"{c.MethodName}: {c.Fragments!.First(s => s.Kind == "loop").LeavesLoop ?? false}"));
    }

    [Fact]
    public async Task FR_1_17_catch_that_logs_and_returns_a_value()
    {
        var calls = await CallsOf("return await repo.FindByIdAsync(id);");
        var find = calls.Single(c => c.MethodName == "FindByIdAsync");
        var handler = Assert.Single(find.Fragments![0].Handlers!);
        Assert.Equal(("return", "null", true), (handler.Outcome, handler.Value, handler.Logged));
    }

    [Fact]
    public async Task FR_1_10_switch_while_conditional_switch_expression_for_and_nested_ifs()
    {
        var calls = await CallsOf("var attempts = 0;");
        Assert.Equal(
            [
                "SaveAsync: alt#0[mode = \"full\" | \"deep\"]",
                "Title: alt#1[else]",
                "FindByIdAsync: loop#0[attempts < 3]",
                "Describe: loop#0[attempts < 3] / alt#0[found is not null]",
                "Fallback: loop#0[attempts < 3] / alt#1[else]",
                "Describe: alt#0[mode = \"full\"]",
                "Fallback: alt#1[else]",
                "Rename: loop#0[i < 2] / opt#0[user.Active] / opt#0[text.Length > 0]",
                "users: -",
                "ForEach: -",
                "Describe: loop#0[each u in users()]",
            ],
            calls.Select(c => $"{c.MethodName}: {Describe(c)}"));
        // the else branch of a two-way ?: knows its negated condition (drawn when only it is visible)
        Assert.Equal("!(found is not null)", calls[4].Fragments![1].NegatedGuard);
    }

    [Theory]
    [InlineData("x", "!x")]
    [InlineData("!x", "x")]
    [InlineData("a.IsReady()", "!a.IsReady()")]
    [InlineData("a > b", "!(a > b)")]
    public void FR_1_10_negated_guards(string guard, string negated) => Assert.Equal(negated, FragmentScopes.Negate(guard));
}

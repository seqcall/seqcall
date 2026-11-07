using Seqcall.CSharp.Analysis;
using Seqcall.CSharp.Protocol;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Xunit;

namespace Seqcall.CSharp.Tests;

public class CallResultsTests
{
    /// <summary>ResultOf the first invocation of <paramref name="name"/> in a method body.</summary>
    private static CallResult? ResultOf(string body, string name = "F")
    {
        var tree = CSharpSyntaxTree.ParseText($"class A {{ object M(bool c, object a) {{ {body} }} }}");
        var call = tree.GetRoot().DescendantNodes().OfType<InvocationExpressionSyntax>()
            .First(i => i.Expression.ToString().EndsWith(name));
        return CallResults.ResultOf(call);
    }

    [Fact]
    public void FR_9_4_the_value_passes_through_conditional_branches_and_coalesce_not_through_a_condition()
    {
        Assert.Equal(new CallResult("assign", "x", "="), ResultOf("var x = c ? F() : G(); return x;"));
        Assert.Equal(new CallResult("assign", "x", "="), ResultOf("var x = c ? G() : (F()); return x;"));
        Assert.Equal(new CallResult("return"), ResultOf("return a ?? F();"));
        Assert.Null(ResultOf("var x = F() ? 1 : 2; return x;")); // the condition
        Assert.Null(ResultOf("var x = c || F(); return x;")); // a bool, not F's value
        Assert.Null(ResultOf("G(c ? F() : 0); return null;"));
    }
}

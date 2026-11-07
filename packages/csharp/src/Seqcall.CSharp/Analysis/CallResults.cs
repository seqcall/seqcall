using System.Text.RegularExpressions;
using Seqcall.CSharp.Protocol;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Seqcall.CSharp.Analysis;

/// <summary>FR-9.4 / FR-9.5: where an invocation's result goes, and its declared return type.</summary>
public static partial class CallResults
{
    /// <summary>
    /// <c>var user = await F()</c> → user, <c>_cache = F()</c> / <c>this.Cache ??= F()</c> → target with operator,
    /// <c>var (a, b) = F()</c> → (a, b), <c>return F()</c> / <c>=> F()</c> → return; otherwise null
    /// (argument of another call, condition, discarded). The value passes through <c>c ? F() : G()</c> and <c>a ?? F()</c>.
    /// </summary>
    public static CallResult? ResultOf(ExpressionSyntax call)
    {
        SyntaxNode node = call;
        while (true)
        {
            var parent = node.Parent;
            switch (parent)
            {
                case ParenthesizedExpressionSyntax or CastExpressionSyntax or AwaitExpressionSyntax:
                case PostfixUnaryExpressionSyntax pu when pu.IsKind(SyntaxKind.SuppressNullableWarningExpression):
                case ConditionalAccessExpressionSyntax ca when ca.WhenNotNull == node:
                case ConditionalExpressionSyntax ce when ce.WhenTrue == node || ce.WhenFalse == node:
                case BinaryExpressionSyntax be when be.IsKind(SyntaxKind.CoalesceExpression):
                    node = parent;
                    continue;
                case MemberAccessExpressionSyntax { Name.Identifier.ValueText: "ConfigureAwait" } ma when ma.Expression == node && ma.Parent is InvocationExpressionSyntax cfg:
                    node = cfg;
                    continue;
                case EqualsValueClauseSyntax { Parent: VariableDeclaratorSyntax vd }:
                    return new CallResult("assign", vd.Identifier.ValueText, "=");
                case EqualsValueClauseSyntax { Parent: PropertyDeclarationSyntax pd }:
                    return new CallResult("assign", pd.Identifier.ValueText, "=");
                case AssignmentExpressionSyntax a when a.Right == node:
                    return new CallResult("assign", Target(a.Left), a.OperatorToken.Text);
                case ReturnStatementSyntax or ArrowExpressionClauseSyntax:
                    return new CallResult("return");
                case LambdaExpressionSyntax l when l.Body == node:
                    return new CallResult("return");
                default:
                    return null;
            }
        }
    }

    /// <summary><c>this.Cache</c> → Cache, <c>var (a, b)</c> → (a, b), whitespace collapsed.</summary>
    private static string Target(ExpressionSyntax left)
    {
        var text = Whitespace().Replace(left.ToString(), " ").Trim();
        text = ThisPrefix().Replace(text, "");
        text = VarKeyword().Replace(text, "");
        return text;
    }

    /// <summary>Upper bound for one regex match on code text (S6444).</summary>
    private const int RegexTimeoutMs = 1000;

    [GeneratedRegex(@"\s+", RegexOptions.None, RegexTimeoutMs)]
    private static partial Regex Whitespace();

    [GeneratedRegex(@"^this\.", RegexOptions.None, RegexTimeoutMs)]
    private static partial Regex ThisPrefix();

    [GeneratedRegex(@"\bvar\s+", RegexOptions.None, RegexTimeoutMs)]
    private static partial Regex VarKeyword();

    /// <summary>Declared return type, awaited when the call is awaited (Task&lt;T&gt; → T); null for void / Task / errors.</summary>
    public static string? ReturnTypeOf(IMethodSymbol? method, bool awaited)
    {
        if (method is null || method.ReturnsVoid) return null;
        var type = method.ReturnType;
        if (awaited && OutgoingCalls.ReturnsAwaitable(method))
        {
            if (type is not INamedTypeSymbol { TypeArguments.Length: 1 } generic) return null; // Task / ValueTask
            type = generic.TypeArguments[0];
        }
        if (type.TypeKind == TypeKind.Error) return null;
        return type.ToDisplayString(SymbolDisplayFormat.MinimallyQualifiedFormat);
    }
}

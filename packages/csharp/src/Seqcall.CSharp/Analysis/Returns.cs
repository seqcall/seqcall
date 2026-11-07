using Seqcall.CSharp.Protocol;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Seqcall.CSharp.Analysis;

/// <summary>
/// FR-5.8: every <c>return</c> of a method body (an expression body counts as one) and what it returns — a tuple
/// literal element by element (<c>return (order, OrderStatus.Ok)</c>). Lambdas and local functions are
/// not the body. Syntax only: a returned identifier is a local variable when the body declares it.
/// </summary>
public static class Returns
{
    public static IReadOnlyList<ReturnFact> Of(IMethodSymbol method)
    {
        var result = new List<ReturnFact>();
        foreach (var r in SymbolRefs.Canonical(method).DeclaringSyntaxReferences)
        {
            var (body, arrow) = r.GetSyntax() switch
            {
                BaseMethodDeclarationSyntax m => ((SyntaxNode?)m.Body, m.ExpressionBody),
                AccessorDeclarationSyntax a => (a.Body, a.ExpressionBody),
                LocalFunctionStatementSyntax f => (f.Body, f.ExpressionBody),
                _ => (null, null),
            };
            if (arrow is not null)
            {
                result.Add(Fact(arrow.Expression, arrow.Expression, Locals(arrow)));
                continue;
            }
            if (body is null) continue;
            var locals = Locals(body);
            foreach (var node in body.DescendantNodes(n => n == body || !EarlyExits.IsNested(n)))
            {
                if (node is not ReturnStatementSyntax ret) continue;
                result.Add(ret.Expression is null
                    ? new ReturnFact(SymbolRefs.Range(ret), null, [])
                    : Fact(ret, ret.Expression, locals));
            }
        }
        return result;
    }

    private static ReturnFact Fact(SyntaxNode statement, ExpressionSyntax expression, HashSet<string> locals)
    {
        var range = SymbolRefs.Range(statement);
        if (Unwrap(expression) is TupleExpressionSyntax tuple)
            return new ReturnFact(range, true, tuple.Arguments.Select(a => Value(a.Expression, locals)).ToList());
        return new ReturnFact(range, null, [Value(expression, locals)]);
    }

    private static ReturnValue Value(ExpressionSyntax expression, HashSet<string> locals)
    {
        var e = Unwrap(expression);
        var range = SymbolRefs.Range(e);
        return e switch
        {
            LiteralExpressionSyntax l when l.IsKind(SyntaxKind.NullLiteralExpression) || l.IsKind(SyntaxKind.DefaultLiteralExpression) => new ReturnValue(range, null, true),
            DefaultExpressionSyntax => new ReturnValue(range, null, true),
            IdentifierNameSyntax id when locals.Contains(id.Identifier.ValueText) => new ReturnValue(range, id.Identifier.ValueText, null),
            _ => new ReturnValue(range, null, null),
        };
    }

    /// <summary><c>await</c>, parentheses, casts and <c>!</c> are not part of the value.</summary>
    private static ExpressionSyntax Unwrap(ExpressionSyntax e)
    {
        while (true)
        {
            switch (e)
            {
                case ParenthesizedExpressionSyntax p: e = p.Expression; continue;
                case AwaitExpressionSyntax a: e = a.Expression; continue;
                case CastExpressionSyntax c: e = c.Expression; continue;
                case PostfixUnaryExpressionSyntax pu when pu.IsKind(SyntaxKind.SuppressNullableWarningExpression): e = pu.Operand; continue;
                default: return e;
            }
        }
    }

    /// <summary>Names the body declares (<c>var x</c>, <c>var (a, b)</c>, <c>out var x</c>, patterns), outside lambdas.</summary>
    private static HashSet<string> Locals(SyntaxNode body)
    {
        var names = new HashSet<string>();
        foreach (var n in body.DescendantNodes(n => n == body || !EarlyExits.IsNested(n)))
        {
            switch (n)
            {
                case VariableDeclaratorSyntax v: names.Add(v.Identifier.ValueText); break;
                case SingleVariableDesignationSyntax d: names.Add(d.Identifier.ValueText); break;
                case ForEachStatementSyntax f: names.Add(f.Identifier.ValueText); break;
            }
        }
        return names;
    }
}

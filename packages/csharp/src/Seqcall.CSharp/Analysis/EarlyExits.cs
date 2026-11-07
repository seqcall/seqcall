using Seqcall.CSharp.Protocol;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Seqcall.CSharp.Analysis;

/// <summary>
/// FR-1.15: <c>return</c> / <c>throw</c> statements of a method body that are not in tail position (on
/// another path the method continues after them). Lambdas and local functions are not the body.
/// </summary>
public static class EarlyExits
{
    public static IReadOnlyList<EarlyExit> Of(IMethodSymbol method)
    {
        var result = new List<EarlyExit>();
        foreach (var r in SymbolRefs.Canonical(method).DeclaringSyntaxReferences)
        {
            var body = r.GetSyntax() switch
            {
                BaseMethodDeclarationSyntax m => m.Body,
                AccessorDeclarationSyntax a => a.Body,
                LocalFunctionStatementSyntax f => f.Body,
                _ => null,
            };
            if (body is null) continue;
            foreach (var node in body.DescendantNodes(n => n == body || !IsNested(n)))
            {
                if (node is not (ReturnStatementSyntax or ThrowStatementSyntax) || IsTail((StatementSyntax)node, body)) continue;
                var thrown = (node as ThrowStatementSyntax)?.Expression;
                result.Add(new EarlyExit(
                    node is ReturnStatementSyntax ? "return" : "throw",
                    SymbolRefs.Range(node),
                    thrown switch
                    {
                        null => null,
                        ObjectCreationExpressionSyntax c => SymbolRefs.CompactText(c.Type),
                        _ => SymbolRefs.CompactText(thrown),
                    },
                    FragmentScopes.Of(node),
                    node is ReturnStatementSyntax ret ? (ret.Expression is null ? "" : SymbolRefs.CompactText(ret.Expression)) : null));
            }
        }
        return result;
    }

    internal static bool IsNested(SyntaxNode n) => n is AnonymousFunctionExpressionSyntax or LocalFunctionStatementSyntax or TypeDeclarationSyntax;

    /// <summary>Nothing of the method runs after <paramref name="stmt"/> on its path.</summary>
    public static bool IsTail(StatementSyntax stmt, BlockSyntax body)
    {
        SyntaxNode node = stmt;
        while (true)
        {
            var parent = node.Parent;
            switch (parent)
            {
                case BlockSyntax block:
                    {
                        var rest = block.Statements.SkipWhile(s => s != node).Skip(1);
                        if (rest.Any(s => s is not (LocalFunctionStatementSyntax or EmptyStatementSyntax))) return false;
                        if (block == body) return true;
                        break;
                    }
                case SwitchSectionSyntax section:
                    {
                        var rest = section.Statements.SkipWhile(s => s != node).Skip(1);
                        if (rest.Any(s => s is not (BreakStatementSyntax or EmptyStatementSyntax))) return false;
                        break;
                    }
                case IfStatementSyntax or ElseClauseSyntax or SwitchStatementSyntax or TryStatementSyntax or CatchClauseSyntax
                    or LabeledStatementSyntax or UsingStatementSyntax or LockStatementSyntax or CheckedStatementSyntax
                    or UnsafeStatementSyntax or FixedStatementSyntax:
                    break;
                default:
                    return false; // loops (the loop goes on), finally, anything unexpected
            }
            node = parent;
        }
    }
}

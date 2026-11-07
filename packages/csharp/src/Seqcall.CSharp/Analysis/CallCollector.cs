using Seqcall.CSharp.Protocol;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Seqcall.CSharp.Analysis;

/// <summary>
/// Collects call-like nodes in evaluation order: post-order (receiver and arguments before the
/// call), object creation before its initializer, statements in source order. Local function
/// bodies are not entered; of a query expression only the first source expression is evaluated
/// eagerly. Lambdas are entered only where <c>inline</c> returns a scope for them (FR-1.11: a
/// lambda passed to a library method runs during that call) — their calls follow the receiving
/// call, with the lambda's scope (and the receiving call's own scopes) as prefix.
/// </summary>
public static class CallCollector
{
    /// <param name="Accessor">FR-1.18 <c>get</c> / <c>set</c>: the node is a property read / assignment that runs that accessor.</param>
    public sealed record Collected(SyntaxNode Node, IReadOnlyList<FragmentScope> Prefix, string? Accessor = null);

    /// <param name="handOff">
    /// FR-17.7 a call that hands work to code running later (<c>block.Post(x)</c> on a dataflow block): the lambdas that
    /// run it (or a method group: then a call of that method), with their scope. Their calls follow the call, as inlined
    /// lambdas do; each lambda is entered once per path.
    /// </param>
    /// <param name="accessor">
    /// FR-1.18 for a property reference (<c>order.Total</c>, <c>Total</c>, <c>a?.Total</c>): <c>get</c> / <c>set</c> when
    /// reading / assigning it runs an accessor of the project with a body; null for fields, auto-properties, libraries.
    /// </param>
    public static List<Collected> Collect(
        IEnumerable<SyntaxNode> roots,
        Func<SyntaxNode, AnonymousFunctionExpressionSyntax, FragmentScope?>? inline = null,
        Func<SyntaxNode, IReadOnlyList<(ExpressionSyntax Runs, FragmentScope Scope)>>? handOff = null,
        Func<ExpressionSyntax, string?>? accessor = null)
    {
        var calls = new List<Collected>();
        IReadOnlyList<FragmentScope> prefix = [];
        var entered = new HashSet<SyntaxNode>();

        void Add(SyntaxNode call)
        {
            calls.Add(new Collected(call, prefix));
            if (inline is null) return;
            var args = call switch
            {
                InvocationExpressionSyntax i => i.ArgumentList.Arguments,
                BaseObjectCreationExpressionSyntax c => c.ArgumentList?.Arguments ?? default,
                _ => default,
            };
            foreach (var a in args)
            {
                var e = a.Expression;
                while (e is ParenthesizedExpressionSyntax p) e = p.Expression;
                if (e is not AnonymousFunctionExpressionSyntax lambda) continue;
                var scope = inline(call, lambda);
                if (scope is null) continue;
                var outer = prefix;
                prefix = [.. outer, .. FragmentScopes.Of(call) ?? [], scope];
                Visit(lambda.Body);
                prefix = outer;
            }
            if (handOff is null) return;
            foreach (var (runs, scope) in handOff(call))
            {
                if (!entered.Add(runs)) continue; // a handler posting to its own block
                var outer = prefix;
                prefix = [.. outer, .. FragmentScopes.Of(call) ?? [], scope];
                if (runs is AnonymousFunctionExpressionSyntax lambda) Visit(lambda.Body);
                else calls.Add(new Collected(runs, prefix)); // `new ActionBlock<T>(Handle)`: a call of Handle
                prefix = outer;
                entered.Remove(runs);
            }
        }

        void Access(ExpressionSyntax e)
        {
            if (accessor?.Invoke(e) is { } kind) calls.Add(new Collected(e, prefix, kind));
        }

        void Visit(SyntaxNode node)
        {
            switch (node)
            {
                case AnonymousFunctionExpressionSyntax:
                case LocalFunctionStatementSyntax:
                case BaseTypeDeclarationSyntax:
                    return;
                case InvocationExpressionSyntax nameOf when IsNameOf(nameOf):
                    return; // `nameof(order.Total)` reads nothing
                case AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.SimpleAssignmentExpression } a when accessor is not null && IsPropertyReference(a.Left):
                    // the setter runs after the receiver and the assigned value are evaluated
                    if (a.Left is MemberAccessExpressionSyntax target) Visit(target.Expression);
                    Visit(a.Right);
                    Access(a.Left);
                    return;
                case QueryExpressionSyntax q:
                    Visit(q.FromClause.Expression);
                    return;
                case AnonymousObjectCreationExpressionSyntax:
                    break; // not a constructor call; its member initializers are visited below
                case BaseObjectCreationExpressionSyntax c:
                    if (c.ArgumentList is not null) Visit(c.ArgumentList);
                    Add(c);
                    if (c.Initializer is not null) Visit(c.Initializer);
                    return;
                case ConstructorInitializerSyntax ci:
                    Visit(ci.ArgumentList);
                    Add(ci);
                    return;
                case PrimaryConstructorBaseTypeSyntax pb:
                    Visit(pb.ArgumentList);
                    Add(pb);
                    return;
            }
            foreach (var child in node.ChildNodes()) Visit(child);
            if (node is InvocationExpressionSyntax inv) Add(inv);
            else if (accessor is not null && node is ExpressionSyntax e && IsPropertyReference(e)) Access(e);
        }

        foreach (var root in roots) Visit(root);
        return calls;
    }

    /// <summary>
    /// A member reference that may be a property read: <c>a.B</c>, <c>a?.B</c>'s <c>.B</c>, or a bare <c>B</c> — not the
    /// name inside <c>a.B</c>, not a method being called, not the left of <c>B = …</c> in an object initializer.
    /// </summary>
    private static bool IsPropertyReference(ExpressionSyntax e)
    {
        if (e.Parent is InvocationExpressionSyntax call && call.Expression == e) return false;
        return e switch
        {
            MemberAccessExpressionSyntax or MemberBindingExpressionSyntax => true,
            // `new Order { Total = 5 }`: set on the created object, not drawn
            IdentifierNameSyntax { Parent: AssignmentExpressionSyntax { Parent: InitializerExpressionSyntax } init } id when init.Left == id => false,
            IdentifierNameSyntax id => !(id.Parent is MemberAccessExpressionSyntax ma && ma.Name == id) && !(id.Parent is MemberBindingExpressionSyntax mb && mb.Name == id),
            _ => false,
        };
    }

    public static bool IsCallNode(SyntaxNode n) =>
        n is InvocationExpressionSyntax or BaseObjectCreationExpressionSyntax or ConstructorInitializerSyntax or PrimaryConstructorBaseTypeSyntax;

    private static bool IsNameOf(InvocationExpressionSyntax inv) =>
        inv.Expression is IdentifierNameSyntax { Identifier.ValueText: "nameof" } &&
        inv.ArgumentList.Arguments.Count == 1;

    /// <summary>The conditional access providing the receiver of a member binding (<c>a?.M()</c>).</summary>
    public static ConditionalAccessExpressionSyntax? ConditionalAccessOf(SyntaxNode node)
    {
        for (var n = node.Parent; n is not null; n = n.Parent)
        {
            if (n is ConditionalAccessExpressionSyntax ca && ca.WhenNotNull.Span.Contains(node.Span)) return ca;
            if (n is StatementSyntax or LambdaExpressionSyntax) break;
        }
        return null;
    }
}

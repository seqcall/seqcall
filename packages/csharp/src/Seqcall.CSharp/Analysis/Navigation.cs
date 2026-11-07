using Seqcall.CSharp.Protocol;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FindSymbols;

namespace Seqcall.CSharp.Analysis;

/// <summary>Implementations (FR-8) and callers (FR-4.1) via SymbolFinder.</summary>
public sealed class Navigation
{
    private readonly AnalysisContext _ctx;

    public Navigation(AnalysisContext ctx) => _ctx = ctx;

    private SymbolRefs Refs => _ctx.Refs;

    /// <summary>
    /// Concrete source members implementing an interface member or overriding an abstract / virtual
    /// member (transitively), excluding test code; sorted by owner name, then key.
    /// </summary>
    public async Task<IReadOnlyList<MethodRef>> ImplementationsAsync(IMethodSymbol method, CancellationToken ct = default)
    {
        var solution = _ctx.Solution;
        var origin = SymbolRefs.Canonical(method);
        var found = new List<ISymbol>();
        var queue = new Queue<ISymbol>();
        var visited = new HashSet<string>(StringComparer.Ordinal);
        queue.Enqueue(origin);
        while (queue.Count > 0)
        {
            var current = queue.Dequeue();
            if (!visited.Add(Refs.MemberKey(current))) continue;
            var next = new List<ISymbol>();
            if (current.ContainingType?.TypeKind == TypeKind.Interface)
            {
                next.AddRange(await SymbolFinder.FindImplementationsAsync(current, solution, cancellationToken: ct).ConfigureAwait(false));
            }
            if (current.IsAbstract || current.IsVirtual || current.IsOverride)
            {
                next.AddRange(await SymbolFinder.FindOverridesAsync(current, solution, cancellationToken: ct).ConfigureAwait(false));
            }
            foreach (var n in next)
            {
                found.Add(n);
                queue.Enqueue(n);
            }
        }

        var originKey = Refs.MethodKey(origin);
        var result = new Dictionary<string, MethodRef>(StringComparer.Ordinal);
        foreach (var s in found)
        {
            if (s is not IMethodSymbol m || !SymbolRefs.IsSource(m)) continue;
            var loc = Refs.PrimaryLocation(m);
            if (loc?.SourceTree is { } tree && _ctx.IsTestFile(tree.FilePath)) continue;
            var r = Refs.MethodRefOf(m);
            if (r.Key == originKey || !r.HasBody || r.Owner.Kind == ClassKinds.Interface) continue;
            result[r.Key] = r;
        }
        return result.Values
            .OrderBy(r => r.Owner.Name, StringComparer.Ordinal)
            .ThenBy(r => r.Key, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>
    /// Call sites of the method (also via the interface members / base members it implements, as
    /// Find All References cascades), mapped to their enclosing callable; production code first,
    /// test code last, then by location.
    /// </summary>
    public async Task<IReadOnlyList<CallerInfo>> CallersAsync(IMethodSymbol method, CancellationToken ct = default)
    {
        var solution = _ctx.Solution;
        var target = SymbolRefs.Canonical(method);
        var isCtor = target.MethodKind == MethodKind.Constructor;
        // FR-1.18 a property accessor is run by reading / assigning the property (Find References may list them under it)
        var isAccessor = target.MethodKind is MethodKind.PropertyGet or MethodKind.PropertySet;
        var referenced = await SymbolFinder.FindReferencesAsync(target, solution, ct).ConfigureAwait(false);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var callers = new List<(CallerInfo Info, bool IsTest)>();
        foreach (var group in referenced)
        {
            if (group.Definition is not IMethodSymbol && !(isAccessor && SymbolEqualityComparer.Default.Equals(group.Definition, target.AssociatedSymbol))) continue;
            foreach (var loc in group.Locations)
            {
                if (loc.IsImplicit || !loc.Location.IsInSource || loc.Location.SourceTree is not { } tree) continue;
                var model = _ctx.ModelOf(tree);
                if (model is null) continue;
                var node = (await tree.GetRootAsync(ct).ConfigureAwait(false)).FindNode(loc.Location.SourceSpan, getInnermostNodeForTie: true);
                var call = isCtor ? CreationOfReference(node) : isAccessor ? AccessOfReference(node, target) : InvocationOfReference(node);
                // FR-4.5: passed as a method group — the call receiving it is the caller
                var passed = false;
                if (call is null && !isCtor && !InNameOf(node) && ReceivingCallOfReference(node) is { } receiving)
                {
                    call = receiving;
                    passed = true;
                }
                if (call is null) continue;
                var enclosing = Callables.EnclosingCallable(model, call);
                if (enclosing is null) continue;
                var range = SymbolRefs.Range(call);
                var rel = _ctx.RelativePath(tree.FilePath);
                var id = $"{rel}:{range.Start.Line + 1}:{range.Start.Character + 1}";
                if (!seen.Add(id)) continue;
                var text = await tree.GetTextAsync(ct).ConfigureAwait(false);
                var line = range.Start.Line < text.Lines.Count ? text.Lines[range.Start.Line].ToString() : "";
                callers.Add((new CallerInfo(id, Refs.MethodRefOf(enclosing), range, SymbolRefs.Collapse(line), passed ? true : null), _ctx.IsTestFile(tree.FilePath)));
            }
        }
        return callers
            .OrderBy(c => c.IsTest)
            .ThenBy(c => c.Info.Id, NaturalComparer.Instance)
            .Select(c => c.Info)
            .ToList();
    }

    /// <summary>
    /// FR-31.1 references to the method outside test code that use it as a value — a method group assigned, added to
    /// an event, kept in an initializer or returned — not calls, not passed to a call (both are callers), not
    /// <c>nameof</c> and not documentation.
    /// </summary>
    public async Task<int> ValueUsesAsync(IMethodSymbol method, CancellationToken ct = default)
    {
        var referenced = await SymbolFinder.FindReferencesAsync(SymbolRefs.Canonical(method), _ctx.Solution, ct).ConfigureAwait(false);
        var uses = 0;
        foreach (var group in referenced)
        {
            foreach (var loc in group.Locations)
            {
                if (loc.IsImplicit || !loc.Location.IsInSource || loc.Location.SourceTree is not { } tree || _ctx.IsTestFile(tree.FilePath)) continue;
                var node = (await tree.GetRootAsync(ct).ConfigureAwait(false)).FindNode(loc.Location.SourceSpan, findInsideTrivia: true, getInnermostNodeForTie: true);
                if (node.IsPartOfStructuredTrivia() || InvocationOfReference(node) is not null || ReceivingCallOfReference(node) is not null || InNameOf(node)) continue;
                uses++;
            }
        }
        return uses;
    }

    private static bool InNameOf(SyntaxNode node) =>
        node.AncestorsAndSelf().OfType<InvocationExpressionSyntax>().Any(i => i.Expression is IdentifierNameSyntax { Identifier.ValueText: "nameof" });

    /// <summary>The invocation whose callee is exactly the referenced name (method groups are not calls).</summary>
    private static SyntaxNode? InvocationOfReference(SyntaxNode node)
    {
        var name = node as SimpleNameSyntax ?? node.DescendantNodesAndSelf().OfType<SimpleNameSyntax>().FirstOrDefault();
        if (name is null) return null;
        SyntaxNode callee = name;
        if (name.Parent is MemberAccessExpressionSyntax ma && ma.Name == name) callee = ma;
        else if (name.Parent is MemberBindingExpressionSyntax mb && mb.Name == name) callee = mb;
        if (callee.Parent is not InvocationExpressionSyntax inv || inv.Expression != callee) return null;
        if (callee is MemberBindingExpressionSyntax && CallCollector.ConditionalAccessOf(inv) is { } ca) return ca;
        return inv;
    }

    /// <summary>
    /// FR-1.18 the read (getter) / assignment (setter) of the property a reference names; <c>+=</c> and the like do both.
    /// </summary>
    private static SyntaxNode? AccessOfReference(SyntaxNode node, IMethodSymbol accessor)
    {
        var name = node as SimpleNameSyntax ?? node.DescendantNodesAndSelf().OfType<SimpleNameSyntax>().FirstOrDefault();
        // `nameof(order.Total)` reads nothing
        if (name is null || InNameOf(node)) return null;
        ExpressionSyntax access = name.Parent switch
        {
            MemberAccessExpressionSyntax ma when ma.Name == name => ma,
            MemberBindingExpressionSyntax mb when mb.Name == name => mb,
            _ => name,
        };
        var assignment = access.Parent is AssignmentExpressionSyntax a && a.Left == access ? a : null;
        var writes = assignment is not null;
        var reads = assignment is null || !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression);
        return (accessor.MethodKind == MethodKind.PropertySet ? writes : reads) ? access : null;
    }

    /// <summary>FR-4.5: the invocation / creation that receives the referenced method group as an argument.</summary>
    private static SyntaxNode? ReceivingCallOfReference(SyntaxNode node)
    {
        var name = node as SimpleNameSyntax ?? node.DescendantNodesAndSelf().OfType<SimpleNameSyntax>().FirstOrDefault();
        if (name is null) return null;
        ExpressionSyntax arg = name.Parent is MemberAccessExpressionSyntax ma && ma.Name == name ? ma : name;
        while (arg.Parent is ParenthesizedExpressionSyntax p) arg = p;
        if (arg.Parent is not ArgumentSyntax { Parent: ArgumentListSyntax { Parent: var call } }) return null;
        return call is InvocationExpressionSyntax or BaseObjectCreationExpressionSyntax ? call : null;
    }

    private static SyntaxNode? CreationOfReference(SyntaxNode node)
    {
        foreach (var a in node.AncestorsAndSelf())
        {
            switch (a)
            {
                case BaseObjectCreationExpressionSyntax c:
                    return c;
                case ConstructorInitializerSyntax ci:
                    return ci;
                case PrimaryConstructorBaseTypeSyntax pb:
                    return pb;
                case StatementSyntax or MemberDeclarationSyntax:
                    return null;
            }
        }
        return null;
    }
}

/// <summary>Ordinal comparison treating digit runs numerically ("a:9" &lt; "a:10").</summary>
public sealed class NaturalComparer : IComparer<string>
{
    public static readonly NaturalComparer Instance = new();

    public int Compare(string? x, string? y)
    {
        if (ReferenceEquals(x, y)) return 0;
        if (x is null) return -1;
        if (y is null) return 1;
        int i = 0, j = 0;
        while (i < x.Length && j < y.Length)
        {
            if (char.IsDigit(x[i]) && char.IsDigit(y[j]))
            {
                var si = i;
                var sj = j;
                while (i < x.Length && char.IsDigit(x[i])) i++;
                while (j < y.Length && char.IsDigit(y[j])) j++;
                var a = x[si..i].TrimStart('0');
                var b = y[sj..j].TrimStart('0');
                if (a.Length != b.Length) return a.Length - b.Length;
                var c = string.CompareOrdinal(a, b);
                if (c != 0) return c;
                continue;
            }
            if (x[i] != y[j]) return x[i] - y[j];
            i++;
            j++;
        }
        return (x.Length - i) - (y.Length - j);
    }
}

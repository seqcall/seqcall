using Seqcall.CSharp.Protocol;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Seqcall.CSharp.Analysis;

/// <summary>
/// FR-12.12: the source types a callable references — parameter / return types and every name in
/// the body that binds to a type (declarations, casts, <c>is</c>/<c>as</c>, <c>typeof</c>,
/// <c>nameof</c>, generic arguments, <c>new X()</c>, <c>var</c>) or to a static / const member
/// (enum constants, static properties, static methods) → its containing type. Nested types are
/// reported as their top-level containing type; metadata types, type parameters and the
/// callable's own type are skipped. One entry per type, at its first reference (source order).
/// </summary>
public sealed class TypeUses
{
    private readonly AnalysisContext _ctx;

    public TypeUses(AnalysisContext ctx) => _ctx = ctx;

    public IReadOnlyList<TypeUse> Of(IMethodSymbol method)
    {
        var m = SymbolRefs.Canonical(method);
        var ownKey = _ctx.Refs.TypeKey(m.ContainingType);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var result = new List<TypeUse>();
        foreach (var root in Roots(m).OrderBy(n => n.SyntaxTree.FilePath, StringComparer.Ordinal).ThenBy(n => n.SpanStart))
        {
            var model = _ctx.ModelOf(root.SyntaxTree);
            if (model is null) continue;
            foreach (var name in root.DescendantNodesAndSelf().OfType<SimpleNameSyntax>())
            {
                INamedTypeSymbol? type;
                try
                {
                    type = ReferencedType(model, name);
                }
                catch (Exception ex)
                {
                    Log.Debug($"type use at {name.GetLocation().GetLineSpan()} failed: {ex.Message}");
                    continue;
                }
                if (type is null) continue;
                var top = TopLevel(type);
                if (!SymbolRefs.IsSource(top)) continue;
                var key = _ctx.Refs.TypeKey(top);
                if (key == ownKey || !seen.Add(key)) continue;
                result.Add(new TypeUse(_ctx.Refs.ClassRefOf(top), SymbolRefs.Range(name)));
            }
        }
        return result;
    }

    /// <summary>The signature (parameters, return type, constraints) and everything evaluated when it runs.</summary>
    private static IEnumerable<SyntaxNode> Roots(IMethodSymbol m)
    {
        var roots = new List<SyntaxNode>(Callables.EvaluatedRoots(m));
        foreach (var r in m.DeclaringSyntaxReferences)
        {
            switch (r.GetSyntax())
            {
                case MethodDeclarationSyntax md:
                    roots.Add(md.ReturnType);
                    roots.Add(md.ParameterList);
                    roots.AddRange(md.ConstraintClauses);
                    break;
                case OperatorDeclarationSyntax od:
                    roots.Add(od.ReturnType);
                    roots.Add(od.ParameterList);
                    break;
                case ConversionOperatorDeclarationSyntax cd:
                    roots.Add(cd.Type);
                    roots.Add(cd.ParameterList);
                    break;
                case BaseMethodDeclarationSyntax b:
                    roots.Add(b.ParameterList);
                    break;
                case LocalFunctionStatementSyntax l:
                    roots.Add(l.ReturnType);
                    roots.Add(l.ParameterList);
                    roots.AddRange(l.ConstraintClauses);
                    break;
                case AccessorDeclarationSyntax { Parent.Parent: BasePropertyDeclarationSyntax p }:
                    roots.Add(p.Type);
                    break;
                case ArrowExpressionClauseSyntax { Parent: BasePropertyDeclarationSyntax p }:
                    roots.Add(p.Type);
                    break;
            }
        }
        // a root may contain another one (an expression body is both evaluated and part of the declaration)
        return roots.Where(n => !roots.Any(o => !ReferenceEquals(o, n) && o.SyntaxTree == n.SyntaxTree && o.Span.Contains(n.Span) && o.Span != n.Span))
            .Distinct();
    }

    private static INamedTypeSymbol? ReferencedType(SemanticModel model, SimpleNameSyntax name)
    {
        var info = model.GetSymbolInfo(name);
        var symbol = info.Symbol ?? info.CandidateSymbols.FirstOrDefault();
        if (symbol is IAliasSymbol alias) symbol = alias.Target;
        return symbol switch
        {
            INamedTypeSymbol t when t.TypeKind != TypeKind.Error => t.OriginalDefinition,
            IFieldSymbol f when f.IsStatic || f.IsConst => f.ContainingType?.OriginalDefinition,
            IPropertySymbol p when p.IsStatic => p.ContainingType?.OriginalDefinition,
            IEventSymbol e when e.IsStatic => e.ContainingType?.OriginalDefinition,
            IMethodSymbol ms when ((ms.ReducedFrom ?? ms).IsStatic || SymbolRefs.IsExtensionBlockMember(ms)) && ms.MethodKind != MethodKind.LocalFunction => (ms.ReducedFrom ?? ms).ContainingType?.OriginalDefinition,
            _ => null,
        };
    }

    private static INamedTypeSymbol TopLevel(INamedTypeSymbol t)
    {
        var x = t;
        while (x.ContainingType is not null) x = x.ContainingType;
        return x.OriginalDefinition;
    }
}

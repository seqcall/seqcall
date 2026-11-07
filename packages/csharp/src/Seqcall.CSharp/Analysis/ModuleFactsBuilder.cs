using Seqcall.CSharp.Protocol;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Seqcall.CSharp.Analysis;

/// <summary>
/// FR-7.7 facts of a whole type (all partial declarations) for the purity layer hint: the service
/// abstractions it takes (constructor / method parameters, fields, properties typed as a project
/// interface, abstract class or delegate), the library types it references (full names, so the
/// core can tell I/O), and the project types it references.
/// </summary>
public sealed class ModuleFactsBuilder(AnalysisContext ctx)
{
    public ModuleFacts Of(INamedTypeSymbol type)
    {
        var ownKey = ctx.Refs.TypeKey(type);
        var ports = new SortedSet<string>(StringComparer.Ordinal);
        var libraries = new SortedSet<string>(StringComparer.Ordinal);
        var deps = new Dictionary<string, ClassRef>(StringComparer.Ordinal);

        foreach (var member in type.GetMembers())
        {
            IEnumerable<ITypeSymbol> taken = member switch
            {
                IMethodSymbol m when m.MethodKind is MethodKind.Constructor or MethodKind.Ordinary => m.Parameters.Select(p => p.Type),
                IFieldSymbol { IsImplicitlyDeclared: false } f => [f.Type],
                IPropertySymbol p => [p.Type],
                _ => [],
            };
            foreach (var t in taken) if (PortName(t) is { } port) ports.Add(port);
        }
        foreach (var r in type.DeclaringSyntaxReferences)
        {
            var node = r.GetSyntax();
            var model = ctx.ModelOf(node.SyntaxTree);
            if (model is null) continue;
            foreach (var name in node.DescendantNodes().OfType<SimpleNameSyntax>())
            {
                ITypeSymbol? referenced;
                try
                {
                    var info = model.GetSymbolInfo(name);
                    var symbol = info.Symbol ?? info.CandidateSymbols.FirstOrDefault();
                    referenced = symbol switch
                    {
                        INamedTypeSymbol t => t,
                        IMethodSymbol { IsStatic: true } m => m.ContainingType,
                        IFieldSymbol { IsStatic: true } fs => fs.ContainingType,
                        IPropertySymbol { IsStatic: true } ps => ps.ContainingType,
                        _ => null,
                    };
                }
                catch (Exception ex)
                {
                    Log.Debug($"module facts at {name.GetLocation().GetLineSpan()}: {ex.Message}");
                    continue;
                }
                if (referenced is not INamedTypeSymbol nt || nt.TypeKind == TypeKind.Error) continue;
                var top = TopLevel(nt);
                if (SymbolRefs.IsSource(top))
                {
                    var key = ctx.Refs.TypeKey(top);
                    if (key != ownKey) deps.TryAdd(key, ctx.Refs.ClassRefOf(top));
                }
                else
                {
                    libraries.Add($"{top.ContainingNamespace?.ToDisplayString()}.{top.MetadataName}".TrimStart('.'));
                }
            }
        }
        return new ModuleFacts([.. ports], [.. libraries], [.. deps.Values]);
    }

    /// <summary>A project interface, abstract class or delegate (also as the element of an array / Nullable).</summary>
    private static string? PortName(ITypeSymbol t)
    {
        if (t is IArrayTypeSymbol a) t = a.ElementType;
        if (t is INamedTypeSymbol { IsGenericType: true, ConstructedFrom.SpecialType: SpecialType.System_Nullable_T } n) t = n.TypeArguments[0];
        if (t is not INamedTypeSymbol nt || !SymbolRefs.IsSource(nt)) return null;
        return nt.TypeKind == TypeKind.Interface || nt.TypeKind == TypeKind.Delegate || (nt.TypeKind == TypeKind.Class && nt.IsAbstract && !nt.IsStatic) ? nt.Name : null;
    }

    private static INamedTypeSymbol TopLevel(INamedTypeSymbol t)
    {
        var x = t;
        while (x.ContainingType is not null) x = x.ContainingType;
        return x.OriginalDefinition;
    }
}

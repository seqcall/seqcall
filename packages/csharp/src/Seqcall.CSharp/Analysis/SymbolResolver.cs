using Seqcall.CSharp.Workspace;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Seqcall.CSharp.Analysis;

/// <summary>Resolves stable keys back to symbols of the current snapshot.</summary>
public sealed class SymbolResolver
{
    private readonly AnalysisContext _ctx;

    public SymbolResolver(AnalysisContext ctx) => _ctx = ctx;

    private SymbolRefs Refs => _ctx.Refs;

    public ISymbol? Resolve(string key)
    {
        if (string.IsNullOrEmpty(key)) return null;
        if (_ctx.KeyCache.TryGetValue(key, out var cached)) return cached;
        ISymbol? result;
        try
        {
            result = key.StartsWith("lib:", StringComparison.Ordinal) ? ResolveLibrary(key) : ResolveSource(key);
        }
        catch (Exception ex)
        {
            Log.Warn($"resolving {key} failed: {ex.Message}");
            result = null;
        }
        _ctx.KeyCache[key] = result;
        return result;
    }

    public IMethodSymbol? ResolveMethod(string key) => Resolve(key) as IMethodSymbol;

    public INamedTypeSymbol? ResolveType(string key) => Resolve(key) as INamedTypeSymbol;

    private ISymbol? ResolveSource(string key)
    {
        var hash = key.IndexOf('#');
        if (hash <= 0) return null;
        var rel = key[..hash];
        var file = Paths.ToOs(Path.Combine(_ctx.Root, rel));
        var tree = _ctx.TreeAt(file);
        if (tree is null) return null;
        var model = _ctx.ModelOf(tree);
        if (model is null) return null;
        var root = tree.GetRoot();

        var types = new List<INamedTypeSymbol>();
        foreach (var node in root.DescendantNodes(n => n is CompilationUnitSyntax or BaseNamespaceDeclarationSyntax or TypeDeclarationSyntax))
        {
            if (node is BaseTypeDeclarationSyntax or DelegateDeclarationSyntax &&
                model.GetDeclaredSymbol(node) is INamedTypeSymbol t)
            {
                types.Add(t);
            }
        }
        if (root is CompilationUnitSyntax cu && cu.Members.OfType<GlobalStatementSyntax>().Any() &&
            Callables.EnclosingCallable(model, cu.Members.OfType<GlobalStatementSyntax>().First()) is { } main)
        {
            types.Add(main.ContainingType);
        }

        foreach (var t in types)
        {
            var typeKey = Refs.TypeKey(t);
            if (typeKey == key) return t;
            if (!key.StartsWith(typeKey + ".", StringComparison.Ordinal)) continue;
            var member = FindMember(t, key);
            if (member is not null) return member;
        }
        return null;
    }

    private ISymbol? FindMember(INamedTypeSymbol type, string key)
    {
        foreach (var member in type.GetMembers())
        {
            switch (member)
            {
                case IMethodSymbol m:
                    {
                        var mk = Refs.MethodKey(m);
                        if (mk == key) return SymbolRefs.Canonical(m);
                        if (key.StartsWith(mk + ".", StringComparison.Ordinal))
                        {
                            var local = FindLocalFunction(m, key);
                            if (local is not null) return local;
                        }
                        break;
                    }
                case IFieldSymbol or IPropertySymbol or IEventSymbol:
                    if (Refs.MemberKey(member) == key) return member;
                    break;
            }
        }
        return null;
    }

    private IMethodSymbol? FindLocalFunction(IMethodSymbol container, string key)
    {
        foreach (var r in SymbolRefs.Canonical(container).DeclaringSyntaxReferences)
        {
            var model = _ctx.ModelOf(r.SyntaxTree);
            if (model is null) continue;
            foreach (var lf in r.GetSyntax().DescendantNodes().OfType<LocalFunctionStatementSyntax>())
            {
                if (model.GetDeclaredSymbol(lf) is IMethodSymbol m && Refs.MethodKey(m) == key) return m;
            }
        }
        return null;
    }

    /// <summary><c>lib:Assembly#Namespace.Type[.Member(...)]</c>.</summary>
    private ISymbol? ResolveLibrary(string key)
    {
        var hash = key.IndexOf('#');
        if (hash < 0) return null;
        var assembly = key[4..hash];
        var rest = key[(hash + 1)..];
        var paren = rest.IndexOf('(');
        var searchEnd = paren < 0 ? rest.Length : paren;
        // candidate type names: the whole rest (type key), then every prefix ending before a '.'
        var candidates = new List<string> { rest[..searchEnd] };
        for (var i = searchEnd - 1; i > 0; i--)
        {
            if (rest[i] == '.') candidates.Add(rest[..i]);
        }
        foreach (var candidate in candidates)
        {
            foreach (var type in FindMetadataTypes(candidate, assembly))
            {
                var typeKey = Refs.TypeKey(type);
                if (typeKey == key) return type;
                if (!key.StartsWith(typeKey + ".", StringComparison.Ordinal)) continue;
                var member = FindMember(type, key);
                if (member is not null) return member;
            }
        }
        return null;
    }

    private IEnumerable<INamedTypeSymbol> FindMetadataTypes(string dottedName, string assembly)
    {
        // nested types use '+' in metadata names; try the plain name first, then nest from the right
        var variants = new List<string> { dottedName };
        var chars = dottedName.ToCharArray();
        for (var i = chars.Length - 1; i > 0; i--)
        {
            if (chars[i] != '.') continue;
            chars[i] = '+';
            variants.Add(new string(chars));
        }
        foreach (var c in _ctx.Compilations)
        {
            foreach (var v in variants)
            {
                foreach (var t in c.GetTypesByMetadataName(v))
                {
                    if (t.ContainingAssembly?.Name == assembly) yield return t;
                }
            }
        }
    }
}

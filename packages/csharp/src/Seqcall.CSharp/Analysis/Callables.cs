using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Seqcall.CSharp.Analysis;

/// <summary>Callable syntax: bodies, evaluated roots and the enclosing callable of a position.</summary>
public static class Callables
{
    public static bool HasBody(IMethodSymbol method)
    {
        var m = SymbolRefs.Canonical(method);
        if (!SymbolRefs.IsSource(m) && !m.IsImplicitlyDeclared) return false;
        if (m.IsAbstract || m.IsExtern) return false;
        if (m.MethodKind is MethodKind.Constructor && (m.IsImplicitlyDeclared || IsPrimaryConstructor(m)))
        {
            return InstanceInitializers(m.ContainingType, m.IsStatic).Any() || PrimaryBaseCall(m) is not null;
        }
        foreach (var r in m.DeclaringSyntaxReferences)
        {
            switch (r.GetSyntax())
            {
                case BaseMethodDeclarationSyntax b when b.Body is not null || b.ExpressionBody is not null:
                case AccessorDeclarationSyntax a when a.Body is not null || a.ExpressionBody is not null:
                case LocalFunctionStatementSyntax l when l.Body is not null || l.ExpressionBody is not null:
                case ArrowExpressionClauseSyntax:
                case CompilationUnitSyntax:
                    return true;
                case ConstructorDeclarationSyntax c when c.Initializer is not null:
                    return true;
            }
        }
        return false;
    }

    public static bool IsPrimaryConstructor(IMethodSymbol m) =>
        m.MethodKind == MethodKind.Constructor &&
        m.DeclaringSyntaxReferences.Any(r => r.GetSyntax() is TypeDeclarationSyntax);

    public static IMethodSymbol? PrimaryConstructorOf(INamedTypeSymbol type) =>
        type.InstanceConstructors.FirstOrDefault(IsPrimaryConstructor);

    /// <summary>Field / property initializers (instance or static), in declaration order (partial parts by path).</summary>
    public static IEnumerable<ExpressionSyntax> InstanceInitializers(INamedTypeSymbol type, bool isStatic)
    {
        var refs = type.DeclaringSyntaxReferences
            .OrderBy(r => r.SyntaxTree.FilePath, StringComparer.Ordinal)
            .ThenBy(r => r.Span.Start);
        foreach (var r in refs)
        {
            if (r.GetSyntax() is not TypeDeclarationSyntax td) continue;
            foreach (var member in td.Members)
            {
                switch (member)
                {
                    case FieldDeclarationSyntax f:
                        if (f.Modifiers.Any(SyntaxKind.ConstKeyword)) break;
                        if (f.Modifiers.Any(SyntaxKind.StaticKeyword) != isStatic) break;
                        foreach (var v in f.Declaration.Variables)
                        {
                            if (v.Initializer is not null) yield return v.Initializer.Value;
                        }
                        break;
                    case PropertyDeclarationSyntax p when p.Initializer is not null:
                        if (p.Modifiers.Any(SyntaxKind.StaticKeyword) != isStatic) break;
                        yield return p.Initializer.Value;
                        break;
                    case EventFieldDeclarationSyntax ef:
                        if (ef.Modifiers.Any(SyntaxKind.StaticKeyword) != isStatic) break;
                        foreach (var v in ef.Declaration.Variables)
                        {
                            if (v.Initializer is not null) yield return v.Initializer.Value;
                        }
                        break;
                }
            }
        }
    }

    /// <summary><c>class B(int x) : A(x)</c>: the base-type argument list of a primary constructor.</summary>
    public static PrimaryConstructorBaseTypeSyntax? PrimaryBaseCall(IMethodSymbol ctor)
    {
        foreach (var r in ctor.ContainingType.DeclaringSyntaxReferences)
        {
            if (r.GetSyntax() is TypeDeclarationSyntax { BaseList: { } bl })
            {
                var p = bl.Types.OfType<PrimaryConstructorBaseTypeSyntax>().FirstOrDefault();
                if (p is not null) return p;
            }
        }
        return null;
    }

    /// <summary>Nodes evaluated when the callable runs, in order (initializers, constructor initializer, body).</summary>
    public static IReadOnlyList<SyntaxNode> EvaluatedRoots(IMethodSymbol method)
    {
        var m = SymbolRefs.Canonical(method);
        var roots = new List<SyntaxNode>();
        if (m.MethodKind == MethodKind.StaticConstructor)
        {
            roots.AddRange(InstanceInitializers(m.ContainingType, true));
        }
        if (m.MethodKind == MethodKind.Constructor && (m.IsImplicitlyDeclared || IsPrimaryConstructor(m)))
        {
            roots.AddRange(InstanceInitializers(m.ContainingType, false));
            if (PrimaryBaseCall(m) is { } pb) roots.Add(pb);
            return roots;
        }
        foreach (var r in m.DeclaringSyntaxReferences)
        {
            var node = r.GetSyntax();
            switch (node)
            {
                case ConstructorDeclarationSyntax c:
                    if (!c.Modifiers.Any(SyntaxKind.StaticKeyword) && c.Initializer is not { RawKind: (int)SyntaxKind.ThisConstructorInitializer })
                    {
                        roots.AddRange(InstanceInitializers(m.ContainingType, false));
                    }
                    if (c.Initializer is not null) roots.Add(c.Initializer);
                    AddBody(roots, c.Body, c.ExpressionBody);
                    break;
                case BaseMethodDeclarationSyntax b:
                    AddBody(roots, b.Body, b.ExpressionBody);
                    break;
                case AccessorDeclarationSyntax a:
                    AddBody(roots, a.Body, a.ExpressionBody);
                    break;
                case LocalFunctionStatementSyntax l:
                    AddBody(roots, l.Body, l.ExpressionBody);
                    break;
                case ArrowExpressionClauseSyntax arrow:
                    roots.Add(arrow);
                    break;
                case CompilationUnitSyntax cu:
                    roots.AddRange(cu.Members.OfType<GlobalStatementSyntax>());
                    break;
            }
        }
        return roots;
    }

    private static void AddBody(List<SyntaxNode> roots, BlockSyntax? body, ArrowExpressionClauseSyntax? expressionBody)
    {
        if (body is not null) roots.Add(body);
        else if (expressionBody is not null) roots.Add(expressionBody);
    }

    /// <summary>
    /// Innermost method, constructor, accessor, local function, operator (or top-level statements)
    /// containing the node. Lambdas are transparent. Field initializers map to the primary /
    /// implicit constructor.
    /// </summary>
    public static IMethodSymbol? EnclosingCallable(SemanticModel model, SyntaxNode start)
    {
        for (var n = start; n is not null; n = n.Parent)
        {
            switch (n)
            {
                case LocalFunctionStatementSyntax:
                case BaseMethodDeclarationSyntax:
                case AccessorDeclarationSyntax:
                    if (model.GetDeclaredSymbol(n) is IMethodSymbol m) return m;
                    break;
                case ArrowExpressionClauseSyntax arrow when arrow.Parent is BasePropertyDeclarationSyntax prop:
                    if (model.GetDeclaredSymbol(prop) is IPropertySymbol ps && ps.GetMethod is { } getter) return getter;
                    break;
                case GlobalStatementSyntax:
                    {
                        var entry = model.Compilation.GetEntryPoint(CancellationToken.None);
                        if (entry is not null && entry.DeclaringSyntaxReferences.Any(r => r.SyntaxTree == n.SyntaxTree)) return entry;
                        return TopLevelEntryPoint(model);
                    }
                case BaseTypeDeclarationSyntax td:
                    return InitializerOwner(model, td, start);
            }
        }
        return null;
    }

    private static IMethodSymbol? TopLevelEntryPoint(SemanticModel model)
    {
        var program = model.Compilation.GetTypeByMetadataName("Program");
        return program?.GetMembers(WellKnownMemberNames.TopLevelStatementsEntryPointMethodName).OfType<IMethodSymbol>().FirstOrDefault();
    }

    /// <summary>Position inside a type but outside members: initializers / primary-ctor arguments belong to the constructor.</summary>
    private static IMethodSymbol? InitializerOwner(SemanticModel model, BaseTypeDeclarationSyntax td, SyntaxNode start)
    {
        if (model.GetDeclaredSymbol(td) is not INamedTypeSymbol type) return null;
        var inInitializer = start.AncestorsAndSelf().TakeWhile(a => a != td).Any(a =>
            a is EqualsValueClauseSyntax { Parent: VariableDeclaratorSyntax or PropertyDeclarationSyntax } ||
            a is PrimaryConstructorBaseTypeSyntax || a is ParameterListSyntax { Parent: TypeDeclarationSyntax });
        if (!inInitializer) return null;
        var isStatic = start.AncestorsAndSelf().OfType<MemberDeclarationSyntax>().FirstOrDefault() is { } md &&
                       md.Modifiers.Any(SyntaxKind.StaticKeyword);
        if (isStatic) return type.StaticConstructors.FirstOrDefault();
        return PrimaryConstructorOf(type)
               ?? type.InstanceConstructors.FirstOrDefault(c => c.IsImplicitlyDeclared)
               ?? (type.InstanceConstructors.Length == 1 ? type.InstanceConstructors[0] : null);
    }
}

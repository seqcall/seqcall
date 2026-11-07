using System.Text;
using Seqcall.CSharp.Protocol;
using Seqcall.CSharp.Workspace;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Seqcall.CSharp.Analysis;

/// <summary>
/// Stable keys and protocol references for symbols (see docs/CSHARP-SIDECAR.md, "Conventions"):
/// <c>relPath#Outer.Inner`1</c>, <c>typeKey.Name(int, CancellationToken)</c>, <c>typeKey..ctor(...)</c>,
/// <c>typeKey.Prop.get</c>, <c>lib:Assembly#Namespace.Type.Name(...)</c>.
/// </summary>
public sealed class SymbolRefs
{
    /// <summary>Short display names for parameter types: <c>int</c>, <c>List&lt;T&gt;</c>, <c>Outer.Inner</c>, <c>int?</c>.</summary>
    public static readonly SymbolDisplayFormat ParamTypeFormat = new(
        globalNamespaceStyle: SymbolDisplayGlobalNamespaceStyle.Omitted,
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypes,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes);

    /// <summary>Display types in signatures (keeps nullable reference annotations).</summary>
    public static readonly SymbolDisplayFormat SignatureTypeFormat = new(
        globalNamespaceStyle: SymbolDisplayGlobalNamespaceStyle.Omitted,
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypes,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters,
        miscellaneousOptions: SymbolDisplayMiscellaneousOptions.UseSpecialTypes |
                              SymbolDisplayMiscellaneousOptions.IncludeNullableReferenceTypeModifier);

    private static readonly SymbolDisplayFormat NamespaceFormat = new(
        globalNamespaceStyle: SymbolDisplayGlobalNamespaceStyle.Omitted,
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypesAndNamespaces);

    private readonly AnalysisContext _ctx;

    public SymbolRefs(AnalysisContext ctx) => _ctx = ctx;

    // ───────────────────────────── locations ─────────────────────────────

    public static bool IsSource(ISymbol s) => s.Locations.Any(l => l.IsInSource);

    /// <summary>The declaring source location used for keys: regular documents first, then by path (ordinal), then position.</summary>
    public Location? PrimaryLocation(ISymbol s)
    {
        Location? best = null;
        foreach (var l in s.Locations)
        {
            if (!l.IsInSource || l.SourceTree is null) continue;
            if (best is null || Compare(l, best) < 0) best = l;
        }
        return best;
    }

    private int Compare(Location a, Location b)
    {
        var ra = _ctx.IsRegularTree(a.SourceTree!) ? 0 : 1;
        var rb = _ctx.IsRegularTree(b.SourceTree!) ? 0 : 1;
        if (ra != rb) return ra - rb;
        var c = string.CompareOrdinal(Paths.ToProtocol(a.SourceTree!.FilePath), Paths.ToProtocol(b.SourceTree!.FilePath));
        return c != 0 ? c : a.SourceSpan.Start - b.SourceSpan.Start;
    }

    public static SourceRange? Range(Location? loc)
    {
        if (loc is null || !loc.IsInSource) return null;
        var span = loc.GetLineSpan();
        if (!span.IsValid) return null;
        return new SourceRange(
            Paths.ToProtocol(span.Path),
            new Position(span.StartLinePosition.Line, span.StartLinePosition.Character),
            new Position(span.EndLinePosition.Line, span.EndLinePosition.Character));
    }

    public static SourceRange Range(SyntaxNode node) => Range(node.GetLocation())!;

    public static SourceRange? Range(SyntaxTree tree, Microsoft.CodeAnalysis.Text.TextSpan span) =>
        Range(Location.Create(tree, span));

    // ───────────────────────────── types ─────────────────────────────

    /// <summary><c>Outer.Inner`1</c> (no namespace).</summary>
    public static string TypeNamePath(INamedTypeSymbol t)
    {
        var parts = new List<string>();
        for (var x = t; x is not null; x = x.ContainingType)
        {
            parts.Add(x.Arity > 0 ? $"{x.Name}`{x.Arity}" : x.Name);
        }
        parts.Reverse();
        return string.Join('.', parts);
    }

    public static string NamespaceOf(INamedTypeSymbol t)
    {
        var ns = t.ContainingNamespace;
        return ns is null || ns.IsGlobalNamespace ? "" : ns.ToDisplayString(NamespaceFormat);
    }

    public static string LibraryName(ISymbol s) => s.ContainingAssembly?.Name ?? "unknown";

    public string TypeKey(INamedTypeSymbol type)
    {
        var t = KeyType(type);
        if (!IsSource(t))
        {
            var ns = NamespaceOf(t);
            return $"lib:{LibraryName(t)}#{(ns.Length > 0 ? ns + "." : "")}{TypeNamePath(t)}";
        }
        var loc = PrimaryLocation(t);
        var rel = loc?.SourceTree is null ? "<unknown>" : _ctx.RelativePath(loc.SourceTree.FilePath);
        return $"{rel}#{TypeNamePath(t)}";
    }

    public static string TypeDisplayName(INamedTypeSymbol t)
    {
        if (t.IsImplicitlyDeclared && t.Name == "Program") return "Program";
        return t.OriginalDefinition.ToDisplayString(ParamTypeFormat);
    }

    public static string KindOf(INamedTypeSymbol t)
    {
        if (!IsSource(t)) return ClassKinds.External;
        if (t.TypeKind == TypeKind.Interface) return ClassKinds.Interface;
        if (t.TypeKind == TypeKind.Class && t.IsAbstract && !t.IsStatic) return ClassKinds.Abstract;
        return ClassKinds.Class;
    }

    /// <summary>FR-1.21: a C# 14 extension block stands for the static class it is declared in.</summary>
    private static INamedTypeSymbol KeyType(INamedTypeSymbol type)
    {
        var t = type.OriginalDefinition;
        return t.IsExtension && t.ContainingType is { } outer ? outer.OriginalDefinition : t;
    }

    public ClassRef ClassRefOf(INamedTypeSymbol type)
    {
        var t = KeyType(type);
        return new ClassRef(TypeKey(t), TypeDisplayName(t), KindOf(t), Range(PrimaryLocation(t)));
    }

    /// <summary>ClassRef of a (static) type, if it is a named, resolvable type.</summary>
    public ClassRef? ClassRefOf(ITypeSymbol? type)
    {
        if (type is null || type.TypeKind == TypeKind.Error) return null;
        if (type is ITypeParameterSymbol tp)
        {
            var constraint = tp.ConstraintTypes.OfType<INamedTypeSymbol>().FirstOrDefault();
            return constraint is null ? null : ClassRefOf(constraint);
        }
        return type is INamedTypeSymbol nt ? ClassRefOf(nt) : null;
    }

    // ───────────────────────────── methods ─────────────────────────────

    /// <summary>Unreduced, unconstructed, implementation part.</summary>
    public static IMethodSymbol Canonical(IMethodSymbol method)
    {
        var m = method.ReducedFrom ?? method;
        m = m.OriginalDefinition;
        if (m.PartialImplementationPart is { } impl) m = impl;
        return m;
    }

    /// <summary>FR-1.21: a member of a C# 14 extension block (<c>extension(User user) { … }</c>).</summary>
    public static bool IsExtensionBlockMember(IMethodSymbol method) => method.ContainingType is { IsExtension: true };

    /// <summary>
    /// An extension call whose receiver is the first parameter: <c>x.Ext(a)</c> for a classic extension method
    /// or an instance member of an extension block.
    /// </summary>
    public static bool TakesReceiverAsFirstArgument(IMethodSymbol method) =>
        method.ReducedFrom is not null || (IsExtensionBlockMember(method) && !method.IsStatic);

    public static string ParamTypes(IEnumerable<IParameterSymbol> parameters) =>
        string.Join(", ", parameters.Select(p => RefPrefix(p.RefKind) + p.Type.ToDisplayString(ParamTypeFormat)));

    private static string RefPrefix(RefKind kind) => kind switch
    {
        RefKind.Ref => "ref ",
        RefKind.Out => "out ",
        RefKind.In => "in ",
        RefKind.RefReadOnlyParameter => "ref readonly ",
        _ => "",
    };

    private static string Arity(IMethodSymbol m) => m.Arity > 0 ? $"`{m.Arity}" : "";

    /// <summary>Member part of a method key (after <c>typeKey.</c>).</summary>
    public static string MemberPart(IMethodSymbol method)
    {
        var m = Canonical(method);
        switch (m.MethodKind)
        {
            case MethodKind.Constructor:
                return $".ctor({ParamTypes(m.Parameters)})";
            case MethodKind.StaticConstructor:
                return ".cctor()";
            case MethodKind.PropertyGet:
            case MethodKind.PropertySet:
            case MethodKind.EventAdd:
            case MethodKind.EventRemove:
            case MethodKind.EventRaise:
                if (m.AssociatedSymbol is { } assoc) return $"{AssociatedName(assoc)}.{AccessorSuffix(m)}";
                break;
            case MethodKind.LocalFunction:
                {
                    var container = ContainingCallable(m);
                    var prefix = container is null ? "" : MemberPart(container) + ".";
                    return $"{prefix}{m.Name}{Arity(m)}({ParamTypes(m.Parameters)})";
                }
        }
        // An extension block member is keyed like the classic form: the block's type parameters and receiver come first.
        if (IsExtensionBlockMember(m) && m.AssociatedExtensionImplementation is { } impl) m = impl.OriginalDefinition;
        return $"{m.Name}{Arity(m)}({ParamTypes(m.Parameters)})";
    }

    /// <summary>The named method a local function is declared in (skipping lambdas).</summary>
    public static IMethodSymbol? ContainingCallable(IMethodSymbol localFunction)
    {
        for (var s = localFunction.ContainingSymbol; s is not null; s = s.ContainingSymbol)
        {
            if (s is IMethodSymbol cm && cm.MethodKind != MethodKind.AnonymousFunction) return cm;
            if (s is INamedTypeSymbol) return null;
        }
        return null;
    }

    private static string AssociatedName(ISymbol assoc) =>
        assoc is IPropertySymbol { IsIndexer: true } ip ? $"this[{ParamTypes(ip.Parameters)}]" : assoc.Name;

    private static string AccessorSuffix(IMethodSymbol m) => m.MethodKind switch
    {
        MethodKind.PropertyGet => "get",
        MethodKind.PropertySet => m.IsInitOnly ? "init" : "set",
        MethodKind.EventAdd => "add",
        MethodKind.EventRemove => "remove",
        _ => "raise",
    };

    public string MethodKey(IMethodSymbol method)
    {
        var m = Canonical(method);
        return $"{TypeKey(m.ContainingType)}.{MemberPart(m)}";
    }

    /// <summary>Protocol name: <c>constructor</c> for constructors, the property name for accessors.</summary>
    public static string DisplayName(IMethodSymbol method)
    {
        var m = Canonical(method);
        switch (m.MethodKind)
        {
            case MethodKind.Constructor:
            case MethodKind.StaticConstructor:
                return "constructor";
            case MethodKind.PropertyGet:
            case MethodKind.PropertySet:
            case MethodKind.EventAdd:
            case MethodKind.EventRemove:
                return m.AssociatedSymbol is IPropertySymbol { IsIndexer: true } ? "this[]" : m.AssociatedSymbol?.Name ?? m.Name;
        }
        if (m.Name == WellKnownMemberNames.TopLevelStatementsEntryPointMethodName) return "Main";
        var name = m.Name;
        var dot = name.LastIndexOf('.');
        return dot >= 0 && m.MethodKind == MethodKind.ExplicitInterfaceImplementation ? name[(dot + 1)..] : name;
    }

    public MethodRef MethodRefOf(IMethodSymbol method)
    {
        var m = Canonical(method);
        var owner = ClassRefOf(m.ContainingType);
        var isStatic = m.MethodKind == MethodKind.LocalFunction
            ? ContainingCallable(m)?.IsStatic ?? m.IsStatic
            : m.IsStatic;
        if (!IsSource(m) && !(m.IsImplicitlyDeclared && IsSource(m.ContainingType)))
        {
            return new MethodRef(MethodKey(m), DisplayName(m), owner, isStatic, null, false);
        }
        var loc = PrimaryLocation(m) ?? PrimaryLocation(m.ContainingType);
        return new MethodRef(MethodKey(m), DisplayName(m), owner, isStatic, Range(DeclarationLocation(m, loc)), Callables.HasBody(m));
    }

    /// <summary>Name identifier of the declaration (the type name for implicit / primary constructors).</summary>
    private static Location? DeclarationLocation(IMethodSymbol m, Location? fallback)
    {
        foreach (var r in m.DeclaringSyntaxReferences)
        {
            var node = r.GetSyntax();
            switch (node)
            {
                case TypeDeclarationSyntax td:
                    return td.Identifier.GetLocation();
                case CompilationUnitSyntax cu:
                    var first = cu.Members.OfType<GlobalStatementSyntax>().FirstOrDefault();
                    if (first is not null) return Location.Create(cu.SyntaxTree, new Microsoft.CodeAnalysis.Text.TextSpan(first.SpanStart, 0));
                    break;
                case ArrowExpressionClauseSyntax arrow when arrow.Parent is PropertyDeclarationSyntax pd:
                    return pd.Identifier.GetLocation();
                case ArrowExpressionClauseSyntax arrow when arrow.Parent is IndexerDeclarationSyntax ixd:
                    return ixd.ThisKeyword.GetLocation();
                case AccessorDeclarationSyntax acc:
                    return acc.Keyword.GetLocation();
            }
        }
        return fallback;
    }

    /// <summary>A delegate-typed field/property invoked like a method: a body-less member of its owner.</summary>
    public MethodRef DelegateMemberRef(ISymbol member)
    {
        var owner = ClassRefOf(member.ContainingType);
        var loc = PrimaryLocation(member);
        return new MethodRef($"{owner.Key}.{member.Name}", member.Name, owner, member.IsStatic, Range(loc), false);
    }

    public string MemberKey(ISymbol member) => member switch
    {
        IMethodSymbol m => MethodKey(m),
        INamedTypeSymbol t => TypeKey(t),
        _ => $"{TypeKey(member.ContainingType)}.{member.Name}",
    };

    // ───────────────────────────── text ─────────────────────────────

    /// <summary>Source text without comments, whitespace collapsed.</summary>
    public static string CompactText(SyntaxNode node, Microsoft.CodeAnalysis.Text.TextSpan? within = null)
    {
        var sb = new StringBuilder();
        SyntaxToken previous = default;
        var pendingSpace = false;
        foreach (var token in node.DescendantTokens())
        {
            if (within is { } w && !w.Contains(token.Span)) continue;
            if (previous != default && (pendingSpace || HasSeparatingTrivia(token.LeadingTrivia)) && !Glued(previous, token)) sb.Append(' ');
            sb.Append(token.Text);
            pendingSpace = HasSeparatingTrivia(token.TrailingTrivia);
            previous = token;
        }
        return Collapse(sb.ToString());
    }

    /// <summary>Line breaks in fluent chains / argument lists don't become spaces: <c>a\n  .B()</c> → <c>a.B()</c>.</summary>
    private static bool Glued(SyntaxToken previous, SyntaxToken next) =>
        next.Kind() is SyntaxKind.DotToken or SyntaxKind.CloseParenToken or SyntaxKind.CloseBracketToken or SyntaxKind.CommaToken or SyntaxKind.SemicolonToken ||
        previous.Kind() is SyntaxKind.OpenParenToken or SyntaxKind.OpenBracketToken or SyntaxKind.DotToken ||
        (next.IsKind(SyntaxKind.QuestionToken) && next.Parent is ConditionalAccessExpressionSyntax);

    private static bool HasSeparatingTrivia(SyntaxTriviaList trivia) => trivia.Any(t =>
        t.IsKind(SyntaxKind.WhitespaceTrivia) || t.IsKind(SyntaxKind.EndOfLineTrivia) ||
        t.IsKind(SyntaxKind.SingleLineCommentTrivia) || t.IsKind(SyntaxKind.MultiLineCommentTrivia));

    public static string Collapse(string text)
    {
        var sb = new StringBuilder(text.Length);
        var ws = false;
        foreach (var ch in text)
        {
            if (char.IsWhiteSpace(ch))
            {
                ws = true;
                continue;
            }
            if (ws && sb.Length > 0) sb.Append(' ');
            ws = false;
            sb.Append(ch);
        }
        return sb.ToString();
    }
}

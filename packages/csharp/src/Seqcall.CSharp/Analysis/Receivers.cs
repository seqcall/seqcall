using Seqcall.CSharp.Protocol;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Seqcall.CSharp.Analysis;

/// <summary>How receivers and arguments are reached (FR-6.5): this, base, fields, parameters, locals, types.</summary>
public static class Receivers
{
    public static ExpressionSyntax Unwrap(ExpressionSyntax e)
    {
        while (true)
        {
            switch (e)
            {
                case ParenthesizedExpressionSyntax p:
                    e = p.Expression;
                    continue;
                case PostfixUnaryExpressionSyntax pu when pu.IsKind(SyntaxKind.SuppressNullableWarningExpression):
                    e = pu.Operand;
                    continue;
                default:
                    return e;
            }
        }
    }

    /// <summary>A primary-constructor parameter used outside the primary constructor acts like a field.</summary>
    public static bool IsPrimaryConstructorParameter(IParameterSymbol p) =>
        p.ContainingSymbol is IMethodSymbol m && Callables.IsPrimaryConstructor(m);

    /// <summary>Member of the enclosing instance reached via implicit / explicit <c>this</c>.</summary>
    private static bool IsOwnMember(ISymbol s, INamedTypeSymbol? enclosingType)
    {
        if (s is not (IFieldSymbol or IPropertySymbol or IEventSymbol)) return false;
        if (enclosingType is null) return true;
        for (var t = enclosingType; t is not null; t = t.ContainingType)
        {
            for (var b = (INamedTypeSymbol?)t; b is not null; b = b.BaseType)
            {
                if (SymbolEqualityComparer.Default.Equals(b.OriginalDefinition, s.ContainingType?.OriginalDefinition)) return true;
            }
        }
        return false;
    }

    /// <summary>Origin of an object expression (the receiver of a member access).</summary>
    public static ReceiverOrigin OriginOf(SemanticModel model, ExpressionSyntax expr, INamedTypeSymbol? enclosingType)
    {
        var e = Unwrap(expr);
        switch (e)
        {
            case ThisExpressionSyntax:
                return ReceiverOrigin.Self;
            case BaseExpressionSyntax:
                return ReceiverOrigin.Super;
            case IdentifierNameSyntax or GenericNameSyntax:
                {
                    var sym = model.GetSymbolInfo(e).Symbol;
                    switch (sym)
                    {
                        case IParameterSymbol p:
                            return IsPrimaryConstructorParameter(p) && !IsInsidePrimaryInitializer(e)
                                ? ReceiverOrigin.Field(p.Name)
                                : ReceiverOrigin.Parameter(p.Name);
                        case ILocalSymbol l:
                            return ReceiverOrigin.Local(l.Name);
                        case INamedTypeSymbol or ITypeParameterSymbol:
                            return ReceiverOrigin.Static;
                        case { } s when IsOwnMember(s, enclosingType):
                            return ReceiverOrigin.Field(s.Name);
                        case IRangeVariableSymbol r:
                            return ReceiverOrigin.Local(r.Name);
                    }
                    break;
                }
            case MemberAccessExpressionSyntax ma when Unwrap(ma.Expression) is ThisExpressionSyntax:
                {
                    var sym = model.GetSymbolInfo(ma.Name).Symbol;
                    if (sym is IFieldSymbol or IPropertySymbol or IEventSymbol) return ReceiverOrigin.Field(sym.Name);
                    break;
                }
            case MemberAccessExpressionSyntax or QualifiedNameSyntax or AliasQualifiedNameSyntax or PredefinedTypeSyntax:
                if (model.GetSymbolInfo(e).Symbol is INamedTypeSymbol) return ReceiverOrigin.Static;
                break;
        }
        return ReceiverOrigin.Expression(SymbolRefs.CompactText(e));
    }

    /// <summary>Inside the primary constructor itself (initializers, base arguments) its parameters are plain parameters.</summary>
    private static bool IsInsidePrimaryInitializer(SyntaxNode node) =>
        node.Ancestors().Any(a =>
            a is PrimaryConstructorBaseTypeSyntax ||
            a is EqualsValueClauseSyntax { Parent: VariableDeclaratorSyntax { Parent.Parent: FieldDeclarationSyntax } or PropertyDeclarationSyntax });

    /// <summary>Origin of an argument (for binding the callee's parameters), or null when not trackable.</summary>
    public static ArgumentOrigin? ArgumentOriginOf(
        SemanticModel model, ExpressionSyntax arg, INamedTypeSymbol? enclosingType, IReadOnlyDictionary<SyntaxNode, int> ordinals)
    {
        var e = Unwrap(arg);
        switch (e)
        {
            case ThisExpressionSyntax:
                return ArgumentOrigin.Self;
            case BaseObjectCreationExpressionSyntax c:
                return ordinals.TryGetValue(c, out var ord) ? ArgumentOrigin.Created(ord) : null;
            case MemberAccessExpressionSyntax ma when Unwrap(ma.Expression) is ThisExpressionSyntax:
                return model.GetSymbolInfo(ma.Name).Symbol is IFieldSymbol or IPropertySymbol ? ArgumentOrigin.Field(ma.Name.Identifier.ValueText) : null;
            case IdentifierNameSyntax id:
                switch (model.GetSymbolInfo(id).Symbol)
                {
                    case IParameterSymbol p:
                        return IsPrimaryConstructorParameter(p) && !IsInsidePrimaryInitializer(id)
                            ? ArgumentOrigin.Field(p.Name)
                            : ArgumentOrigin.Parameter(p.Name);
                    case ILocalSymbol l:
                        return ArgumentOrigin.Local(l.Name);
                    case { } s when s is IFieldSymbol or IPropertySymbol && IsOwnMember(s, enclosingType):
                        return ArgumentOrigin.Field(s.Name);
                }
                break;
        }
        return null;
    }

    /// <summary><c>var x = new X()</c> → local x; <c>_x = new X()</c> / field initializer → field _x.</summary>
    public static AssignmentTarget? AssignmentTargetOf(SemanticModel model, SyntaxNode creation, INamedTypeSymbol? enclosingType)
    {
        var node = creation;
        var parent = node.Parent;
        while (parent is ParenthesizedExpressionSyntax or CastExpressionSyntax)
        {
            node = parent;
            parent = parent.Parent;
        }
        switch (parent)
        {
            case EqualsValueClauseSyntax { Parent: VariableDeclaratorSyntax vd }:
                return vd.Parent?.Parent is FieldDeclarationSyntax or EventFieldDeclarationSyntax
                    ? new AssignmentTarget("field", vd.Identifier.ValueText)
                    : new AssignmentTarget("local", vd.Identifier.ValueText);
            case EqualsValueClauseSyntax { Parent: PropertyDeclarationSyntax pd }:
                return new AssignmentTarget("field", pd.Identifier.ValueText);
            case AssignmentExpressionSyntax a when a.IsKind(SyntaxKind.SimpleAssignmentExpression) || a.IsKind(SyntaxKind.CoalesceAssignmentExpression):
                if (a.Right != node) return null;
                var left = Unwrap(a.Left);
                if (left is MemberAccessExpressionSyntax ma && Unwrap(ma.Expression) is ThisExpressionSyntax)
                {
                    return new AssignmentTarget("field", ma.Name.Identifier.ValueText);
                }
                if (left is IdentifierNameSyntax id)
                {
                    var sym = model.GetSymbolInfo(id).Symbol;
                    if (sym is ILocalSymbol or IParameterSymbol) return new AssignmentTarget("local", id.Identifier.ValueText);
                    if (sym is not null && IsOwnMember(sym, enclosingType)) return new AssignmentTarget("field", id.Identifier.ValueText);
                }
                return null;
        }
        return null;
    }
}

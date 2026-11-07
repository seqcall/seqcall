using Seqcall.CSharp.Protocol;
using Seqcall.CSharp.Workspace;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Seqcall.CSharp.Analysis;

/// <summary>Structural info for stereotypes, layers and the class diagram (FR-7, FR-12).</summary>
public sealed class ClassInfoBuilder
{
    private readonly AnalysisContext _ctx;

    public ClassInfoBuilder(AnalysisContext ctx) => _ctx = ctx;

    private SymbolRefs Refs => _ctx.Refs;

    /// <summary>FR-12.15 a field: for a collection (array, IEnumerable&lt;T&gt;, dictionary values) the element's class, flagged.</summary>
    private FieldInfo Field(string name, ITypeSymbol type, bool isStatic, bool injected, ISymbol symbol)
    {
        var element = CollectionElement(type);
        var elementRef = element is null ? null : Refs.ClassRefOf(element);
        return elementRef is not null && elementRef.Kind != ClassKinds.External
            ? new FieldInfo(name, elementRef, isStatic, injected, SymbolRefs.Range(symbol.Locations.FirstOrDefault()), true)
            : new FieldInfo(name, Refs.ClassRefOf(type), isStatic, injected, SymbolRefs.Range(symbol.Locations.FirstOrDefault()));
    }

    /// <summary>The element type of an array / generic collection (a dictionary: its values); null otherwise (string too).</summary>
    private static ITypeSymbol? CollectionElement(ITypeSymbol type)
    {
        if (type is IArrayTypeSymbol array) return array.ElementType;
        if (type.SpecialType == SpecialType.System_String || type is not INamedTypeSymbol named) return null;
        var all = named.AllInterfaces.Prepend(named).ToList();
        var dictionary = all.FirstOrDefault(i => i.IsGenericType && i.TypeArguments.Length == 2 && i.OriginalDefinition.ToDisplayString() is "System.Collections.Generic.IDictionary<TKey, TValue>" or "System.Collections.Generic.IReadOnlyDictionary<TKey, TValue>");
        if (dictionary is not null) return dictionary.TypeArguments[1];
        var enumerable = all.FirstOrDefault(i => i.OriginalDefinition.SpecialType == SpecialType.System_Collections_Generic_IEnumerable_T);
        return enumerable?.TypeArguments[0];
    }

    public ClassInfo Build(INamedTypeSymbol typeSymbol)
    {
        var type = typeSymbol.OriginalDefinition;
        var classRef = Refs.ClassRefOf(type);
        var loc = Refs.PrimaryLocation(type);
        var primary = Callables.PrimaryConstructorOf(type);

        var decorators = type.GetAttributes()
            .Select(a => AttributeName(a))
            .Where(n => n.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToList();

        ClassRef? extends = null;
        if (type.TypeKind == TypeKind.Interface)
        {
            extends = type.Interfaces.FirstOrDefault() is { } first ? Refs.ClassRefOf(first) : null;
        }
        else if (type.BaseType is { } bt && bt.SpecialType is not (SpecialType.System_Object or SpecialType.System_ValueType or SpecialType.System_Enum or SpecialType.System_MulticastDelegate))
        {
            extends = Refs.ClassRefOf(bt);
        }
        var implements = type.TypeKind == TypeKind.Interface
            ? type.Interfaces.Skip(1).Select(i => Refs.ClassRefOf(i)).ToList()
            : type.Interfaces.Select(i => Refs.ClassRefOf(i)).ToList();

        var injectedNames = InjectedMemberNames(type, primary, out var copiedOnly);
        var fields = new List<FieldInfo>();
        var methods = new List<MemberInfo>();
        var staticMembers = 0;
        var instanceMembers = 0;
        var hasStaticInstance = false;
        var hasPrivateCtor = false;

        if (primary is not null)
        {
            foreach (var p in primary.Parameters)
            {
                // captured parameters act like fields; parameters only copied into a member are represented by that member
                var include = type.IsRecord
                    ? !type.GetMembers(p.Name).Any(m => m is IPropertySymbol ps && ps.DeclaringSyntaxReferences.Any(r => r.GetSyntax() is PropertyDeclarationSyntax))
                    : !copiedOnly.Contains(p.Name);
                if (include)
                {
                    fields.Add(Field(p.Name, p.Type, false, true, p));
                    instanceMembers++;
                }
            }
        }

        // FR-1.21: members of C# 14 extension blocks are listed with the static class that holds them
        var blockMembers = type.GetTypeMembers().Where(t => t.IsExtension).SelectMany(t => t.GetMembers());
        foreach (var member in type.GetMembers().Concat(blockMembers))
        {
            if (member.IsImplicitlyDeclared && member is not IMethodSymbol { MethodKind: MethodKind.Constructor }) continue;
            switch (member)
            {
                case IFieldSymbol f:
                    if (f.AssociatedSymbol is not null) continue; // backing field
                    fields.Add(Field(f.Name, f.Type, f.IsStatic || f.IsConst, injectedNames.Contains(f.Name), f));
                    Count(f.IsStatic || f.IsConst);
                    if ((f.IsStatic) && IsSelfType(f.Type, type)) hasStaticInstance = true;
                    break;
                case IPropertySymbol p:
                    if (p.IsImplicitlyDeclared || p.DeclaringSyntaxReferences.Any(r => r.GetSyntax() is ParameterSyntax)) continue; // record positional
                    if (IsAutoProperty(p) || injectedNames.Contains(p.Name))
                    {
                        fields.Add(Field(p.Name, p.Type, p.IsStatic, injectedNames.Contains(p.Name), p));
                    }
                    Count(p.IsStatic);
                    if (p.IsStatic && IsSelfType(p.Type, type)) hasStaticInstance = true;
                    break;
                case IEventSymbol e:
                    Count(e.IsStatic);
                    break;
                case IMethodSymbol m:
                    switch (m.MethodKind)
                    {
                        case MethodKind.Constructor:
                            if (m.IsImplicitlyDeclared) break;
                            if (m.DeclaredAccessibility is Accessibility.Private or Accessibility.Protected or Accessibility.ProtectedAndInternal)
                            {
                                hasPrivateCtor = true;
                            }
                            if (type.IsRecord && m.Parameters.Length == 1 && SymbolEqualityComparer.Default.Equals(m.Parameters[0].Type, type)) break; // copy ctor
                            methods.Add(new MemberInfo("constructor", false, Signature("constructor", m), Visibility(m)));
                            break;
                        case MethodKind.Ordinary:
                        case MethodKind.UserDefinedOperator:
                        case MethodKind.Conversion:
                        case MethodKind.ExplicitInterfaceImplementation:
                            if (m.IsImplicitlyDeclared) break;
                            var name = SymbolRefs.DisplayName(m);
                            // a block member shows as the classic extension method: static, `this` receiver first
                            var shape = SymbolRefs.IsExtensionBlockMember(m) && m.AssociatedExtensionImplementation is { } impl ? impl : m;
                            methods.Add(new MemberInfo(name, shape.IsStatic, Signature(name, shape), m.MethodKind == MethodKind.ExplicitInterfaceImplementation ? null : Visibility(m)));
                            Count(shape.IsStatic);
                            if (m.IsStatic && name is "GetInstance" or "Instance" && m.Parameters.Length == 0 && IsSelfType(m.ReturnType, type))
                            {
                                hasStaticInstance = true;
                            }
                            break;
                    }
                    break;
            }
        }

        var allStatic = type.IsStatic || (staticMembers > 0 && instanceMembers == 0);
        return new ClassInfo
        {
            Ref = classRef,
            File = loc?.SourceTree is { } tree ? Paths.ToProtocol(tree.FilePath) : null,
            Decorators = decorators,
            Extends = extends,
            Implements = implements,
            Fields = fields,
            ConstructorParams = MainConstructor(type, primary)?.Parameters
                .Select(p => new ConstructorParam(p.Name, Refs.ClassRefOf(p.Type))).ToList() ?? [],
            HasPrivateConstructor = hasPrivateCtor,
            HasStaticInstance = hasStaticInstance,
            AllMembersStatic = allStatic,
            IsExportedInstance = false,
            Methods = methods,
            NestedTypes = NestedTypeNames(type) is { Count: > 0 } nested ? nested : null,
            Immutable = IsImmutable(type, 0) ? true : null,
            DataOnly = IsDataOnly(type) ? true : null,
        };

        void Count(bool isStatic)
        {
            if (isStatic) staticMembers++;
            else instanceMembers++;
        }
    }

    /// <summary>
    /// FR-5.12 objects of the type cannot change once built, so which one a call goes to does not matter — only their
    /// values differ: every instance field <c>readonly</c>, no setter (only <c>init</c>), no instance event, no field of an
    /// array or a mutable collection (a readonly reference to a list still lets the list change), not disposable (its
    /// lifetime matters), and a base type that is <c>object</c> or itself such a type in the solution. A generic
    /// <c>T</c> field is fine: the object cannot swap it later.
    /// </summary>
    private static bool IsImmutable(INamedTypeSymbol type, int depth)
    {
        if (depth > 8 || type.TypeKind is not (TypeKind.Class or TypeKind.Struct) || type.IsStatic) return false;
        if (type.AllInterfaces.Any(i => i.ToDisplayString() is "System.IDisposable" or "System.IAsyncDisposable")) return false;
        if (type.BaseType is { } bt && bt.SpecialType is not (SpecialType.System_Object or SpecialType.System_ValueType))
        {
            if (!bt.OriginalDefinition.Locations.Any(l => l.IsInSource) || !IsImmutable(bt.OriginalDefinition, depth + 1)) return false;
        }
        foreach (var member in type.GetMembers())
        {
            switch (member)
            {
                case IFieldSymbol { IsStatic: false, IsConst: false } f:
                    // an auto-property's backing field: the property decides (`{ get; init; }` is fine)
                    if (f.AssociatedSymbol is null && (!f.IsReadOnly || IsMutableCollection(f.Type))) return false;
                    break;
                case IPropertySymbol { IsStatic: false } p:
                    if (p.SetMethod is { IsInitOnly: false }) return false;
                    if (IsAutoProperty(p) && IsMutableCollection(p.Type)) return false;
                    break;
                case IEventSymbol { IsStatic: false }:
                    return false;
            }
        }
        return true;
    }

    /// <summary>
    /// FR-7.15 the type's own code only holds data: an interface with only properties; a class (a static one of
    /// constants too), struct or record whose members are fields, auto-properties, properties and methods that only return a field / constant or
    /// set a field, and constructors that only store values. Its base type is checked by core. Not an enum: a status or a
    /// kind is the domain's vocabulary, so it keeps its folder's layer.
    /// </summary>
    private static bool IsDataOnly(INamedTypeSymbol type)
    {
        if (type.TypeKind is not (TypeKind.Class or TypeKind.Struct or TypeKind.Interface)) return false;
        foreach (var member in type.GetMembers())
        {
            if (member.IsImplicitlyDeclared || member is INamedTypeSymbol) continue;
            var ok = member switch
            {
                IFieldSymbol f => f.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).All(s => s is not VariableDeclaratorSyntax { Initializer: { } init } || IsPlain(init.Value)),
                IPropertySymbol p => p.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).All(s => s switch
                {
                    PropertyDeclarationSyntax pd => pd.ExpressionBody is { } eb
                        ? IsPlain(eb.Expression)
                        : (pd.Initializer is null || IsPlain(pd.Initializer.Value)) && pd.AccessorList!.Accessors.All(IsPlainAccessor),
                    _ => true, // a record's positional parameter
                }),
                IMethodSymbol { MethodKind: MethodKind.PropertyGet or MethodKind.PropertySet } => true, // with their property
                IMethodSymbol { MethodKind: MethodKind.Constructor } m => m.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).All(s => s is not ConstructorDeclarationSyntax c || IsPlainConstructor(c)),
                IMethodSymbol { MethodKind: MethodKind.Ordinary } m => m.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).All(s => s is MethodDeclarationSyntax md && IsPlainBody(md.Body, md.ExpressionBody, md.ParameterList.Parameters.Count == 0)),
                _ => false,
            };
            if (!ok) return false;
        }
        return true;
    }

    private static bool IsPlainAccessor(AccessorDeclarationSyntax a) =>
        (a.Body is null && a.ExpressionBody is null) || IsPlainBody(a.Body, a.ExpressionBody, true);

    /// <summary><c>=> x</c>, <c>{ return x; }</c> (a getter takes no arguments), <c>{ _x = value; }</c>, <c>{ _x = value; return this; }</c> with plain values.</summary>
    private static bool IsPlainBody(BlockSyntax? body, ArrowExpressionClauseSyntax? arrow, bool getter)
    {
        if (arrow is not null) return (getter && IsPlain(arrow.Expression)) || (arrow.Expression is AssignmentExpressionSyntax a && IsStore(a));
        if (body is null) return false; // abstract / interface method: a subclass's behaviour
        var s = body.Statements;
        if (s.Count == 1 && s[0] is ReturnStatementSyntax r) return getter && (r.Expression is null || IsPlain(r.Expression));
        if (s.Count is 0 or > 2 || s[0] is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax set } || !IsStore(set)) return false;
        return s.Count == 1 || s[1] is ReturnStatementSyntax { Expression: ThisExpressionSyntax };
    }

    private static bool IsPlainConstructor(ConstructorDeclarationSyntax c)
    {
        if (c.Initializer is { } init && !init.ArgumentList.Arguments.All(a => IsPlain(a.Expression))) return false;
        if (c.ExpressionBody is { } eb) return eb.Expression is AssignmentExpressionSyntax a && IsStore(a);
        return c.Body is null || c.Body.Statements.All(s => s is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax a } && IsStore(a));
    }

    /// <summary><c>x = plain</c> / <c>this.x = plain</c></summary>
    private static bool IsStore(AssignmentExpressionSyntax a) =>
        a.IsKind(SyntaxKind.SimpleAssignmentExpression) && a.Left is IdentifierNameSyntax or MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax } && IsPlain(a.Right);

    /// <summary>A value read without logic: a name, a literal, <c>this.x</c>, <c>Status.Active</c>, <c>default</c>, <c>new(…)</c> / <c>[…]</c> of those.</summary>
    private static bool IsPlain(ExpressionSyntax e) => e switch
    {
        ParenthesizedExpressionSyntax p => IsPlain(p.Expression),
        IdentifierNameSyntax or LiteralExpressionSyntax or ThisExpressionSyntax or DefaultExpressionSyntax => true,
        MemberAccessExpressionSyntax m => m.Expression is ThisExpressionSyntax or IdentifierNameSyntax,
        PrefixUnaryExpressionSyntax u => u.IsKind(SyntaxKind.UnaryMinusExpression) && IsPlain(u.Operand),
        BaseObjectCreationExpressionSyntax n => (n.ArgumentList?.Arguments.All(a => IsPlain(a.Expression)) ?? true) && n.Initializer is null,
        CollectionExpressionSyntax c => c.Elements.All(x => x is ExpressionElementSyntax el && IsPlain(el.Expression)),
        _ => false,
    };

    /// <summary>An array or a collection that can be changed (<c>List&lt;T&gt;</c>, <c>IDictionary</c>, …); read-only and immutable ones are not.</summary>
    private static bool IsMutableCollection(ITypeSymbol t)
    {
        if (t is IArrayTypeSymbol) return true;
        if (t is not INamedTypeSymbol named) return false;
        var ns = named.ContainingNamespace?.ToDisplayString() ?? "";
        if (ns is not ("System.Collections" or "System.Collections.Generic" or "System.Collections.Concurrent" or "System.Collections.ObjectModel")) return false;
        return !(named.Name.StartsWith("IReadOnly", StringComparison.Ordinal) || named.Name.StartsWith("ReadOnly", StringComparison.Ordinal) || named.Name is "IEnumerable" or "IEnumerator");
    }

    private static string AttributeName(AttributeData a)
    {
        var name = a.AttributeClass is { TypeKind: not TypeKind.Error } ac
            ? ac.Name
            : (a.ApplicationSyntaxReference?.GetSyntax() as AttributeSyntax)?.Name.ToString().Split('.').Last() ?? "";
        return name.EndsWith("Attribute", StringComparison.Ordinal) && name.Length > "Attribute".Length ? name[..^"Attribute".Length] : name;
    }

    private static bool IsSelfType(ITypeSymbol t, INamedTypeSymbol type)
    {
        if (SymbolEqualityComparer.Default.Equals(t.OriginalDefinition, type)) return true;
        // Lazy<Self>
        return t is INamedTypeSymbol { Name: "Lazy", TypeArguments.Length: 1 } lazy &&
               SymbolEqualityComparer.Default.Equals(lazy.TypeArguments[0].OriginalDefinition, type);
    }

    private static bool IsAutoProperty(IPropertySymbol p) =>
        p.DeclaringSyntaxReferences.Select(r => r.GetSyntax()).OfType<PropertyDeclarationSyntax>().Any(pd =>
            pd.ExpressionBody is null && pd.AccessorList is { } al && al.Accessors.All(a => a.Body is null && a.ExpressionBody is null));

    /// <summary>The constructor DI would use: the primary one, else the accessible one with most parameters.</summary>
    private static IMethodSymbol? MainConstructor(INamedTypeSymbol type, IMethodSymbol? primary)
    {
        if (primary is not null) return primary;
        return type.InstanceConstructors
            .Where(c => !c.IsImplicitlyDeclared)
            .OrderByDescending(c => c.DeclaredAccessibility == Accessibility.Public)
            .ThenByDescending(c => c.Parameters.Length)
            .FirstOrDefault();
    }

    /// <summary>
    /// Members assigned from a constructor parameter (<c>_x = x;</c>, <c>this._x = x ?? throw ...</c>) or
    /// initialised from a primary-constructor parameter (<c>private readonly X _x = x;</c>).
    /// <paramref name="copiedPrimaryParams"/> receives primary parameters that are only copied into members.
    /// </summary>
    private HashSet<string> InjectedMemberNames(INamedTypeSymbol type, IMethodSymbol? primary, out HashSet<string> copiedPrimaryParams)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        copiedPrimaryParams = new HashSet<string>(StringComparer.Ordinal);
        var usedPrimaryParams = new Dictionary<string, int>(StringComparer.Ordinal);
        var copiedCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var r in type.DeclaringSyntaxReferences)
        {
            if (r.GetSyntax() is not TypeDeclarationSyntax td) continue;
            var model = _ctx.ModelOf(r.SyntaxTree);
            if (model is null) continue;
            foreach (var ctor in td.Members.OfType<ConstructorDeclarationSyntax>())
            {
                if (ctor.Modifiers.Any(SyntaxKind.StaticKeyword)) continue;
                var parameters = ctor.ParameterList.Parameters.Select(p => p.Identifier.ValueText).ToHashSet(StringComparer.Ordinal);
                IEnumerable<SyntaxNode> statements = ctor.Body?.Statements ?? (IEnumerable<SyntaxNode>)(ctor.ExpressionBody is { } eb ? [eb.Expression] : []);
                foreach (var st in statements)
                {
                    var expr = st is ExpressionStatementSyntax es ? es.Expression : st as ExpressionSyntax;
                    if (expr is not AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.SimpleAssignmentExpression } a) continue;
                    var memberName = AssignedMemberName(a.Left);
                    if (memberName is null) continue;
                    if (ParameterSource(a.Right) is { } src && parameters.Contains(src)) names.Add(memberName);
                }
            }
            if (primary is null) continue;
            var primaryNames = primary.Parameters.Select(p => p.Name).ToHashSet(StringComparer.Ordinal);
            foreach (var member in td.Members)
            {
                var (memberName, init) = member switch
                {
                    FieldDeclarationSyntax f when f.Declaration.Variables.Count == 1 => (f.Declaration.Variables[0].Identifier.ValueText, f.Declaration.Variables[0].Initializer?.Value),
                    PropertyDeclarationSyntax p => (p.Identifier.ValueText, p.Initializer?.Value),
                    _ => (null, null),
                };
                if (memberName is not null && init is not null && ParameterSource(init) is { } src && primaryNames.Contains(src))
                {
                    names.Add(memberName);
                    copiedCounts[src] = copiedCounts.GetValueOrDefault(src) + 1;
                }
            }
            foreach (var id in td.DescendantNodes().OfType<IdentifierNameSyntax>())
            {
                if (!primaryNames.Contains(id.Identifier.ValueText)) continue;
                if (model.GetSymbolInfo(id).Symbol is IParameterSymbol ps && Receivers.IsPrimaryConstructorParameter(ps))
                {
                    usedPrimaryParams[ps.Name] = usedPrimaryParams.GetValueOrDefault(ps.Name) + 1;
                }
            }
        }
        foreach (var (param, copies) in copiedCounts)
        {
            if (usedPrimaryParams.GetValueOrDefault(param) <= copies) copiedPrimaryParams.Add(param);
        }
        return names;
    }

    private static string? AssignedMemberName(ExpressionSyntax left) => Receivers.Unwrap(left) switch
    {
        IdentifierNameSyntax id => id.Identifier.ValueText,
        MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax } ma => ma.Name.Identifier.ValueText,
        _ => null,
    };

    /// <summary><c>x</c>, <c>x ?? throw ...</c>, <c>x ?? default</c> → "x".</summary>
    private static string? ParameterSource(ExpressionSyntax e)
    {
        e = Receivers.Unwrap(e);
        if (e is BinaryExpressionSyntax { RawKind: (int)SyntaxKind.CoalesceExpression } b) e = Receivers.Unwrap(b.Left);
        return e is IdentifierNameSyntax id ? id.Identifier.ValueText : null;
    }

    /// <summary>FR-12.18 "private" (also <c>private protected</c>) / "protected"; null for public, internal and <c>protected internal</c>.</summary>
    private static string? Visibility(IMethodSymbol m) => m.DeclaredAccessibility switch
    {
        Accessibility.Private => "private",
        Accessibility.ProtectedAndInternal => "private",
        Accessibility.Protected => "protected",
        _ => null,
    };

    /// <summary><c>GetAsync(int id, CancellationToken ct): Task&lt;Coupon&gt;</c>; constructors without return type.</summary>
    public static string Signature(string name, IMethodSymbol m)
    {
        var typeParams = m.TypeParameters.Length > 0 ? $"<{string.Join(", ", m.TypeParameters.Select(t => t.Name))}>" : "";
        var ps = string.Join(", ", m.Parameters.Select(p =>
        {
            var prefix = p.IsParams ? "params " : p.RefKind switch
            {
                RefKind.Ref => "ref ",
                RefKind.Out => "out ",
                RefKind.In => "in ",
                RefKind.RefReadOnlyParameter => "ref readonly ",
                _ => "",
            };
            if (m.IsExtensionMethod && p.Ordinal == 0) prefix = "this " + prefix;
            return $"{prefix}{p.Type.ToDisplayString(SymbolRefs.SignatureTypeFormat)} {p.Name}";
        }));
        if (m.MethodKind is MethodKind.Constructor or MethodKind.StaticConstructor) return $"{name}({ps})";
        return $"{name}{typeParams}({ps}): {m.ReturnType.ToDisplayString(SymbolRefs.SignatureTypeFormat)}";
    }

    private static List<string> NestedTypeNames(INamedTypeSymbol type)
    {
        var names = new List<string>();
        foreach (var t in type.GetTypeMembers())
        {
            if (t.IsExtension) continue; // FR-1.21: its members belong to the type itself
            names.Add(t.Name);
            names.AddRange(NestedTypeNames(t));
        }
        return names;
    }
}

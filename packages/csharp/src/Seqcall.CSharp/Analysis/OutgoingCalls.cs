using System.Collections.Immutable;
using Seqcall.CSharp.Protocol;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Seqcall.CSharp.Analysis;

/// <summary>Direct call sites of a callable body in evaluation order (FR-1.4, FR-1.5, FR-1.6, FR-1.8, FR-1.9, FR-5).</summary>
public sealed class OutgoingCalls
{
    private readonly AnalysisContext _ctx;

    public OutgoingCalls(AnalysisContext ctx) => _ctx = ctx;

    private SymbolRefs Refs => _ctx.Refs;

    public IReadOnlyList<CallSite> Of(IMethodSymbol method) =>
        Sites(CallCollector.Collect(Callables.EvaluatedRoots(method), InlineScope, HandOff, AccessorKind), SymbolRefs.Canonical(method).ContainingType);

    /// <summary>
    /// FR-1.18 <c>get</c> / <c>set</c> when reading / assigning the referenced property runs an accessor of the project that
    /// has a body (<c>Total =&gt; Lines.Sum(…)</c>, <c>get { … }</c>); null for fields, auto-properties, library properties.
    /// </summary>
    private string? AccessorKind(ExpressionSyntax e)
    {
        if (_ctx.ModelOf(e.SyntaxTree)?.GetSymbolInfo(e).Symbol is not IPropertySymbol property) return null;
        var write = e.Parent is AssignmentExpressionSyntax { RawKind: (int)SyntaxKind.SimpleAssignmentExpression } a && a.Left == e;
        var accessor = write ? property.SetMethod : property.GetMethod;
        return accessor is not null && SymbolRefs.IsSource(SymbolRefs.Canonical(accessor)) && Callables.HasBody(accessor) ? (write ? "set" : "get") : null;
    }

    private const string Dataflow = "System.Threading.Tasks.Dataflow";

    /// <summary>
    /// FR-17.7 <c>_block.Post(x)</c> / <c>SendAsync(x)</c> on a field or property holding a dataflow block
    /// (<c>ActionBlock</c>, <c>TransformBlock</c> …): the lambdas given to the block's constructor where the type
    /// assigns it (or a method given as a method group) — they run later, on the block, with the posted item.
    /// </summary>
    private IReadOnlyList<(ExpressionSyntax, FragmentScope)> HandOff(SyntaxNode call)
    {
        if (call is not InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Post" or "SendAsync" } ma } inv) return [];
        var model = _ctx.ModelOf(inv.SyntaxTree);
        if (model?.GetSymbolInfo(inv).Symbol is not IMethodSymbol m || m.ContainingNamespace?.ToDisplayString() != Dataflow) return [];
        var holder = model.GetSymbolInfo(ma.Expression).Symbol;
        if (holder is not (IFieldSymbol or IPropertySymbol) || holder.ContainingType is not { } type) return [];
        var found = new List<(ExpressionSyntax, FragmentScope)>();
        foreach (var decl in type.DeclaringSyntaxReferences.Select(r => r.GetSyntax()))
        {
            var declModel = _ctx.ModelOf(decl.SyntaxTree);
            if (declModel is null) continue;
            foreach (var creation in decl.DescendantNodes().OfType<BaseObjectCreationExpressionSyntax>())
            {
                var target = creation.Parent switch
                {
                    AssignmentExpressionSyntax a when a.Right == creation => declModel.GetSymbolInfo(a.Left).Symbol,
                    EqualsValueClauseSyntax { Parent: VariableDeclaratorSyntax v } => declModel.GetDeclaredSymbol(v),
                    EqualsValueClauseSyntax { Parent: PropertyDeclarationSyntax pd } => declModel.GetDeclaredSymbol(pd),
                    _ => null,
                };
                if (!SymbolEqualityComparer.Default.Equals(target, holder)) continue;
                if (declModel.GetTypeInfo(creation).Type?.ContainingNamespace?.ToDisplayString() != Dataflow) continue;
                foreach (var arg in creation.ArgumentList?.Arguments ?? default)
                {
                    var e = arg.Expression;
                    while (e is ParenthesizedExpressionSyntax p) e = p.Expression;
                    if (e is AnonymousFunctionExpressionSyntax || IsMethodGroup(declModel, e)) found.Add((e, FragmentScopes.HandOffScope(inv, e, holder.Name)));
                }
            }
        }
        return found;
    }

    /// <summary>FR-1.11: a lambda passed to a library (or unresolved) method runs during that call: inline it.</summary>
    private FragmentScope? InlineScope(SyntaxNode call, AnonymousFunctionExpressionSyntax lambda)
    {
        var model = _ctx.ModelOf(call.SyntaxTree);
        var info = model?.GetSymbolInfo(call);
        if ((info?.Symbol ?? info?.CandidateSymbols.FirstOrDefault()) is IMethodSymbol m &&
            m.MethodKind != MethodKind.DelegateInvoke && SymbolRefs.IsSource(SymbolRefs.Canonical(m)))
        {
            return null; // a project method decides when it runs (drawn where it invokes the parameter)
        }
        return FragmentScopes.LambdaScope(call, lambda);
    }

    private static bool IsMethodGroup(SemanticModel model, ExpressionSyntax e) =>
        e is IdentifierNameSyntax or MemberAccessExpressionSyntax && model.GetSymbolInfo(e).Symbol is IMethodSymbol;

    /// <summary>FR-17.7 a method group a dataflow block runs (<c>new ActionBlock&lt;T&gt;(Handle)</c>): a call of that method.</summary>
    private CallSite MethodGroupCall(SemanticModel model, ExpressionSyntax group, int ordinal, INamedTypeSymbol enclosingType)
    {
        if (model.GetSymbolInfo(group).Symbol is not IMethodSymbol method) return Unresolved(group, ordinal);
        var canonical = SymbolRefs.Canonical(method);
        var target = Refs.MethodRefOf(canonical);
        var isLibrary = !SymbolRefs.IsSource(canonical);
        var (receiver, receiverType) = InvocationReceiver(model, method, canonical, group is MemberAccessExpressionSyntax ma ? ma.Expression : null, enclosingType);
        return new CallSite
        {
            Ordinal = ordinal,
            Kind = "call",
            Range = SymbolRefs.Range(group),
            MethodName = SymbolRefs.DisplayName(canonical),
            ExpressionText = SymbolRefs.CompactText(group),
            Args = [],
            Receiver = receiver,
            ReceiverType = receiverType ?? target.Owner,
            Target = target,
            IsAsync = ReturnsAwaitable(method),
            IsLibrary = isLibrary,
            LibraryName = isLibrary ? SymbolRefs.LibraryName(canonical) : null,
        };
    }

    private List<CallSite> Sites(List<CallCollector.Collected> calls, INamedTypeSymbol enclosingType)
    {
        var ordinals = new Dictionary<SyntaxNode, int>();
        for (var i = 0; i < calls.Count; i++) ordinals[calls[i].Node] = i;
        var result = new List<CallSite>(calls.Count);
        for (var i = 0; i < calls.Count; i++)
        {
            var (node, prefix, accessor) = calls[i];
            var model = _ctx.ModelOf(node.SyntaxTree);
            if (model is null) continue;
            var own = FragmentScopes.Of(node);
            IReadOnlyList<FragmentScope>? fragments = prefix.Count == 0 ? own : [.. prefix, .. own ?? []];
            try
            {
                var site = accessor is null ? Build(model, node, i, enclosingType, ordinals) : AccessorCall(model, (ExpressionSyntax)node, accessor, i, enclosingType, ordinals);
                result.Add(site with { Fragments = fragments });
            }
            catch (Exception ex)
            {
                Log.Warn($"call site analysis failed at {node.GetLocation().GetLineSpan()}: {ex.Message}");
                result.Add(Unresolved(node, i) with { Fragments = fragments });
            }
        }
        return result;
    }

    private static CallSite Unresolved(SyntaxNode node, int ordinal) => new()
    {
        Ordinal = ordinal,
        Kind = node is BaseObjectCreationExpressionSyntax ? "create" : "call",
        Range = SymbolRefs.Range(node),
        MethodName = node is InvocationExpressionSyntax inv ? SyntacticName(inv.Expression) : "constructor",
        ExpressionText = SymbolRefs.CompactText(node),
        Args = [],
        Receiver = node is BaseObjectCreationExpressionSyntax ? ReceiverOrigin.None : ReceiverOrigin.Expression(SymbolRefs.CompactText(node)),
        IsAsync = false,
        IsLibrary = false,
    };

    private CallSite Build(SemanticModel model, SyntaxNode node, int ordinal, INamedTypeSymbol enclosingType, IReadOnlyDictionary<SyntaxNode, int> ordinals) =>
        node switch
        {
            InvocationExpressionSyntax inv => Invocation(model, inv, ordinal, enclosingType, ordinals),
            BaseObjectCreationExpressionSyntax c => Creation(model, c, ordinal, enclosingType, ordinals),
            ConstructorInitializerSyntax ci => ChainedConstructor(model, ci, ci.ArgumentList, ci.IsKind(SyntaxKind.BaseConstructorInitializer), ordinal, enclosingType, ordinals),
            PrimaryConstructorBaseTypeSyntax pb => ChainedConstructor(model, pb, pb.ArgumentList, true, ordinal, enclosingType, ordinals),
            ExpressionSyntax group => MethodGroupCall(model, group, ordinal, enclosingType),
            _ => Unresolved(node, ordinal),
        };

    /// <summary>FR-1.18 a property read / assignment that runs an accessor (<c>«get» Total</c>): a call of it, without arguments.</summary>
    private CallSite AccessorCall(SemanticModel model, ExpressionSyntax e, string kind, int ordinal, INamedTypeSymbol enclosingType, IReadOnlyDictionary<SyntaxNode, int> ordinals)
    {
        var property = (IPropertySymbol)model.GetSymbolInfo(e).Symbol!;
        var accessor = kind == "set" ? property.SetMethod! : property.GetMethod!;
        var canonical = SymbolRefs.Canonical(accessor);
        var conditional = e is MemberBindingExpressionSyntax ? CallCollector.ConditionalAccessOf(e) : null;
        var objectExpr = e switch
        {
            MemberAccessExpressionSyntax ma => ma.Expression,
            MemberBindingExpressionSyntax => conditional?.Expression,
            _ => null,
        };
        var (receiver, receiverType) = InvocationReceiver(model, accessor, canonical, objectExpr, enclosingType);
        // `new X().Total`: the object the creation call site makes
        if (objectExpr is not null && receiver.Kind == "expression" && Receivers.Unwrap(objectExpr) is BaseObjectCreationExpressionSyntax created && ordinals.TryGetValue(created, out var createdOrdinal))
            receiver = ReceiverOrigin.Created(createdOrdinal);
        var target = Refs.MethodRefOf(canonical);
        return new CallSite
        {
            Ordinal = ordinal,
            Kind = "call",
            Range = SymbolRefs.Range(e),
            MethodName = property.Name,
            ExpressionText = SymbolRefs.CompactText(e),
            Args = [],
            Accessor = kind,
            Receiver = receiver,
            ReceiverType = receiverType ?? target.Owner,
            Target = target,
            IsAsync = false,
            IsLibrary = false,
            Result = kind == "get" ? CallResults.ResultOf(e) : null,
            ReturnType = kind == "get" ? CallResults.ReturnTypeOf(accessor, false) : null,
        };
    }

    // ───────────────────────────── invocations ─────────────────────────────

    private CallSite Invocation(SemanticModel model, InvocationExpressionSyntax inv, int ordinal, INamedTypeSymbol enclosingType, IReadOnlyDictionary<SyntaxNode, int> ordinals)
    {
        var info = model.GetSymbolInfo(inv);
        var method = (info.Symbol ?? info.CandidateSymbols.FirstOrDefault()) as IMethodSymbol;
        var callee = inv.Expression;
        var conditional = callee is MemberBindingExpressionSyntax ? CallCollector.ConditionalAccessOf(inv) : null;
        var objectExpr = callee switch
        {
            MemberAccessExpressionSyntax ma => ma.Expression,
            MemberBindingExpressionSyntax => conditional?.Expression,
            _ => null,
        };
        var range = conditional is null
            ? SymbolRefs.Range(inv)
            : SymbolRefs.Range(inv.SyntaxTree, Microsoft.CodeAnalysis.Text.TextSpan.FromBounds(conditional.SpanStart, inv.Span.End))!;
        var exprText = conditional is null
            ? SymbolRefs.CompactText(inv)
            : SymbolRefs.CompactText(conditional, Microsoft.CodeAnalysis.Text.TextSpan.FromBounds(conditional.SpanStart, inv.Span.End));

        var args = inv.ArgumentList.Arguments;
        string methodName;
        ReceiverOrigin receiver;
        ClassRef? receiverType;
        MethodRef? target = null;
        bool isLibrary = false;
        string? libraryName = null;
        string? invokedParameter = null;
        ClassRef? invokedParameterType = null;

        if (method is { MethodKind: MethodKind.DelegateInvoke } && IsExplicitInvoke(callee) && objectExpr is not null &&
            model.GetSymbolInfo(objectExpr).Symbol is IParameterSymbol ip && !Receivers.IsPrimaryConstructorParameter(ip))
        {
            // onSuccess.Invoke(x): the delegate parameter itself is what runs (FR-1.13)
            methodName = ip.Name;
            receiver = ReceiverOrigin.Parameter(ip.Name);
            receiverType = Refs.ClassRefOf(ip.Type);
            invokedParameter = ip.Name;
            invokedParameterType = PortType(ip);
        }
        else if (method is { MethodKind: MethodKind.DelegateInvoke } && !IsExplicitInvoke(callee))
        {
            // _handler(x) / this.Handler(x): a delegate-typed member invoked like a method
            var invoked = model.GetSymbolInfo(callee).Symbol;
            methodName = invoked?.Name ?? SyntacticName(callee);
            switch (invoked)
            {
                case IFieldSymbol or IPropertySymbol or IEventSymbol:
                    target = Refs.DelegateMemberRef(invoked);
                    isLibrary = !SymbolRefs.IsSource(invoked);
                    if (isLibrary) libraryName = SymbolRefs.LibraryName(invoked);
                    if (objectExpr is null)
                    {
                        receiver = invoked.IsStatic && !SymbolEqualityComparer.Default.Equals(invoked.ContainingType, enclosingType) ? ReceiverOrigin.Static : ReceiverOrigin.Self;
                        receiverType = invoked.IsStatic ? Refs.ClassRefOf(invoked.ContainingType) : Refs.ClassRefOf(enclosingType);
                    }
                    else
                    {
                        receiver = Receivers.OriginOf(model, objectExpr, enclosingType);
                        receiverType = receiver.Kind is "self" or "super"
                            ? Refs.ClassRefOf(enclosingType)
                            : Refs.ClassRefOf(model.GetTypeInfo(objectExpr).Type) ?? target.Owner;
                    }
                    break;
                case IParameterSymbol p:
                    receiver = Receivers.IsPrimaryConstructorParameter(p) ? ReceiverOrigin.Field(p.Name) : ReceiverOrigin.Parameter(p.Name);
                    receiverType = Refs.ClassRefOf(p.Type);
                    if (!Receivers.IsPrimaryConstructorParameter(p))
                    {
                        invokedParameter = p.Name; // FR-1.13
                        invokedParameterType = PortType(p);
                    }
                    break;
                case ILocalSymbol l:
                    receiver = ReceiverOrigin.Local(l.Name);
                    receiverType = Refs.ClassRefOf(l.Type);
                    break;
                default:
                    receiver = ReceiverOrigin.Expression(SymbolRefs.CompactText(callee));
                    receiverType = Refs.ClassRefOf(model.GetTypeInfo(callee).Type);
                    break;
            }
        }
        else if (method is not null)
        {
            var canonical = SymbolRefs.Canonical(method);
            methodName = SymbolRefs.DisplayName(canonical);
            target = Refs.MethodRefOf(canonical);
            isLibrary = !SymbolRefs.IsSource(canonical);
            if (isLibrary) libraryName = SymbolRefs.LibraryName(canonical);
            (receiver, receiverType) = InvocationReceiver(model, method, canonical, objectExpr, enclosingType);
            receiverType ??= target.Owner;
        }
        else
        {
            methodName = SyntacticName(callee);
            receiver = objectExpr is null
                ? callee is IdentifierNameSyntax or GenericNameSyntax ? ReceiverOrigin.Self : ReceiverOrigin.Expression(SymbolRefs.CompactText(callee))
                : Receivers.OriginOf(model, objectExpr, enclosingType);
            receiverType = objectExpr is null ? null : Refs.ClassRefOf(model.GetTypeInfo(objectExpr).Type);
        }

        // `new X().M()`: the message goes to the object the creation call site makes (not to a second X)
        if (objectExpr is not null && receiver.Kind == "expression" && Receivers.Unwrap(objectExpr) is BaseObjectCreationExpressionSyntax created && ordinals.TryGetValue(created, out var createdOrdinal))
            receiver = ReceiverOrigin.Created(createdOrdinal);

        var withBodies = target is not null && !isLibrary;
        var argOrigins = ByParameter(method, args, a => Receivers.ArgumentOriginOf(model, a.Expression, enclosingType, ordinals));
        var argFunctions = ByParameter(method, args, a => ArgumentFunctionOf(model, a.Expression, enclosingType, withBodies));
        if (method is not null && SymbolRefs.TakesReceiverAsFirstArgument(method) && objectExpr is not null)
        {
            // x.Ext(a): the receiver is the extension method's first parameter — keep origins aligned with parameters
            argOrigins.Insert(0, Receivers.ArgumentOriginOf(model, objectExpr, enclosingType, ordinals));
            argFunctions.Insert(0, null);
        }
        return new CallSite
        {
            TypeArguments = TypeArgumentsOf(method),
            Ordinal = ordinal,
            Kind = "call",
            Range = range,
            MethodName = methodName,
            ExpressionText = exprText,
            Args = args.Select(a => SymbolRefs.CompactText(a)).ToList(),
            ArgOrigins = argOrigins.Any(o => o is not null) ? argOrigins : null,
            ArgFunctions = argFunctions.Any(x => x is not null) ? argFunctions : null,
            InvokedParameter = invokedParameter,
            InvokedParameterType = invokedParameterType,
            Receiver = receiver,
            ReceiverType = receiverType,
            Target = target,
            IsAsync = IsAwaited(inv) || (method is not null && ReturnsAwaitable(method)),
            IsLibrary = isLibrary,
            LibraryName = libraryName,
            Result = CallResults.ResultOf(inv),
            ReturnType = CallResults.ReturnTypeOf(method, IsAwaited(inv)),
        };
    }

    /// <summary>
    /// Per-argument values aligned with the target's parameters: positional arguments by position,
    /// named arguments (<c>cancellationToken: ct</c>) at their parameter's position. Without a
    /// resolved method, in argument order.
    /// </summary>
    private static List<T?> ByParameter<T>(IMethodSymbol? method, SeparatedSyntaxList<ArgumentSyntax> args, Func<ArgumentSyntax, T?> value) where T : class
    {
        if (method is null || !args.Any(a => a.NameColon is not null)) return args.Select(value).ToList();
        var parameters = method.Parameters;
        var result = new List<T?>(new T?[Math.Max(parameters.Length, args.Count)]);
        for (var i = 0; i < args.Count; i++)
        {
            var name = args[i].NameColon?.Name.Identifier.ValueText;
            var at = name is null ? i : parameters.IndexOf(parameters.FirstOrDefault(p => p.Name == name)!);
            if (at >= 0 && at < result.Count) result[at] = value(args[i]);
        }
        return result;
    }

    /// <summary>FR-1.13: method groups (<c>Util.Map</c>, <c>Map</c>, <c>this.Map</c>) and lambdas passed as arguments.</summary>
    private List<ArgumentFunction?>? ArgumentFunctions(SemanticModel model, SeparatedSyntaxList<ArgumentSyntax> args, INamedTypeSymbol enclosingType, bool withBodies)
    {
        var list = args.Select(a => ArgumentFunctionOf(model, a.Expression, enclosingType, withBodies)).ToList();
        return list.Any(x => x is not null) ? list : null;
    }

    private ArgumentFunction? ArgumentFunctionOf(SemanticModel model, ExpressionSyntax arg, INamedTypeSymbol enclosingType, bool withBodies)
    {
        var e = arg;
        while (e is ParenthesizedExpressionSyntax p) e = p.Expression;
        if (e is AnonymousFunctionExpressionSyntax lambda)
        {
            // FR-1.11: passed to a project method — its body is drawn where that method invokes it
            return withBodies
                ? new ArgumentFunction("lambda", Range: SymbolRefs.Range(e), Params: FragmentScopes.ParameterNames(lambda),
                    Calls: Sites(CallCollector.Collect([lambda.Body], InlineScope, accessor: AccessorKind), enclosingType))
                : new ArgumentFunction("lambda", Range: SymbolRefs.Range(e));
        }
        if (e is not (IdentifierNameSyntax or GenericNameSyntax or MemberAccessExpressionSyntax)) return null;
        // a method group converted to a delegate: the symbol is the chosen overload; when the
        // conversion is not fully bound (e.g. a generic receiver with unresolved types) Roslyn only
        // offers candidates — a group with a single method is still unambiguous
        var info = model.GetSymbolInfo(e);
        var group = info.CandidateSymbols.OfType<IMethodSymbol>().ToList();
        if (group.Count == 0) group = model.GetMemberGroup(e).OfType<IMethodSymbol>().ToList();
        if ((info.Symbol as IMethodSymbol ?? (group.Count == 1 ? group[0] : null)) is not { } method ||
            method.MethodKind is not (MethodKind.Ordinary or MethodKind.LocalFunction or MethodKind.ReducedExtension))
        {
            return null;
        }
        var canonical = SymbolRefs.Canonical(method);
        var target = Refs.MethodRefOf(canonical);
        var objectExpr = e is MemberAccessExpressionSyntax ma ? ma.Expression : null;
        var (receiver, receiverType) = InvocationReceiver(model, method, canonical, objectExpr, enclosingType);
        var isLibrary = !SymbolRefs.IsSource(canonical);
        return new ArgumentFunction("method", target, receiver, receiverType ?? target.Owner, isLibrary, isLibrary ? SymbolRefs.LibraryName(canonical) : null);
    }

    /// <summary>FR-1.13: a delegate type declared in the solution is a port; <c>Func</c>/<c>Action</c> are not.</summary>
    private ClassRef? PortType(IParameterSymbol p) =>
        p.Type is INamedTypeSymbol { TypeKind: TypeKind.Delegate } t && SymbolRefs.IsSource(t) ? Refs.ClassRefOf(t) : null;

    private static bool IsExplicitInvoke(ExpressionSyntax callee) =>
        callee is MemberAccessExpressionSyntax { Name.Identifier.ValueText: "Invoke" } or MemberBindingExpressionSyntax { Name.Identifier.ValueText: "Invoke" };

    private (ReceiverOrigin, ClassRef?) InvocationReceiver(
        SemanticModel model, IMethodSymbol method, IMethodSymbol canonical, ExpressionSyntax? objectExpr, INamedTypeSymbol enclosingType)
    {
        // extension method or extension block member (FR-1.21): a static call on the extension class
        if (method.ReducedFrom is not null || SymbolRefs.IsExtensionBlockMember(canonical))
        {
            return (ReceiverOrigin.Static, Refs.ClassRefOf(canonical.ContainingType));
        }
        if (canonical.MethodKind == MethodKind.LocalFunction)
        {
            return (ReceiverOrigin.Self, Refs.ClassRefOf(enclosingType));
        }
        if (objectExpr is null)
        {
            // M() — own (or inherited) member, or a static using
            if (canonical.IsStatic && !IsInHierarchy(enclosingType, canonical.ContainingType))
            {
                return (ReceiverOrigin.Static, Refs.ClassRefOf(canonical.ContainingType));
            }
            return (ReceiverOrigin.Self, Refs.ClassRefOf(enclosingType));
        }
        var origin = Receivers.OriginOf(model, objectExpr, enclosingType);
        switch (origin.Kind)
        {
            case "self":
            case "super":
                return (origin, Refs.ClassRefOf(enclosingType));
            case "static":
                {
                    var t = model.GetSymbolInfo(Receivers.Unwrap(objectExpr)).Symbol as INamedTypeSymbol ?? canonical.ContainingType;
                    return (origin, Refs.ClassRefOf(t));
                }
        }
        if (canonical.IsStatic && model.GetSymbolInfo(Receivers.Unwrap(objectExpr)).Symbol is INamedTypeSymbol st)
        {
            return (ReceiverOrigin.Static, Refs.ClassRefOf(st));
        }
        return (origin, Refs.ClassRefOf(model.GetTypeInfo(objectExpr).Type));
    }

    private static bool IsInHierarchy(INamedTypeSymbol? enclosing, INamedTypeSymbol owner)
    {
        for (var t = enclosing; t is not null; t = t.ContainingType)
        {
            for (var b = (INamedTypeSymbol?)t; b is not null; b = b.BaseType)
            {
                if (SymbolEqualityComparer.Default.Equals(b.OriginalDefinition, owner.OriginalDefinition)) return true;
            }
        }
        return false;
    }

    /// <summary>
    /// FR-5.9 the type arguments a generic call names (<c>ToResponse&lt;Dto, DtoResponse&gt;()</c>), the method's and
    /// its containing types'; one that is the caller's own type parameter is passed on by name.
    /// </summary>
    private List<TypeArgument>? TypeArgumentsOf(IMethodSymbol? method)
    {
        if (method is null) return null;
        var list = new List<TypeArgument>();
        void Add(ImmutableArray<ITypeParameterSymbol> ps, ImmutableArray<ITypeSymbol> args)
        {
            for (var i = 0; i < ps.Length && i < args.Length; i++)
            {
                var a = args[i];
                if (SymbolEqualityComparer.Default.Equals(a, ps[i])) continue; // not constructed
                if (a is ITypeParameterSymbol tp) list.Add(new TypeArgument(ps[i].Name, null, tp.Name));
                else if (Refs.ClassRefOf(a) is { } r) list.Add(new TypeArgument(ps[i].Name, r, null));
            }
        }
        if (method.IsGenericMethod) Add(method.TypeParameters, method.TypeArguments);
        for (var t = method.ContainingType; t is not null; t = t.ContainingType)
            if (t.IsGenericType) Add(t.TypeParameters, t.TypeArguments);
        return list.Count > 0 ? list : null;
    }

    // ───────────────────────────── creations ─────────────────────────────

    private CallSite Creation(SemanticModel model, BaseObjectCreationExpressionSyntax c, int ordinal, INamedTypeSymbol enclosingType, IReadOnlyDictionary<SyntaxNode, int> ordinals)
    {
        var info = model.GetSymbolInfo(c);
        var ctor = (info.Symbol ?? info.CandidateSymbols.FirstOrDefault()) as IMethodSymbol;
        var type = model.GetTypeInfo(c).Type;
        var target = ctor is { MethodKind: MethodKind.Constructor } ? Refs.MethodRefOf(ctor) : null;
        var isLibrary = ctor is not null ? !SymbolRefs.IsSource(SymbolRefs.Canonical(ctor).ContainingType) : type is not null && type.TypeKind != TypeKind.Error && !SymbolRefs.IsSource(type);
        var args = c.ArgumentList?.Arguments ?? default;
        var argOrigins = args.Select(a => Receivers.ArgumentOriginOf(model, a.Expression, enclosingType, ordinals)).ToList();
        var receiverType = Refs.ClassRefOf(type) ?? target?.Owner;
        return new CallSite
        {
            // FR-5.9 `new TResponse { … }`: the caller's type argument decides the class (receiverType: the constraint)
            TypeParameter = (type as ITypeParameterSymbol)?.Name,
            Ordinal = ordinal,
            Kind = "create",
            Range = SymbolRefs.Range(c),
            MethodName = "constructor",
            ExpressionText = SymbolRefs.CompactText(c),
            Args = args.Select(a => SymbolRefs.CompactText(a)).ToList(),
            ArgOrigins = argOrigins.Any(o => o is not null) ? argOrigins : null,
            ArgFunctions = ArgumentFunctions(model, args, enclosingType, target is not null && !isLibrary),
            AssignedTo = Receivers.AssignmentTargetOf(model, c, enclosingType),
            Result = CallResults.ResultOf(c),
            Receiver = ReceiverOrigin.None,
            ReceiverType = receiverType,
            Target = target,
            IsAsync = false,
            IsLibrary = isLibrary,
            LibraryName = isLibrary && type is not null ? SymbolRefs.LibraryName(type) : null,
        };
    }

    /// <summary><c>: base(...)</c> / <c>: this(...)</c> / primary-constructor base arguments.</summary>
    private CallSite ChainedConstructor(SemanticModel model, SyntaxNode node, ArgumentListSyntax argList, bool isBase, int ordinal, INamedTypeSymbol enclosingType, IReadOnlyDictionary<SyntaxNode, int> ordinals)
    {
        var info = model.GetSymbolInfo(node);
        var ctor = (info.Symbol ?? info.CandidateSymbols.FirstOrDefault()) as IMethodSymbol;
        var target = ctor is null ? null : Refs.MethodRefOf(ctor);
        var isLibrary = ctor is not null && !SymbolRefs.IsSource(SymbolRefs.Canonical(ctor).ContainingType);
        var args = argList.Arguments;
        var argOrigins = args.Select(a => Receivers.ArgumentOriginOf(model, a.Expression, enclosingType, ordinals)).ToList();
        return new CallSite
        {
            Ordinal = ordinal,
            Kind = "call",
            Range = SymbolRefs.Range(node),
            MethodName = "constructor",
            ExpressionText = SymbolRefs.CompactText(node),
            Args = args.Select(a => SymbolRefs.CompactText(a)).ToList(),
            ArgOrigins = argOrigins.Any(o => o is not null) ? argOrigins : null,
            ArgFunctions = ArgumentFunctions(model, args, enclosingType, target is not null && !isLibrary),
            Receiver = isBase ? ReceiverOrigin.Super : ReceiverOrigin.Self,
            ReceiverType = Refs.ClassRefOf(enclosingType),
            Target = target,
            IsAsync = false,
            IsLibrary = isLibrary,
            LibraryName = isLibrary && ctor is not null ? SymbolRefs.LibraryName(ctor) : null,
        };
    }

    // ───────────────────────────── helpers ─────────────────────────────

    public static string SyntacticName(ExpressionSyntax callee) => callee switch
    {
        IdentifierNameSyntax id => id.Identifier.ValueText,
        GenericNameSyntax g => g.Identifier.ValueText,
        MemberAccessExpressionSyntax ma => ma.Name.Identifier.ValueText,
        MemberBindingExpressionSyntax mb => mb.Name.Identifier.ValueText,
        _ => SymbolRefs.CompactText(callee),
    };

    /// <summary>The call's value flows into <c>await</c> (through parentheses, <c>?.</c> chains and <c>ConfigureAwait</c>).</summary>
    public static bool IsAwaited(SyntaxNode call)
    {
        SyntaxNode node = call;
        while (true)
        {
            var parent = node.Parent;
            switch (parent)
            {
                case ParenthesizedExpressionSyntax:
                    node = parent;
                    continue;
                case ConditionalAccessExpressionSyntax ca when ca.WhenNotNull == node:
                    node = parent;
                    continue;
                case MemberAccessExpressionSyntax { Name.Identifier.ValueText: "ConfigureAwait" } ma when ma.Expression == node && ma.Parent is InvocationExpressionSyntax cfg:
                    node = cfg;
                    continue;
                case AwaitExpressionSyntax:
                    return true;
                default:
                    return false;
            }
        }
    }

    public static bool ReturnsAwaitable(IMethodSymbol method)
    {
        if (method.ReturnsVoid) return false;
        if (method.ReturnType is not INamedTypeSymbol rt) return false;
        var def = rt.OriginalDefinition;
        var ns = SymbolRefs.NamespaceOf(def);
        return (ns, def.MetadataName) switch
        {
            ("System.Threading.Tasks", "Task" or "Task`1" or "ValueTask" or "ValueTask`1") => true,
            ("System.Collections.Generic", "IAsyncEnumerable`1") => true,
            _ => false,
        };
    }
}

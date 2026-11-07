using System.Text.RegularExpressions;
using Seqcall.CSharp.Protocol;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Seqcall.CSharp.Analysis;

/// <summary>
/// FR-8.6 the dependency-injection registrations in the solution's source, for two containers:
/// <list type="bullet">
/// <item>Microsoft.Extensions.DependencyInjection: <c>services.AddScoped&lt;IX, X&gt;()</c>, <c>AddSingleton&lt;X&gt;()</c>,
/// <c>TryAdd…</c>, keyed services (<c>AddKeyedSingleton&lt;IX, X&gt;("key")</c>), factories (<c>AddScoped&lt;IX&gt;(sp =&gt; new X(…))</c>),
/// instances, <c>typeof</c> pairs, typed HTTP clients (<c>AddHttpClient&lt;IX, X&gt;()</c>);</item>
/// <item>Autofac: <c>builder.RegisterType&lt;X&gt;()</c> / <c>RegisterType(typeof(X))</c> / <c>Register(c =&gt; new X(…))</c> /
/// <c>RegisterInstance(x)</c>, then <c>.As&lt;IX&gt;()</c>, <c>.AsImplementedInterfaces()</c>, <c>.AsSelf()</c>, <c>.Keyed</c> /
/// <c>.Named</c>, lifetimes, <c>.PreserveExistingDefaults()</c>; a type chosen by a run-time condition
/// (<c>var t = live ? typeof(A) : typeof(B); RegisterType(t)</c>) is one registration per branch, never chosen.</item>
/// </list>
/// Only project types; in source order (file path, position). Each registration names the executable projects
/// (hosts) that run it: those whose project references include the registering project — one host's
/// registrations must not decide for another (e.g. a web host and an exporter bind one interface
/// to different classes).
/// </summary>
public sealed partial class Bindings(AnalysisContext ctx)
{
    private static readonly string[] Lifetimes = ["Singleton", "Scoped", "Transient"];

    /// <summary>Files mentioning a registration method; only their invocations named so get a semantic look.</summary>
    [GeneratedRegex(@"\b(Try)?Add(Keyed)?(Singleton|Scoped|Transient)\b|\bAddHttpClient\b|\bRegister(Type|Instance)?\b")]
    private static partial Regex RegistrationText();

    private static readonly HashSet<string> AutofacSources = ["RegisterType", "Register", "RegisterInstance"];

    public IReadOnlyList<ContainerBinding> Find(CancellationToken ct)
    {
        var hostsOf = HostsByProject();
        var result = new List<(string Path, int Pos, ContainerBinding B)>();
        var seen = new HashSet<string>();
        foreach (var project in ctx.Solution.Projects)
        {
            if (ctx.CompilationOf(project) is not { } compilation || AnalysisContext.IsTestProject(project)) continue;
            var hosts = hostsOf.GetValueOrDefault(project.Id);
            foreach (var tree in compilation.SyntaxTrees)
            {
                ct.ThrowIfCancellationRequested();
                if (!ctx.IsRegularTree(tree) || ctx.IsTestFile(tree.FilePath) || !seen.Add(tree.FilePath)) continue;
                if (!RegistrationText().IsMatch(tree.GetText(ct).ToString())) continue;
                SemanticModel? model = null;
                foreach (var inv in tree.GetRoot(ct).DescendantNodes().OfType<InvocationExpressionSyntax>())
                {
                    var name = NameOf(inv.Expression);
                    if (name is null || !RegistrationText().IsMatch(name)) continue;
                    model ??= compilation.GetSemanticModel(tree);
                    var when = Condition(inv);
                    foreach (var r in Registrations(model, inv, name, ct))
                    {
                        // a registration inside if / else / switch happens only under that condition (e.g. a replay or a live service)
                        var b = when is null || r.KeyKind == "key" ? r : r with { Key = r.Key is null ? when : $"{when} && {r.Key}", KeyKind = "condition" };
                        result.Add((tree.FilePath, inv.SpanStart, hosts is null ? b : b with { Hosts = hosts }));
                    }
                }
            }
        }
        return result.OrderBy(r => r.Path, StringComparer.Ordinal).ThenBy(r => r.Pos).Select(r => r.B).ToList();
    }

    /// <summary>The conditions of the <c>if</c> / <c>else</c> / <c>switch</c> statements around a registration in its method, outermost first.</summary>
    private static string? Condition(SyntaxNode node)
    {
        var parts = new List<string>();
        for (var n = node; n.Parent is not null && n is not MemberDeclarationSyntax && n is not LocalFunctionStatementSyntax; n = n.Parent)
        {
            switch (n.Parent)
            {
                case IfStatementSyntax ifs when n == ifs.Statement:
                    parts.Add(SymbolRefs.CompactText(ifs.Condition));
                    break;
                case ElseClauseSyntax { Parent: IfStatementSyntax ife }:
                    parts.Add(Negate(ife.Condition));
                    break;
                case SwitchSectionSyntax section when n is StatementSyntax:
                    var on = section.Parent is SwitchStatementSyntax sw ? SymbolRefs.CompactText(sw.Expression) : "?";
                    parts.Add(string.Join(" || ", section.Labels.Select(l => l is CaseSwitchLabelSyntax c ? $"{on} == {SymbolRefs.CompactText(c.Value)}" : "default")));
                    break;
            }
        }
        parts.Reverse();
        return parts.Count == 0 ? null : string.Join(" && ", parts);
    }

    private static string Negate(ExpressionSyntax c) => c is IdentifierNameSyntax or MemberAccessExpressionSyntax or InvocationExpressionSyntax ? $"!{SymbolRefs.CompactText(c)}" : $"!({SymbolRefs.CompactText(c)})";

    /// <summary>The executable projects (hosts) that can run code of <paramref name="file"/>: those referencing its project.</summary>
    public IReadOnlyList<string> HostsOf(string file)
    {
        var hostsOf = HostsByProject();
        return ctx.DocumentsAt(file).SelectMany(d => hostsOf.GetValueOrDefault(d.Project.Id) ?? []).Distinct().OrderBy(h => h, StringComparer.Ordinal).ToList();
    }

    /// <summary>Project → the hosts whose project references (transitively) include it; executables only, no test projects.</summary>
    private Dictionary<ProjectId, IReadOnlyList<string>> HostsByProject()
    {
        var graph = ctx.Solution.GetProjectDependencyGraph();
        var map = new Dictionary<ProjectId, List<string>>();
        foreach (var host in ctx.Solution.Projects)
        {
            if (ctx.CompilationOf(host) is not { } c || AnalysisContext.IsTestProject(host)) continue;
            if (c.Options.OutputKind is not (OutputKind.ConsoleApplication or OutputKind.WindowsApplication)) continue;
            foreach (var id in graph.GetProjectsThatThisProjectTransitivelyDependsOn(host.Id).Append(host.Id))
            {
                if (!map.TryGetValue(id, out var list)) map[id] = list = [];
                if (!list.Contains(host.Name)) list.Add(host.Name);
            }
        }
        return map.ToDictionary(kv => kv.Key, kv => (IReadOnlyList<string>)kv.Value);
    }

    private static string? NameOf(ExpressionSyntax e) => e switch
    {
        MemberAccessExpressionSyntax ma => ma.Name.Identifier.ValueText,
        SimpleNameSyntax n => n.Identifier.ValueText,
        _ => null,
    };

    private List<ContainerBinding> Registrations(SemanticModel model, InvocationExpressionSyntax inv, string name, CancellationToken ct)
    {
        if (model.GetSymbolInfo(inv, ct).Symbol is not IMethodSymbol m) return [];
        var ns = (m.ReducedFrom ?? m).ContainingNamespace?.ToDisplayString() ?? "";
        if (ns.StartsWith("Microsoft.Extensions.DependencyInjection", StringComparison.Ordinal))
            return MsDi(model, inv, m, ct) is { } b ? [b] : [];
        if (ns.StartsWith("Autofac", StringComparison.Ordinal) && AutofacSources.Contains(name))
            return Autofac(model, inv, m, ct);
        return [];
    }

    // ───────────── Microsoft.Extensions.DependencyInjection ─────────────

    private ContainerBinding? MsDi(SemanticModel model, InvocationExpressionSyntax inv, IMethodSymbol m, CancellationToken ct)
    {
        var name = m.Name;
        var fallback = name.StartsWith("TryAdd", StringComparison.Ordinal);
        var verb = fallback ? name["TryAdd".Length..] : name.StartsWith("Add", StringComparison.Ordinal) ? name["Add".Length..] : null;
        if (verb is null) return null;
        var keyed = verb.StartsWith("Keyed", StringComparison.Ordinal);
        if (keyed) verb = verb["Keyed".Length..];
        var lifetime = Lifetimes.FirstOrDefault(l => verb == l);
        var httpClient = verb == "HttpClient";
        if (lifetime is null && !httpClient) return null;

        var args = inv.ArgumentList.Arguments;
        INamedTypeSymbol? service, impl;
        var typeArgs = m.TypeArguments.OfType<INamedTypeSymbol>().ToList();
        if (typeArgs.Count >= 2)
        {
            service = typeArgs[0];
            impl = typeArgs[1];
        }
        else if (typeArgs.Count == 1)
        {
            service = typeArgs[0];
            // a factory names the class it creates; an instance has its own type
            impl = args.Select(a => a.Expression).Select(e => Created(model, e, ct) ?? (e is LambdaExpressionSyntax ? null : model.GetTypeInfo(e, ct).Type as INamedTypeSymbol)).FirstOrDefault(t => t is not null && SymbolRefs.IsSource(t)) ?? service;
        }
        else
        {
            // AddScoped(typeof(IX), typeof(X)) / AddSingleton(typeof(X))
            var types = args.Select(a => a.Expression).OfType<TypeOfExpressionSyntax>().Select(t => model.GetTypeInfo(t.Type, ct).Type as INamedTypeSymbol).ToList();
            if (types.Count == 0 || types.Any(t => t is null)) return null;
            service = types[0];
            impl = types.Count > 1 ? types[1] : types[0];
        }
        if (service is null || impl is null || !SymbolRefs.IsSource(service) || !SymbolRefs.IsSource(impl)) return null;
        string? key = null;
        if (keyed)
        {
            // the key is the first argument that is no factory / instance of the implementation
            var k = args.Select(a => a.Expression).FirstOrDefault(e => e is not LambdaExpressionSyntax && e is not TypeOfExpressionSyntax);
            key = k is null ? "?" : SymbolRefs.CompactText(k);
        }
        return Binding(service, impl, inv, key, key is null ? null : "key", httpClient ? "transient" : lifetime!.ToLowerInvariant(), fallback);
    }

    // ───────────── Autofac ─────────────

    private List<ContainerBinding> Autofac(SemanticModel model, InvocationExpressionSyntax inv, IMethodSymbol m, CancellationToken ct)
    {
        // what is registered: (implementation, the run-time condition choosing it)
        var sources = new List<(INamedTypeSymbol Type, string? When)>();
        var typeArg = m.TypeArguments.OfType<INamedTypeSymbol>().FirstOrDefault();
        var arg = inv.ArgumentList.Arguments.FirstOrDefault()?.Expression;
        switch (m.Name)
        {
            case "RegisterType" when typeArg is not null:
                sources.Add((typeArg, null));
                break;
            case "RegisterType" when arg is not null:
                sources.AddRange(TypeValues(model, arg, ct));
                break;
            case "Register":
                if ((arg is null ? null : Created(model, arg, ct)) is { } created) sources.Add((created, null));
                else if (typeArg is not null) sources.Add((typeArg, null));
                break;
            case "RegisterInstance" when arg is not null:
                if (model.GetTypeInfo(arg, ct).Type is INamedTypeSymbol t) sources.Add((t, null));
                break;
        }
        sources.RemoveAll(s => !SymbolRefs.IsSource(s.Type));
        if (sources.Count == 0) return [];

        // the fluent chain after it: services, keys, lifetime
        var services = new List<(INamedTypeSymbol? Type, string? Key)>(); // Type null = the implementation itself
        var implemented = false;
        string? lifetime = null;
        var fallback = false;
        SyntaxNode node = inv;
        while (node.Parent is MemberAccessExpressionSyntax ma && ma.Parent is InvocationExpressionSyntax next)
        {
            var call = model.GetSymbolInfo(next, ct).Symbol as IMethodSymbol;
            var types = call?.TypeArguments.OfType<INamedTypeSymbol>().ToList() ?? [];
            var typeofs = next.ArgumentList.Arguments.Select(a => a.Expression).OfType<TypeOfExpressionSyntax>().Select(t => model.GetTypeInfo(t.Type, ct).Type).OfType<INamedTypeSymbol>().ToList();
            switch (ma.Name.Identifier.ValueText)
            {
                case "As":
                    services.AddRange(types.Concat(typeofs).Select(t => ((INamedTypeSymbol?)t, (string?)null)));
                    break;
                case "AsSelf":
                    services.Add((null, null));
                    break;
                case "AsImplementedInterfaces":
                    implemented = true;
                    break;
                case "Keyed" or "Named":
                    var key = next.ArgumentList.Arguments.FirstOrDefault() is { } k ? SymbolRefs.CompactText(k.Expression) : "?";
                    services.AddRange(types.Concat(typeofs).Select(t => ((INamedTypeSymbol?)t, (string?)key)));
                    break;
                case "SingleInstance":
                    lifetime = "singleton";
                    break;
                case "InstancePerLifetimeScope" or "InstancePerRequest" or "InstancePerMatchingLifetimeScope":
                    lifetime = "scoped";
                    break;
                case "InstancePerDependency":
                    lifetime = "transient";
                    break;
                case "PreserveExistingDefaults":
                    fallback = true;
                    break;
            }
            node = next;
        }
        if (services.Count == 0 && !implemented) services.Add((null, null)); // Autofac's default: as itself

        var result = new List<ContainerBinding>();
        foreach (var (impl, when) in sources)
        {
            var all = services.Select(s => (Type: s.Type ?? impl, s.Key)).ToList();
            if (implemented) all.AddRange(impl.AllInterfaces.Where(SymbolRefs.IsSource).Select(i => (Type: i, Key: (string?)null)));
            foreach (var (service, key) in all)
            {
                if (!SymbolRefs.IsSource(service)) continue;
                var k = key ?? when;
                result.Add(Binding(service, impl, inv, k, key is not null ? "key" : when is not null ? "condition" : null, lifetime ?? "transient", fallback));
            }
        }
        return result;
    }

    /// <summary>
    /// The type(s) an expression denotes: <c>typeof(X)</c>; a local / field whose initializer is <c>typeof(X)</c> or
    /// <c>cond ? typeof(A) : typeof(B)</c> (one per branch, with the condition that picks it).
    /// </summary>
    private static List<(INamedTypeSymbol, string?)> TypeValues(SemanticModel model, ExpressionSyntax e, CancellationToken ct, string? when = null)
    {
        switch (e)
        {
            case TypeOfExpressionSyntax t:
                return model.GetTypeInfo(t.Type, ct).Type is INamedTypeSymbol nt ? [(nt, when)] : [];
            case ConditionalExpressionSyntax c:
                var cond = SymbolRefs.CompactText(c.Condition);
                return [.. TypeValues(model, c.WhenTrue, ct, cond), .. TypeValues(model, c.WhenFalse, ct, Negate(c.Condition))];
            case ParenthesizedExpressionSyntax p:
                return TypeValues(model, p.Expression, ct, when);
            case IdentifierNameSyntax id when model.GetSymbolInfo(id, ct).Symbol is ILocalSymbol or IFieldSymbol:
                var symbol = model.GetSymbolInfo(id, ct).Symbol!;
                var init = symbol.DeclaringSyntaxReferences.Select(r => r.GetSyntax(ct)).OfType<VariableDeclaratorSyntax>().FirstOrDefault()?.Initializer?.Value;
                return init is not null && init.SyntaxTree == e.SyntaxTree ? TypeValues(model, init, ct, when) : [];
            default:
                return [];
        }
    }

    private ContainerBinding Binding(INamedTypeSymbol service, INamedTypeSymbol impl, InvocationExpressionSyntax at, string? key, string? keyKind, string? lifetime, bool fallback) =>
        new(ctx.Refs.ClassRefOf(service).Key, ctx.Refs.ClassRefOf(impl).Key, null, SymbolRefs.Range(at), key, lifetime, fallback ? true : null, keyKind, AbstractArgs: TypeArgKeys(service));

    /// <summary>A constructed generic service (<c>INotifier&lt;Shipment&gt;</c>): its type arguments' class keys; open generics none.</summary>
    private IReadOnlyList<string>? TypeArgKeys(INamedTypeSymbol service)
    {
        if (!service.IsGenericType || service.IsUnboundGenericType || service.TypeArguments.Any(a => a is ITypeParameterSymbol)) return null;
        var keys = service.TypeArguments.Select(a => ctx.Refs.ClassRefOf(a)?.Key).ToList();
        return keys.All(k => k is not null) ? keys.Select(k => k!).ToList() : null;
    }

    /// <summary>The class a factory lambda creates: <c>sp =&gt; new X(…)</c> (the first <c>new</c> of a project class).</summary>
    private static INamedTypeSymbol? Created(SemanticModel model, ExpressionSyntax e, CancellationToken ct)
    {
        if (e is not LambdaExpressionSyntax lambda) return null;
        return lambda.DescendantNodes().OfType<BaseObjectCreationExpressionSyntax>()
            .Select(c => model.GetTypeInfo(c, ct).Type as INamedTypeSymbol)
            .FirstOrDefault(t => t is not null && SymbolRefs.IsSource(t));
    }
}

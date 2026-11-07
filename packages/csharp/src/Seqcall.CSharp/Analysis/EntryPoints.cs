using System.Globalization;
using System.Text.RegularExpressions;
using Seqcall.CSharp.Protocol;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace Seqcall.CSharp.Analysis;

/// <summary>
/// FR-16.1 where flows start in a C# solution: ASP.NET controller actions (with their combined
/// routes) and minimal-API endpoints, the program entry point, hosted services, message handlers,
/// Azure Functions and test methods.
/// </summary>
public sealed partial class EntryPoints(AnalysisContext ctx)
{
    private static readonly Dictionary<string, string> HttpAttributes = new()
    {
        ["HttpGet"] = "GET", ["HttpPost"] = "POST", ["HttpPut"] = "PUT", ["HttpPatch"] = "PATCH",
        ["HttpDelete"] = "DELETE", ["HttpHead"] = "HEAD", ["HttpOptions"] = "OPTIONS",
    };
    private static readonly Dictionary<string, string> MapMethods = new()
    {
        ["MapGet"] = "GET", ["MapPost"] = "POST", ["MapPut"] = "PUT", ["MapPatch"] = "PATCH", ["MapDelete"] = "DELETE",
    };
    private static readonly Dictionary<string, string> TestAttributes = new()
    {
        ["Fact"] = "xUnit", ["Theory"] = "xUnit", ["Test"] = "NUnit", ["TestCase"] = "NUnit", ["TestCaseSource"] = "NUnit",
        ["TestMethod"] = "MSTest", ["DataTestMethod"] = "MSTest",
    };
    /// <summary>Handler interfaces (by simple name, any arity) → (handling methods, detail).</summary>
    private static readonly Dictionary<string, (string[] Methods, string Detail)> HandlerInterfaces = new()
    {
        ["IRequestHandler"] = (["Handle"], "MediatR handler"),
        ["INotificationHandler"] = (["Handle"], "MediatR handler"),
        ["IConsumer"] = (["Consume"], "MassTransit consumer"),
        ["IHandleMessages"] = (["Handle"], "message handler"),
        ["ICommandHandler"] = (["Handle", "HandleAsync"], "command handler"),
        ["IQueryHandler"] = (["Handle", "HandleAsync"], "query handler"),
        ["IEventHandler"] = (["Handle", "HandleAsync"], "event handler"),
        ["IIntegrationEventHandler"] = (["Handle", "HandleAsync"], "event handler"),
    };

    private readonly List<EntryPoint> _result = [];
    private readonly HashSet<string> _seen = [];

    public IReadOnlyList<EntryPoint> Find(CancellationToken ct)
    {
        foreach (var compilation in ctx.Compilations)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                if (compilation.GetEntryPoint(ct) is { } main && SymbolRefs.IsSource(main))
                {
                    // the project's name: a solution of several applications has several Program.cs
                    var label = main.Name == "<Main>$" ? $"{compilation.AssemblyName}/{FileName(main)} (top-level statements)" : $"{main.ContainingType.Name}.{main.Name}";
                    Add("cli", label, null, "program entry point", main);
                }
            }
            catch (Exception ex)
            {
                Log.Debug($"entry point of {compilation.AssemblyName}: {ex.Message}");
            }
            foreach (var tree in compilation.SyntaxTrees)
            {
                if (!ctx.IsRegularTree(tree)) continue;
                var model = compilation.GetSemanticModel(tree);
                var root = tree.GetRoot(ct);
                var isTestFile = ctx.IsTestFile(tree.FilePath);
                foreach (var node in root.DescendantNodes())
                {
                    switch (node)
                    {
                        case MethodDeclarationSyntax md when model.GetDeclaredSymbol(md, ct) is IMethodSymbol method:
                            Method(method, isTestFile);
                            break;
                        case InvocationExpressionSyntax inv:
                            MinimalApi(model, inv, ct);
                            break;
                    }
                }
            }
        }
        string[] order = ["http", "cli", "job", "handler", "test"];
        return _result
            .OrderBy(e => Array.IndexOf(order, e.Kind))
            .ThenBy(e => e.Label, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private void Method(IMethodSymbol method, bool isTestFile)
    {
        var type = method.ContainingType;
        var attrs = method.GetAttributes().Select(a => Simple(a.AttributeClass?.Name)).ToList();
        var qualified = $"{type.Name}.{method.Name}";

        foreach (var a in method.GetAttributes())
        {
            if (Simple(a.AttributeClass?.Name) is { } name && HttpAttributes.TryGetValue(name, out var verb) && !isTestFile)
            {
                Add("http", $"{verb} {Route(type, method, Template(a))}", verb, "controller", method);
            }
        }
        if (attrs.FirstOrDefault(a => a is "Function" or "FunctionName") is { } fn)
        {
            var name = method.GetAttributes().First(a => Simple(a.AttributeClass?.Name) == fn).ConstructorArguments.FirstOrDefault().Value as string;
            Add("handler", name is null ? qualified : $"{name} ({qualified})", null, "Azure Function", method);
        }
        if (attrs.Select(a => a is null ? null : TestAttributes.GetValueOrDefault(a)).FirstOrDefault(d => d is not null) is { } framework)
        {
            Add("test", qualified, null, framework, method);
        }
        if (method.IsStatic) return;
        if (method.Name == "ExecuteAsync" && DerivesFrom(type, "BackgroundService")) Add("job", qualified, null, "BackgroundService", method);
        else if (method.Name == "StartAsync" && !DerivesFrom(type, "BackgroundService") && type.AllInterfaces.Any(i => i.Name == "IHostedService"))
        {
            Add("job", qualified, null, "IHostedService", method);
        }
        foreach (var i in type.AllInterfaces)
        {
            if (HandlerInterfaces.TryGetValue(i.Name, out var h) && h.Methods.Contains(method.Name))
            {
                var message = i.TypeArguments.FirstOrDefault()?.Name;
                Add("handler", qualified, null, message is null ? h.Detail : $"{h.Detail} ({message})", method);
                break;
            }
        }
    }

    /// <summary><c>app.MapGet("/x", Handler)</c>; an inline lambda falls back to the method that registers it.</summary>
    private void MinimalApi(SemanticModel model, InvocationExpressionSyntax inv, CancellationToken ct)
    {
        var name = inv.Expression switch
        {
            MemberAccessExpressionSyntax ma => ma.Name.Identifier.ValueText,
            _ => null,
        };
        if (name is null || !MapMethods.TryGetValue(name, out var verb)) return;
        var args = inv.ArgumentList.Arguments;
        if (args.Count < 2 || model.GetConstantValue(args[0].Expression, ct).Value is not string pattern) return;
        var handler = args[^1].Expression;
        var target = handler is AnonymousFunctionExpressionSyntax
            ? model.GetEnclosingSymbol(inv.SpanStart, ct) as IMethodSymbol
            : (model.GetSymbolInfo(handler, ct).Symbol ?? model.GetSymbolInfo(handler, ct).CandidateSymbols.FirstOrDefault()) as IMethodSymbol;
        if (target is not null) Add("http", $"{verb} /{pattern.TrimStart('/')}", verb, "minimal API", target);
    }

    private void Add(string kind, string label, string? verb, string? detail, IMethodSymbol method)
    {
        var canonical = SymbolRefs.Canonical(method);
        if (!SymbolRefs.IsSource(canonical)) return;
        var reference = ctx.Refs.MethodRefOf(canonical);
        if (!_seen.Add($"{kind}|{verb}|{reference.Key}")) return;
        _result.Add(new EntryPoint(kind, label, verb, detail, reference));
    }

    /// <summary>Class [Route] + action template; "/" or "~/" makes the action template absolute; [controller]/[action] substituted.</summary>
    private static string Route(INamedTypeSymbol type, IMethodSymbol method, string? template)
    {
        template ??= method.GetAttributes().Where(a => Simple(a.AttributeClass?.Name) == "Route").Select(Template).FirstOrDefault();
        var prefix = type.GetAttributes().Where(a => Simple(a.AttributeClass?.Name) == "Route").Select(Template).FirstOrDefault()
            ?? BaseRoute(type.BaseType);
        string path;
        if (template is not null && (template.StartsWith('/') || template.StartsWith("~/"))) path = template.TrimStart('~');
        else path = "/" + string.Join('/', new[] { prefix, template }.Where(p => !string.IsNullOrEmpty(p)).Select(p => p!.Trim('/')));
        var controller = type.Name.EndsWith("Controller", StringComparison.Ordinal) ? type.Name[..^"Controller".Length] : type.Name;
        path = path.Replace("[controller]", controller, StringComparison.OrdinalIgnoreCase).Replace("[action]", method.Name, StringComparison.OrdinalIgnoreCase);
        return ApiVersionSegment().IsMatch(path) && ApiVersions(type, method) is { Count: > 0 } versions
            ? ApiVersionSegment().Replace(path, string.Join('|', versions))
            : path;
    }

    [GeneratedRegex(@"\{[^{}:]+:apiVersion\}", RegexOptions.IgnoreCase, matchTimeoutMilliseconds: 1000)]
    private static partial Regex ApiVersionSegment();

    /// <summary>
    /// FR-16.13 the versions an action serves (Asp.Versioning): its [MapToApiVersion], else its own [ApiVersion], else
    /// the controller's (and its base classes'), ordered; read from the syntax when the package is not restored.
    /// </summary>
    private static List<string> ApiVersions(INamedTypeSymbol type, IMethodSymbol method)
    {
        static List<string> Of(ISymbol s, string attribute) =>
            s.GetAttributes().Where(a => Simple(a.AttributeClass?.Name) == attribute).Select(VersionOf).OfType<string>().ToList();
        var versions = Of(method, "MapToApiVersion");
        if (versions.Count == 0) versions = Of(method, "ApiVersion");
        for (var t = type; versions.Count == 0 && t is not null; t = t.BaseType) versions = Of(t, "ApiVersion");
        return versions.Distinct()
            .OrderBy(v => Version.TryParse(v.Contains('.') ? v : $"{v}.0", out var x) ? x : new Version(int.MaxValue, 0))
            .ThenBy(v => v, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>
    /// The constructors of Asp.Versioning (8.x/10.x): <c>("1.4")</c>, <c>(1.4, status = null)</c>,
    /// <c>(2025, 1, 15, status = null)</c> → "1.4", "1.4" / "1.4-beta", "2025-01-15"; resolved, the optional status
    /// is a second (null) argument. <c>(1, 3)</c> → "1.3" is kept for look-alike attributes.
    /// </summary>
    private static string? VersionOf(AttributeData a)
    {
        var args = a.ConstructorArguments.Select(c => c.Value).ToList();
        if (args.Count == 0 && a.ApplicationSyntaxReference?.GetSyntax() is AttributeSyntax syntax)
        {
            // unresolved attribute (package not restored): the literals as written, typed (1.4 a double, "1.4" a string)
            args = (syntax.ArgumentList?.Arguments ?? default).Where(x => x.NameEquals is null && x.NameColon is null)
                .Select(x => x.Expression is LiteralExpressionSyntax literal ? literal.Token.Value : x.Expression.ToString()).ToList();
        }
        static string Status(string version, object? status) =>
            status is string s && s.Length > 0 ? $"{version}-{s}" : version;
        static string Number(double d) => d.ToString("0.0###", CultureInfo.InvariantCulture);
        return args switch
        {
            [string v] => v,
            [double d] => Number(d),
            [int major] => $"{major}.0", // unresolved [ApiVersion(1)]
            [double d, var status] when status is null or string => Status(Number(d), status),
            [int year, int month, int day] => $"{year:D4}-{month:D2}-{day:D2}",
            [int year, int month, int day, var status] when status is null or string => Status($"{year:D4}-{month:D2}-{day:D2}", status),
            [int major, int minor] => $"{major}.{minor}",
            _ => null,
        };
    }

    private static string? BaseRoute(INamedTypeSymbol? type)
    {
        for (var t = type; t is not null; t = t.BaseType)
        {
            var r = t.GetAttributes().Where(a => Simple(a.AttributeClass?.Name) == "Route").Select(Template).FirstOrDefault();
            if (r is not null) return r;
        }
        return null;
    }

    private static string? Template(AttributeData a) =>
        a.ConstructorArguments.FirstOrDefault().Value as string
        ?? a.NamedArguments.FirstOrDefault(n => n.Key == "Template").Value.Value as string;

    private static string? Simple(string? attributeName) =>
        attributeName is null ? null : attributeName.EndsWith("Attribute", StringComparison.Ordinal) ? attributeName[..^"Attribute".Length] : attributeName;

    private static bool DerivesFrom(INamedTypeSymbol type, string baseName)
    {
        for (var t = type.BaseType; t is not null; t = t.BaseType) if (t.Name == baseName) return true;
        return false;
    }

    private static string FileName(IMethodSymbol m) => Path.GetFileName(m.Locations.FirstOrDefault()?.SourceTree?.FilePath ?? "Program.cs");
}

namespace Seqcall.CSharp.Protocol;

// DTOs mirror packages/protocol/src/index.ts and packages/core/src/adapter.ts exactly
// (camelCase JSON names via the serializer options, nulls omitted).

public sealed record Position(int Line, int Character);

public sealed record SourceRange(string File, Position Start, Position End);

public static class ClassKinds
{
    public const string Class = "class";
    public const string Interface = "interface";
    public const string Abstract = "abstract";
    public const string External = "external";
}

public sealed record ClassRef(string Key, string Name, string Kind, SourceRange? Declaration = null);

public sealed record MethodRef(
    string Key,
    string Name,
    ClassRef Owner,
    bool IsStatic,
    SourceRange? Declaration,
    bool HasBody);

/// <summary>Union: self | super | field{name} | parameter{name} | local{name} | static | module{name} | expression{text} | created{ordinal} | none.</summary>
public sealed record ReceiverOrigin(string Kind, string? Name = null, string? Text = null, int? Ordinal = null)
{
    public static readonly ReceiverOrigin Self = new("self");
    public static readonly ReceiverOrigin Super = new("super");
    public static readonly ReceiverOrigin Static = new("static");
    public static readonly ReceiverOrigin None = new("none");
    public static ReceiverOrigin Field(string name) => new("field", name);
    public static ReceiverOrigin Parameter(string name) => new("parameter", name);
    public static ReceiverOrigin Local(string name) => new("local", name);
    public static ReceiverOrigin Expression(string text) => new("expression", Text: text);
    public static ReceiverOrigin Created(int ordinal) => new("created", Ordinal: ordinal);
}

/// <summary>Union: self | field{name} | parameter{name} | local{name} | created{ordinal}.</summary>
public sealed record ArgumentOrigin(string Kind, string? Name = null, int? Ordinal = null)
{
    public static readonly ArgumentOrigin Self = new("self");
    public static ArgumentOrigin Field(string name) => new("field", name);
    public static ArgumentOrigin Parameter(string name) => new("parameter", name);
    public static ArgumentOrigin Local(string name) => new("local", name);
    public static ArgumentOrigin Created(int ordinal) => new("created", Ordinal: ordinal);
}

public sealed record AssignmentTarget(string Kind, string Name);

/// <summary>FR-7.7: what a type takes / uses / depends on (whole type).</summary>
public sealed record ModuleFacts(IReadOnlyList<string> Ports, IReadOnlyList<string> Libraries, IReadOnlyList<ClassRef> DependsOn);

/// <summary>FR-16.1: where a flow starts (kind http | cli | job | handler | test).</summary>
public sealed record EntryPoint(string Kind, string Label, string? Verb, string? Detail, MethodRef Method);

/// <summary>FR-1.15: an early return / throw of a body (kind return | throw); <c>Value</c> (FR-3.9): a return's expression, compacted ("" for a bare return).</summary>
public sealed record EarlyExit(string Kind, SourceRange Range, string? Exception, IReadOnlyList<FragmentScope>? Fragments, string? Value = null);

/// <summary>FR-5.9: a type argument of a generic call — a class, or the caller's own type parameter (Parameter).</summary>
public sealed record TypeArgument(string Name, ClassRef? Type, string? Parameter);

/// <summary>FR-5.8: a return statement (or expression body); <c>Tuple</c>: the values are a tuple literal's elements.</summary>
public sealed record ReturnFact(SourceRange Range, bool? Tuple, IReadOnlyList<ReturnValue> Values);

/// <summary>FR-5.8: a returned value — a local <c>Variable</c>, <c>Empty</c> (null / default), else an expression.</summary>
public sealed record ReturnValue(SourceRange Range, string? Variable, bool? Empty);

/// <summary>FR-9.4: kind assign (target as written, operator) | return.</summary>
public sealed record CallResult(string Kind, string? Target = null, string? Operator = null);

/// <summary>Union (FR-1.13): method{target, receiver, receiverType, isLibrary, libraryName} | lambda{range, params?, calls?} (FR-1.11).</summary>
public sealed record ArgumentFunction(
    string Kind,
    MethodRef? Target = null,
    ReceiverOrigin? Receiver = null,
    ClassRef? ReceiverType = null,
    bool? IsLibrary = null,
    string? LibraryName = null,
    SourceRange? Range = null,
    IReadOnlyList<string>? Params = null,
    IReadOnlyList<CallSite>? Calls = null);

public sealed record CallSite
{
    public required int Ordinal { get; init; }
    public required string Kind { get; init; } // call | create
    public required SourceRange Range { get; init; }
    public required string MethodName { get; init; }
    public required string ExpressionText { get; init; }
    public required IReadOnlyList<string> Args { get; init; }
    public IReadOnlyList<ArgumentOrigin?>? ArgOrigins { get; init; }
    /// <summary>Method groups / lambdas passed as arguments, per argument index (FR-1.13).</summary>
    public IReadOnlyList<ArgumentFunction?>? ArgFunctions { get; init; }
    /// <summary>The call invokes a delegate-typed parameter of the analysed method (FR-1.13).</summary>
    public string? InvokedParameter { get; init; }
    /// <summary>With InvokedParameter: its type when that is a delegate type declared in the solution — the port (FR-1.13).</summary>
    public ClassRef? InvokedParameterType { get; init; }
    /// <summary>FR-1.18 not written as a call: a read of a property with a getter body / an assignment to one with a setter body.</summary>
    public string? Accessor { get; init; }
    public AssignmentTarget? AssignedTo { get; init; }
    /// <summary>FR-9.4 (calls and creations): where the result goes.</summary>
    public CallResult? Result { get; init; }
    /// <summary>FR-9.5 (calls only): declared return type, awaited when awaited; null for void.</summary>
    public string? ReturnType { get; init; }
    public required ReceiverOrigin Receiver { get; init; }
    public ClassRef? ReceiverType { get; init; }
    /// <summary>FR-5.9 a creation of a generic type parameter: its name (ReceiverType is its constraint).</summary>
    public string? TypeParameter { get; init; }
    /// <summary>FR-5.9 the type arguments of a generic call (method and receiver type).</summary>
    public IReadOnlyList<TypeArgument>? TypeArguments { get; init; }
    public MethodRef? Target { get; init; }
    public required bool IsAsync { get; init; }
    public required bool IsLibrary { get; init; }
    public string? LibraryName { get; init; }
    /// <summary>Enclosing control-flow constructs of the body, outermost first (FR-1.10); null = unconditional.</summary>
    public IReadOnlyList<FragmentScope>? Fragments { get; init; }
}

/// <summary>One enclosing construct of a call (FR-1.10): kind alt | opt | loop | try.</summary>
public sealed record FragmentScope(string Id, string Kind, int Operand, string? Guard, string? NegatedGuard, SourceRange? Range, IReadOnlyList<CatchHandler>? Handlers = null, bool? LeavesLoop = null);

/// <summary>FR-8.6 a DI registration: abstraction → implementation (class keys), keyed / lifetime / TryAdd (fallback) when known.
/// <c>KeyKind</c>: "key" (keyed / named service) or "condition" (registered under a run-time condition); <c>Hosts</c>: the executable projects that run the registration.</summary>
public sealed record ContainerBinding(string Abstract, string Concrete, string? Consumer, SourceRange Range, string? Key = null, string? Lifetime = null, bool? Fallback = null, string? KeyKind = null, IReadOnlyList<string>? Hosts = null, IReadOnlyList<string>? AbstractArgs = null);

/// <summary>FR-1.17 a catch clause and what it does with the error: rethrow | return | skip | swallow.</summary>
public sealed record CatchHandler(int Operand, string Guard, string Outcome, string? Value, bool Logged, SourceRange? Range);

/// <summary><c>Passed</c> (FR-4.5): the method is passed as a method group to the call at <c>Range</c>.</summary>
public sealed record CallerInfo(string Id, MethodRef Enclosing, SourceRange Range, string Preview, bool? Passed = null);

public sealed record FieldInfo(string Name, ClassRef? Type, bool IsStatic, bool Injected, SourceRange? Declaration = null, bool? Collection = null);

public sealed record ConstructorParam(string Name, ClassRef? Type);

/// <param name="Visibility">FR-12.18 "private" / "protected" (null: public or internal — visible to the project).</param>
public sealed record MemberInfo(string Name, bool IsStatic, string Signature, string? Visibility = null);

public sealed record ClassInfo
{
    public required ClassRef Ref { get; init; }
    public string? File { get; init; }
    public required IReadOnlyList<string> Decorators { get; init; }
    public ClassRef? Extends { get; init; }
    public required IReadOnlyList<ClassRef> Implements { get; init; }
    public required IReadOnlyList<FieldInfo> Fields { get; init; }
    public required IReadOnlyList<ConstructorParam> ConstructorParams { get; init; }
    public required bool HasPrivateConstructor { get; init; }
    public required bool HasStaticInstance { get; init; }
    public required bool AllMembersStatic { get; init; }
    public required bool IsExportedInstance { get; init; }
    public required IReadOnlyList<MemberInfo> Methods { get; init; }
    /// <summary>Simple names of the nested types (recursively); null when there are none.</summary>
    public IReadOnlyList<string>? NestedTypes { get; init; }
    /// <summary>FR-5.12 its objects cannot change once built (a value): true, else null.</summary>
    public bool? Immutable { get; init; }
    /// <summary>FR-7.15 its own code only holds data (fields, auto-properties, plain getters / setters, a constructor that only stores values): true, else null.</summary>
    public bool? DataOnly { get; init; }
}

/// <summary>FR-12.12: a source type referenced by a method, at its first reference.</summary>
public sealed record TypeUse(ClassRef Type, SourceRange Range);

public sealed record InitializeResult(IReadOnlyList<string> Projects, int Documents, long LoadMs);

/// <summary>FR-34.1 this process's memory: working set and .NET managed heap, in bytes.</summary>
public sealed record MemoryResult(int Pid, long WorkingSet, long ManagedHeap);

// ── request params ──

public sealed record InitializeParams(string? ProjectRoot, string? Solution);

public sealed record FileParams(string File, Position Position);

public sealed record KeyParams(string Key);

/// <summary>Only the key of an incoming MethodRef is used.</summary>
public sealed record MethodInput(string Key, string? Name);

public sealed record MethodParams(MethodInput Method);

public sealed record ClassKeyParams(string ClassKey);

public sealed record UpdateFileParams(string File, string? Content);

public sealed record FilePathParams(string File);

/// <summary>FR-31.1: a type declared in a file, with its methods declared there.</summary>
public sealed record FileType(ClassRef Type, IReadOnlyList<MethodRef> Methods);

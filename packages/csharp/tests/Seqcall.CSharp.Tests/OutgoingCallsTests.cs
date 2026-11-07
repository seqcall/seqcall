using Seqcall.CSharp.Protocol;

namespace Seqcall.CSharp.Tests;

[Collection(SampleCollection.Name)]
public sealed class OutgoingCallsTests(SampleFixture f)
{
    private const string UserService = "src/Sample.Core/Services/UserService.cs";
    private const string UserServiceKey = UserService + "#UserService";

    private static string[] Names(IEnumerable<CallSite> calls) => calls.Select(c => c.MethodName).ToArray();

    [Fact]
    public void Initialize_reports_projects_and_documents()
    {
        Assert.Equal(["Sample.Batch", "Sample.Core", "Sample.Infrastructure", "Sample.Web"], f.Init.Projects);
        Assert.True(f.Init.Documents >= 20);
        Assert.True(f.Init.LoadMs > 0);
    }

    [Fact]
    public async Task FR_17_7_a_post_to_a_dataflow_block_is_followed_into_the_lambda_the_block_runs_later()
    {
        var calls = await f.Calls(await f.MethodAt("src/Sample.Core/Services/AuditQueue.cs", "return _saves.Post(user);"));
        Assert.Equal(["Title", "Post", "SaveAsync", "Title"], Names(calls));
        Assert.Null(calls[1].Fragments);
        Assert.All(calls.Skip(2), c => Assert.Equal("callback[later: _saves]", string.Join(" / ", c.Fragments!.Select(s => $"{s.Kind}[{s.Guard}]"))));
        Assert.Equal("src/Sample.Core/Interfaces/IUserRepository.cs#IUserRepository.SaveAsync(User, CancellationToken)", calls[2].Target!.Key);
        // the constructor that builds the block draws the lambda as a callback of the creation, as before
        var ctor = await f.Calls(await f.MethodAt("src/Sample.Core/Services/AuditQueue.cs", "_saves = new ActionBlock"));
        Assert.Equal(["constructor", "constructor", "SaveAsync", "Title", "constructor"], Names(ctor));
        // a method group given to the block: a call of that method, in the same frame
        var audit = await f.Calls(await f.MethodAt("src/Sample.Core/Services/AuditQueue.cs", "=> _audits.SendAsync(user);"));
        Assert.Equal(["SendAsync", "WriteAuditAsync"], Names(audit));
        Assert.Equal("callback[later: _audits]", string.Join(" / ", audit[1].Fragments!.Select(s => $"{s.Kind}[{s.Guard}]")));
        Assert.Equal("src/Sample.Core/Services/AuditQueue.cs#AuditQueue.WriteAuditAsync(User)", audit[1].Target!.Key);
        Assert.Equal("self", audit[1].Receiver.Kind);
        Assert.True(audit[1].IsAsync);
    }

    [Fact]
    public async Task Evaluation_order_puts_nested_calls_before_the_creation()
    {
        var m = await f.MethodAt(UserService, "new UserDto(");
        Assert.Equal($"{UserServiceKey}.GetUserDtoAsync(string)", m.Key);
        var calls = await f.Calls(m);
        Assert.Equal(["FindUserAsync", "Title", "Slugify", "constructor"], Names(calls));
        Assert.Equal([0, 1, 2, 3], calls.Select(c => c.Ordinal));

        var find = calls[0];
        Assert.Equal("call", find.Kind);
        Assert.Equal("self", find.Receiver.Kind);
        Assert.True(find.IsAsync);
        Assert.Equal($"{UserServiceKey}.FindUserAsync(string)", find.Target!.Key);
        Assert.Equal([new ArgumentOrigin("parameter", "id")], find.ArgOrigins!);

        var title = calls[1];
        Assert.Equal("static", title.Receiver.Kind);
        Assert.Equal("src/Sample.Core/Util/Format.cs#Format", title.ReceiverType!.Key);
        Assert.True(title.Target!.IsStatic);

        var slug = calls[2];
        Assert.Equal("static", slug.Receiver.Kind); // extension method → static on the extension class
        Assert.Equal("src/Sample.Core/Util/StringExtensions.cs#StringExtensions", slug.ReceiverType!.Key);
        Assert.Equal("src/Sample.Core/Util/StringExtensions.cs#StringExtensions.Slugify(string)", slug.Target!.Key);

        var create = calls[3];
        Assert.Equal("create", create.Kind);
        Assert.Equal("none", create.Receiver.Kind);
        Assert.Equal("src/Sample.Core/Domain/UserDto.cs#UserDto", create.ReceiverType!.Key);
        Assert.Equal("src/Sample.Core/Domain/UserDto.cs#UserDto..ctor(string, string, string)", create.Target!.Key);
        Assert.Equal("constructor", create.Target.Name);
        Assert.Equal(new AssignmentTarget("local", "dto"), create.AssignedTo);
        Assert.Equal(["user.Id", "Format.Title(user.Name)", "user.Name.Slugify()"], create.Args);
        Assert.Equal("new UserDto(user.Id, Format.Title(user.Name), user.Name.Slugify())", create.ExpressionText);
    }

    [Fact]
    public async Task FR_9_4_results_record_where_a_value_goes_and_FR_9_5_the_awaited_return_type()
    {
        var dto = await f.Calls(await f.MethodAt(UserService, "new UserDto("));
        Assert.Equal(new CallResult("assign", "user", "="), dto[0].Result); // var user = await FindUserAsync(id)
        Assert.Equal("User", dto[0].ReturnType); // Task<User> awaited
        Assert.Null(dto[1].Result); // Format.Title(...) is an argument
        Assert.Equal("string", dto[1].ReturnType);
        Assert.Equal(new CallResult("assign", "dto", "="), dto[3].Result); // var dto = new UserDto(...)
        Assert.Null(dto[3].ReturnType);

        var rename = await f.Calls(await f.MethodAt(UserService, "user.Rename(name)"));
        var blocked = rename.Single(c => c.MethodName == "_isBlocked");
        Assert.Null(blocked.Result); // a condition
        Assert.Equal("bool", blocked.ReturnType);
        var save = rename.Single(c => c.MethodName == "SaveAsync");
        Assert.Null(save.Result);
        Assert.Null(save.ReturnType); // awaited Task: no value

        var active = await f.Calls(await f.MethodAt(UserService, ".ToList()"));
        Assert.Equal(new CallResult("return"), active.Single(c => c.MethodName == "ToList").Result);
        Assert.Null(active.Single(c => c.MethodName == "All").Result); // receiver of the chain
    }

    [Fact]
    public async Task FR_1_15_early_exits_are_returns_and_throws_that_are_not_in_tail_position()
    {
        // FindUserAsync: `if (cached is not null) { return cached; }` is early; the final `return user ?? throw …` is the tail
        var find = await f.Adapter.GetEarlyExitsAsync((await f.MethodAt(UserService, "var cached")).Key);
        var cached = Assert.Single(find);
        Assert.Equal("return", cached.Kind);
        Assert.Equal(25, cached.Range.Start.Line); // 0-based: line 26
        Assert.Equal("opt", Assert.Single(cached.Fragments!).Kind);
        Assert.Equal("cached is not null", cached.Fragments![0].Guard);
        Assert.Equal("cached", cached.Value); // FR-3.9 what it returns

        // RenameAsync: `if (_isBlocked(id)) { return; }` before the rename
        var rename = Assert.Single(await f.Adapter.GetEarlyExitsAsync((await f.MethodAt(UserService, "user.Rename(name)")).Key));
        Assert.Equal("_isBlocked(id)", rename.Fragments![0].Guard);
        Assert.Equal("", rename.Value); // FR-3.9 a bare return

        // GetUserDtoAsync ends with `return dto;` only: nothing early
        Assert.Empty(await f.Adapter.GetEarlyExitsAsync((await f.MethodAt(UserService, "new UserDto(")).Key));
    }

    [Fact]
    public async Task FR_5_8_returns_list_every_return_with_tuple_elements_locals_and_nulls()
    {
        const string ordering = "src/Sample.Core/Services/OrderingService.cs";
        var create = await f.Adapter.GetReturnsAsync((await f.MethodAt(ordering, "return (null, false)")).Key);
        Assert.Equal(2, create.Count);
        Assert.All(create, r => Assert.True(r.Tuple));
        Assert.Equal([true, null], create[0].Values.Select(v => v.Empty));
        Assert.Equal(["order", null], create[1].Values.Select(v => v.Variable));
        Assert.Null(create[1].Values[1].Empty); // `true` is an expression, not "no object"

        // an expression body is one return; a parameter is no local variable
        var total = Assert.Single(await f.Adapter.GetReturnsAsync((await f.MethodAt(ordering, "order.WithVat()")).Key));
        Assert.Null(total.Tuple);
        Assert.Null(Assert.Single(total.Values).Variable);
    }

    [Fact]
    public async Task FR_5_9_generic_calls_report_type_arguments_and_a_type_parameter_creation_its_constraint()
    {
        const string ordering = "src/Sample.Core/Services/OrderingService.cs";
        const string envelopes = "src/Sample.Core/Util/Envelopes.cs";
        var wrap = Assert.Single(await f.Calls(await f.MethodAt(ordering, "order.Wrap<Order, OrderEnvelope>()")), c => c.MethodName == "Wrap");
        Assert.Equal(["TData=Order", "TEnvelope=OrderEnvelope"], wrap.TypeArguments!.Select(a => $"{a.Name}={a.Type?.Name}"));

        var create = Assert.Single(await f.Calls(await f.MethodAt(envelopes, "return new TEnvelope")), c => c.Kind == "create");
        Assert.Equal("TEnvelope", create.TypeParameter);
        Assert.Equal($"{envelopes}#Envelope`1", create.ReceiverType!.Key); // where TEnvelope : Envelope<TData>
        Assert.Null(create.Target);

        // WrapVia passes its own type parameters on
        var via = Assert.Single(await f.Calls(await f.MethodAt(envelopes, "data.Wrap<TData, TEnvelope>()")), c => c.MethodName == "Wrap");
        Assert.Equal(["TData<-TData", "TEnvelope<-TEnvelope"], via.TypeArguments!.Select(a => $"{a.Name}<-{a.Parameter}"));
    }

    [Fact]
    public async Task FR_16_1_entry_points_cover_routes_minimal_apis_the_program_and_hosted_jobs()
    {
        var eps = await f.Adapter.GetEntryPointsAsync();
        string[] Labels(string kind) => eps.Where(e => e.Kind == kind).Select(e => e.Label).ToArray();
        Assert.Contains("GET /api/users/{id}", Labels("http"));
        Assert.Contains("POST /api/users/{id}/charge", Labels("http"));
        var get = eps.Single(e => e.Label == "GET /api/users/{id}");
        Assert.Equal("GET", get.Verb);
        Assert.Equal("src/Sample.Web/Controllers/UsersController.cs#UsersController.Get(string)", get.Method.Key);
        // minimal APIs: a method group is the handler; an inline lambda falls back to the registering method
        Assert.EndsWith("#HealthEndpoints.Check()", eps.Single(e => e.Label == "GET /health").Method.Key);
        Assert.EndsWith("#HealthEndpoints.Map(WebApplication)", eps.Single(e => e.Label == "POST /ping").Method.Key);
        Assert.Equal(["Sample.Batch/Program.cs (top-level statements)", "Sample.Web/Program.cs (top-level statements)"], Labels("cli"));
        var job = eps.Single(e => e.Kind == "job");
        Assert.Equal(("CleanupWorker.ExecuteAsync", "BackgroundService"), (job.Label, job.Detail));
        // HTTP first, ordered by label
        Assert.Equal(eps.Where(e => e.Kind == "http").Select(e => e.Label).Order(StringComparer.OrdinalIgnoreCase), Labels("http"));
    }

    [Fact]
    public async Task FR_16_13_api_versions_are_resolved_from_MapToApiVersion_else_the_controllers_ApiVersion()
    {
        var eps = await f.Adapter.GetEntryPointsAsync();
        string LabelOf(string method) => eps.Single(e => e.Method.Key.EndsWith($"#ProvidersController.{method}")).Label;
        Assert.Equal("GET /v1.3|1.4/Providers", LabelOf("List()")); // [MapToApiVersion(1.4)] [MapToApiVersion("1.3")], ordered
        Assert.Equal("GET /v1.6/Providers", LabelOf("ListV16()")); // no longer the same label as List
        Assert.Equal("GET /v1.3|1.4|1.6/Providers/{providerId:long}/vendors", LabelOf("Vendors(long)")); // the controller's
        Assert.Equal("GET /v1.7-beta|2025-01-15/Providers/beta", LabelOf("Beta()")); // status, date version
    }

    [Fact]
    public async Task FR_7_6_module_facts_report_ports_libraries_and_project_dependencies_of_the_whole_type()
    {
        var service = (await f.Adapter.GetModuleFactsAsync(UserServiceKey))!;
        Assert.Equal(["IUserRepository"], service.Ports); // fields + constructor parameters, once
        Assert.Contains(service.DependsOn, d => d.Name == "User");
        Assert.Contains(service.DependsOn, d => d.Name == "IUserRepository");

        var client = (await f.Adapter.GetModuleFactsAsync("src/Sample.Infrastructure/Clients/PaymentApiClient.cs#PaymentApiClient"))!;
        Assert.Contains("System.Net.Http.HttpClient", client.Libraries);

        var user = (await f.Adapter.GetModuleFactsAsync("src/Sample.Core/Domain/User.cs#User"))!;
        Assert.Empty(user.Ports);
        Assert.Null(await f.Adapter.GetModuleFactsAsync("src/Nope.cs#Nope"));
    }

    [Fact]
    public async Task Named_fields_of_the_same_interface_type_are_distinguished()
    {
        var calls = await f.Calls(await f.Method($"{UserServiceKey}.FindUserAsync(string)"));
        Assert.Equal(["FindByIdAsync", "FindByIdAsync", "constructor"], Names(calls));
        Assert.Equal(ReceiverOrigin.Field("_replica"), calls[0].Receiver);
        Assert.Equal(ReceiverOrigin.Field("_primary"), calls[1].Receiver);
        Assert.Equal("src/Sample.Core/Interfaces/IUserRepository.cs#IUserRepository", calls[0].ReceiverType!.Key);
        Assert.Equal("interface", calls[0].ReceiverType!.Kind);
        Assert.False(calls[0].Target!.HasBody);
        Assert.Equal("src/Sample.Core/Interfaces/IUserRepository.cs#IUserRepository.FindByIdAsync(string, CancellationToken)", calls[0].Target!.Key);
        Assert.All(calls.Take(2), c => Assert.True(c.IsAsync));

        var ex = calls[2]; // throw new InvalidOperationException(...)
        Assert.Equal("create", ex.Kind);
        Assert.True(ex.IsLibrary);
        Assert.StartsWith("lib:System.", ex.Target!.Key);
        Assert.EndsWith("#System.InvalidOperationException..ctor(string)", ex.Target.Key);
        Assert.Equal("external", ex.ReceiverType!.Kind);
        Assert.Equal(ex.Target.Owner.Key.Split('#')[0]["lib:".Length..], ex.LibraryName);
    }

    [Fact]
    public async Task Delegate_field_invocation_this_call_and_local_receiver()
    {
        var calls = await f.Calls(await f.Method($"{UserServiceKey}.RenameAsync(string, string)"));
        Assert.Equal(["_isBlocked", "FindUserAsync", "Rename", "SaveAsync"], Names(calls));
        Assert.Equal("self", calls[0].Receiver.Kind);
        Assert.Equal($"{UserServiceKey}._isBlocked", calls[0].Target!.Key);
        Assert.False(calls[0].Target!.HasBody);
        Assert.Equal("self", calls[1].Receiver.Kind); // this.FindUserAsync
        Assert.Equal(ReceiverOrigin.Local("user"), calls[2].Receiver);
        Assert.Equal("src/Sample.Core/Domain/User.cs#User", calls[2].ReceiverType!.Key);
        Assert.False(calls[2].IsAsync);
        Assert.Equal([new ArgumentOrigin("local", "user")], calls[3].ArgOrigins!);
    }

    [Fact]
    public async Task Linq_is_library_and_its_lambdas_follow_the_call_in_a_loop_scope()
    {
        var calls = await f.Calls(await f.Method($"{UserServiceKey}.ActiveNames()"));
        // FR-1.11: the calls inside the Where / Select lambdas follow their LINQ call
        Assert.Equal(["All", "Where", "IsVisible", "Select", "Title", "ToList"], Names(calls));
        Assert.False(calls[0].IsLibrary);
        Assert.Equal([new FragmentScope(calls[2].Fragments![0].Id, "loop", 0, "each u in _primary.All()", null, calls[2].Fragments![0].Range)], calls[2].Fragments!);
        Assert.Equal("each u in _primary.All().Where(…)", calls[4].Fragments![0].Guard);
        Assert.False(calls[4].IsLibrary);
        foreach (var linq in new[] { calls[1], calls[3], calls[5] })
        {
            Assert.True(linq.IsLibrary);
            Assert.Equal("System.Linq", linq.LibraryName);
            Assert.Equal("static", linq.Receiver.Kind);
            Assert.Equal("lib:System.Linq#System.Linq.Enumerable", linq.ReceiverType!.Key);
        }
        Assert.Equal("lib:System.Linq#System.Linq.Enumerable.Where`1(IEnumerable<TSource>, Func<TSource, bool>)", calls[1].Target!.Key);
        // line breaks of the fluent chain are not kept
        Assert.Equal("_primary.All().Where(u => u.Active && IsVisible(u))", calls[1].ExpressionText);
        Assert.Equal(["u => u.Active && IsVisible(u)"], calls[1].Args);
    }

    [Fact]
    public async Task Constructor_with_lambda_assignment_has_no_calls()
    {
        var ctor = await f.Method($"{UserServiceKey}..ctor(IUserRepository, IUserRepository)");
        Assert.Equal("constructor", ctor.Name);
        Assert.Empty(await f.Calls(ctor));
    }

    [Fact]
    public async Task Recursion_targets_the_method_itself()
    {
        var m = await f.Method($"{UserServiceKey}.ManagementChainAsync(string)");
        var calls = await f.Calls(m);
        Assert.Equal(["FindUserAsync", "ManagementChainAsync"], Names(calls));
        Assert.Equal(m.Key, calls[1].Target!.Key);
    }

    [Fact]
    public async Task Conditional_access_and_local_functions()
    {
        var m = await f.Method($"{UserServiceKey}.FirstReplicaName(IUserRepository)");
        var calls = await f.Calls(m);
        Assert.Equal(["All", "FirstOrDefault", "All", "Describe"], Names(calls));
        Assert.Equal(ReceiverOrigin.Parameter("fallback"), calls[0].Receiver);
        Assert.Equal("fallback?.All()", calls[0].ExpressionText);
        Assert.Equal(ReceiverOrigin.Field("_replica"), calls[2].Receiver);
        var local = calls[3];
        Assert.Equal("self", local.Receiver.Kind);
        Assert.Equal($"{m.Key}.Describe(int)", local.Target!.Key);
        Assert.True(local.Target.HasBody);

        // the local function body is analysed on its own
        Assert.Equal(["ToString", "Title"], Names(await f.Calls(local.Target)));
        var enclosing = await f.MethodAt(UserService, "Format.Title(count.ToString())");
        Assert.Equal(local.Target.Key, enclosing.Key);
    }

    [Fact]
    public async Task Cursor_inside_a_lambda_belongs_to_the_enclosing_method()
    {
        var m = await f.MethodAt(UserService, "u.Active && IsVisible(u)");
        Assert.Equal($"{UserServiceKey}.ActiveNames()", m.Key);
    }

    [Fact]
    public async Task Primary_constructor_parameters_are_field_receivers()
    {
        var m = await f.MethodAt("src/Sample.Core/Services/BillingService.cs", "payments.ChargeAsync");
        var calls = await f.Calls(m);
        Assert.Equal(["FindUserAsync", "NewGuid", "ToString", "constructor", "ChargeAsync"], Names(calls));
        Assert.Equal(ReceiverOrigin.Field("users"), calls[0].Receiver);
        Assert.Equal("src/Sample.Core/Services/UserService.cs#UserService", calls[0].ReceiverType!.Key);
        Assert.Equal("static", calls[1].Receiver.Kind);
        Assert.True(calls[1].IsLibrary);
        Assert.Equal("expression", calls[2].Receiver.Kind);
        Assert.Equal("Guid.NewGuid()", calls[2].Receiver.Text);
        Assert.Equal([null, null, new ArgumentOrigin("parameter", "amount")], calls[3].ArgOrigins!);
        Assert.Equal(ReceiverOrigin.Field("payments"), calls[4].Receiver);
        Assert.Equal([new ArgumentOrigin("local", "order")], calls[4].ArgOrigins!);
        Assert.Equal("src/Sample.Core/Interfaces/IPaymentClient.cs#IPaymentClient", calls[4].ReceiverType!.Key);
    }

    [Fact]
    public async Task Overloads_resolve_to_distinct_keys()
    {
        var one = await f.Method("src/Sample.Core/Services/BillingService.cs#BillingService.Describe(decimal)");
        var two = await f.Method("src/Sample.Core/Services/BillingService.cs#BillingService.Describe(decimal, string)");
        Assert.NotEqual(one.Declaration!.Start, two.Declaration!.Start);
        Assert.Equal("src/Sample.Core/Util/Format.cs#Format.Money(decimal)", (await f.Calls(one)).Single().Target!.Key);
        var withComment = (await f.Calls(two)).Single();
        Assert.Equal("src/Sample.Core/Util/Format.cs#Format.Money(decimal, string)", withComment.Target!.Key);
        Assert.Equal(["amount", "currency"], withComment.Args); // comments stripped
        Assert.Equal("Format.Money(amount, currency)", withComment.ExpressionText);
        // a static method calling its own overload is a self call
        var money2 = await f.Method("src/Sample.Core/Util/Format.cs#Format.Money(decimal, string)");
        var inner = (await f.Calls(money2)).Single();
        Assert.Equal("self", inner.Receiver.Kind);
        Assert.Equal("src/Sample.Core/Util/Format.cs#Format.Money(decimal)", inner.Target!.Key);
    }

    [Fact]
    public async Task Base_calls_are_super_and_abstract_self_calls_have_no_body()
    {
        var square = await f.Method("src/Sample.Core/Domain/Shape.cs#Square.Describe()");
        var call = (await f.Calls(square)).Single();
        Assert.Equal("super", call.Receiver.Kind);
        Assert.Equal("src/Sample.Core/Domain/Shape.cs#Shape.Describe()", call.Target!.Key);
        Assert.Equal("src/Sample.Core/Domain/Shape.cs#Square", call.ReceiverType!.Key);

        var shape = await f.Method("src/Sample.Core/Domain/Shape.cs#Shape.Describe()");
        var calls = await f.Calls(shape);
        Assert.Equal(["GetType", "Area"], Names(calls));
        Assert.True(calls[0].IsLibrary);
        Assert.Equal("self", calls[1].Receiver.Kind);
        Assert.False(calls[1].Target!.HasBody);
        Assert.Equal("abstract", calls[1].Target!.Owner.Kind);
    }

    [Fact]
    public async Task Controller_actions_inherited_library_calls_and_task_returning_calls()
    {
        var get = await f.MethodAt("src/Sample.Web/Controllers/UsersController.cs", "return Ok(dto)");
        var calls = await f.Calls(get);
        Assert.Equal(["GetUserDtoAsync", "Ok"], Names(calls));
        Assert.Equal(ReceiverOrigin.Field("_users"), calls[0].Receiver);
        Assert.True(calls[1].IsLibrary);
        Assert.Equal("Microsoft.AspNetCore.Mvc.Core", calls[1].LibraryName);
        Assert.Equal("self", calls[1].Receiver.Kind);

        var charge = await f.MethodAt("src/Sample.Web/Controllers/UsersController.cs", "_billing.ChargeAsync");
        var c = (await f.Calls(charge)).Single();
        Assert.True(c.IsAsync); // not awaited, but returns Task
        Assert.Equal([new ArgumentOrigin("parameter", "id"), new ArgumentOrigin("parameter", "amount")], c.ArgOrigins!);
    }

    [Fact]
    public async Task Collection_expressions_creations_and_callbacks()
    {
        var m = await f.MethodAt("src/Sample.Web/Controllers/ReportsController.cs", "shapes.Select");
        var calls = await f.Calls(m);
        Assert.Equal(["constructor", "constructor", "Select", "Describe"], Names(calls));
        Assert.Equal("src/Sample.Core/Domain/Shape.cs#Circle..ctor(double)", calls[0].Target!.Key);
        Assert.Equal("src/Sample.Core/Domain/Shape.cs#Square..ctor(double)", calls[1].Target!.Key);
        Assert.Equal("static", calls[2].Receiver.Kind); // Enumerable.Select extension
        Assert.Equal(("loop", "each s in shapes"), (calls[3].Fragments![0].Kind, calls[3].Fragments![0].Guard)); // FR-1.11
    }

    [Fact]
    public async Task Target_typed_new_in_field_initializers_belongs_to_the_constructor()
    {
        var ctor = await f.Method("src/Sample.Infrastructure/Legacy/ConfigRegistry.cs#ConfigRegistry..ctor()");
        var calls = await f.Calls(ctor);
        var create = Assert.Single(calls);
        Assert.Equal("create", create.Kind);
        Assert.Equal("new()", create.ExpressionText);
        Assert.Equal(new AssignmentTarget("field", "_values"), create.AssignedTo);
        Assert.True(create.IsLibrary);
        Assert.StartsWith("lib:System.Collections#System.Collections.Generic.Dictionary`2", create.ReceiverType!.Key);
        Assert.Equal("Dictionary<TKey, TValue>", create.ReceiverType.Name);

        // implicit constructor: field initializers only
        var repoCtor = await f.Method("src/Sample.Infrastructure/Repositories/SqlUserRepository.cs#SqlUserRepository..ctor()");
        Assert.True(repoCtor.HasBody);
        var init = Assert.Single(await f.Calls(repoCtor));
        Assert.Equal("Get", init.MethodName);
        Assert.Equal(ReceiverOrigin.Expression("ConfigRegistry.Instance"), init.Receiver);
        Assert.Equal("src/Sample.Infrastructure/Legacy/ConfigRegistry.cs#ConfigRegistry", init.ReceiverType!.Key);
    }

    [Fact]
    public async Task Top_level_statements_are_a_callable()
    {
        var main = await f.MethodAt("src/Sample.Web/Program.cs", "app.MapControllers");
        Assert.Equal("Main", main.Name);
        Assert.Equal("src/Sample.Web/Program.cs#Program", main.Owner.Key);
        var calls = await f.Calls(main);
        Assert.Equal("CreateBuilder", calls[0].MethodName);
        Assert.Equal("static", calls[0].Receiver.Kind);
        Assert.Equal("Run", calls[^1].MethodName);
        Assert.Equal(ReceiverOrigin.Local("app"), calls[^1].Receiver);
        // only the factory lambda of a registration creates a project object (FR-8.6 sample)
        Assert.All(calls.Where(c => c.Kind != "create"), c => Assert.True(c.IsLibrary));
        Assert.Equal(["InMemoryStore<T>"], calls.Where(c => !c.IsLibrary).Select(c => c.ReceiverType?.Name));
    }

    [Fact]
    public async Task Static_class_calls_from_infrastructure()
    {
        var m = await f.MethodAt("src/Sample.Infrastructure/Clients/PaymentApiClient.cs", "PostAsJsonAsync");
        var calls = await f.Calls(m);
        Assert.Equal(["Info", "PostAsJsonAsync"], Names(calls));
        Assert.Equal("static", calls[0].Receiver.Kind);
        Assert.Equal("src/Sample.Infrastructure/Logging/Logger.cs#Logger", calls[0].ReceiverType!.Key);
        Assert.False(calls[0].IsLibrary);
        Assert.True(calls[1].IsLibrary);
        Assert.True(calls[1].IsAsync);
    }
}

using Seqcall.CSharp.Protocol;

namespace Seqcall.CSharp.Tests;

[Collection(SampleCollection.Name)]
public sealed class ClassInfoTests(SampleFixture f)
{
    private async Task<ClassInfo> Info(string key)
    {
        var info = await f.Adapter.GetClassInfoAsync(key);
        Assert.True(info is not null, $"class not resolved: {key}");
        return info!;
    }

    private static FieldInfo Field(ClassInfo info, string name) => Assert.Single(info.Fields, x => x.Name == name);

    [Theory]
    [InlineData("Outcome", true)]
    [InlineData("Outcome`1", true)]
    [InlineData("Price", true)]
    [InlineData("Order", true)]
    [InlineData("Draft", null)]
    [InlineData("Basket", null)]
    [InlineData("Ticket", null)]
    public async Task FR_5_12_values_cannot_change_once_built(string type, bool? immutable)
    {
        var file = type == "Order" ? "Order.cs" : "Outcome.cs";
        Assert.Equal(immutable, (await Info($"src/Sample.Core/Domain/{file}#{type}")).Immutable);
    }

    [Theory]
    [InlineData("Domain/UserDto.cs#UserDto", true)] // positional record
    [InlineData("Domain/Outcome.cs#Draft", true)] // auto-property, a getter without logic
    [InlineData("Domain/Outcome.cs#Basket", true)] // auto-property with an empty list
    [InlineData("Util/Limits.cs#Limits", true)] // constants
    [InlineData("Util/Enums.cs#Enums", null)] // an extension method
    [InlineData("Domain/User.cs#User", null)] // Rename trims
    [InlineData("Domain/Outcome.cs#Outcome", null)] // a computed property, factories
    [InlineData("Domain/Outcome.cs#Price", null)] // Add builds a new price
    [InlineData("Domain/Outcome.cs#Ticket", null)] // Dispose
    [InlineData("Domain/Shape.cs#Circle", null)]
    [InlineData("Interfaces/IUserRepository.cs#IUserRepository", null)] // methods
    public async Task FR_7_15_types_that_only_hold_data(string key, bool? dataOnly)
    {
        Assert.Equal(dataOnly, (await Info($"src/Sample.Core/{key}")).DataOnly);
    }

    [Fact]
    public async Task Controller_attributes_base_class_and_injected_fields()
    {
        var info = await Info("src/Sample.Web/Controllers/UsersController.cs#UsersController");
        Assert.Equal(["ApiController", "Route"], info.Decorators);
        Assert.Equal("lib:Microsoft.AspNetCore.Mvc.Core#Microsoft.AspNetCore.Mvc.ControllerBase", info.Extends!.Key);
        Assert.True(Field(info, "_users").Injected);
        Assert.True(Field(info, "_billing").Injected);
        Assert.Equal("src/Sample.Core/Services/UserService.cs#UserService", Field(info, "_users").Type!.Key);
        Assert.Equal(["users", "billing"], info.ConstructorParams.Select(p => p.Name));
        Assert.Equal(TestPaths.File("src/Sample.Web/Controllers/UsersController.cs"), info.File);
        Assert.Contains(info.Methods, m => m.Signature == "Get(string id): Task<ActionResult<UserDto>>");
        Assert.Contains(info.Methods, m => m.Signature == "constructor(UserService users, BillingService billing)");
    }

    [Fact]
    public async Task Primary_constructor_parameters_are_injected_fields()
    {
        var info = await Info("src/Sample.Core/Services/BillingService.cs#BillingService");
        var payments = Field(info, "payments");
        Assert.True(payments.Injected);
        Assert.Equal("interface", payments.Type!.Kind);
        Assert.True(Field(info, "users").Injected);
        Assert.Equal(["payments", "users"], info.ConstructorParams.Select(p => p.Name));
        Assert.Equal(["constructor", "ChargeAsync", "Quote", "Describe", "Describe"], info.Methods.Select(m => m.Name));
        Assert.Equal("constructor(IPaymentClient payments, UserService users)", info.Methods[0].Signature);
    }

    [Fact]
    public async Task Assigned_fields_and_non_injected_fields()
    {
        var info = await Info("src/Sample.Core/Services/UserService.cs#UserService");
        Assert.True(Field(info, "_primary").Injected);
        Assert.True(Field(info, "_replica").Injected);
        Assert.False(Field(info, "_isBlocked").Injected);
        Assert.Contains(info.Methods, m => m.Signature == "FindUserAsync(string id): Task<User>");
        Assert.Contains(info.Methods, m => m.Signature == "FirstReplicaName(IUserRepository? fallback): string?");
        Assert.Contains(info.Methods, m => m is { Name: "IsVisible", IsStatic: true });

        var client = await Info("src/Sample.Infrastructure/Clients/PaymentApiClient.cs#PaymentApiClient");
        Assert.True(Field(client, "_http").Injected); // _http = http ?? throw ...
        Assert.Equal(["src/Sample.Core/Interfaces/IPaymentClient.cs#IPaymentClient"], client.Implements.Select(i => i.Key));
    }

    [Fact]
    public async Task Singleton_and_static_detection()
    {
        var registry = await Info("src/Sample.Infrastructure/Legacy/ConfigRegistry.cs#ConfigRegistry");
        Assert.True(registry.HasPrivateConstructor);
        Assert.True(registry.HasStaticInstance);
        Assert.False(registry.AllMembersStatic);

        var logger = await Info("src/Sample.Infrastructure/Logging/Logger.cs#Logger");
        Assert.True(logger.AllMembersStatic);
        Assert.False(logger.HasStaticInstance);
        Assert.Equal([new MemberInfo("Info", true, "Info(string message): void")], logger.Methods);

        var service = await Info("src/Sample.Core/Services/UserService.cs#UserService");
        Assert.False(service.AllMembersStatic);
        Assert.False(service.HasPrivateConstructor);
    }

    [Fact]
    public async Task Interfaces_abstract_classes_records_and_extension_classes()
    {
        var repo = await Info("src/Sample.Core/Interfaces/IUserRepository.cs#IUserRepository");
        Assert.Equal("interface", repo.Ref.Kind);
        Assert.Equal(["FindByIdAsync", "SaveAsync", "All"], repo.Methods.Select(m => m.Name));

        var shape = await Info("src/Sample.Core/Domain/Shape.cs#Shape");
        Assert.Equal("abstract", shape.Ref.Kind);
        var square = await Info("src/Sample.Core/Domain/Shape.cs#Square");
        Assert.Equal("src/Sample.Core/Domain/Shape.cs#Shape", square.Extends!.Key);
        Assert.Equal("side", Assert.Single(square.Fields).Name);

        var dto = await Info("src/Sample.Core/Domain/UserDto.cs#UserDto");
        Assert.Equal(["Id", "DisplayName", "Slug"], dto.Fields.Select(x => x.Name));
        Assert.Null(dto.Extends);

        var ext = await Info("src/Sample.Core/Util/StringExtensions.cs#StringExtensions");
        Assert.True(ext.AllMembersStatic);
        Assert.Equal("Slugify(this string value): string", Assert.Single(ext.Methods).Signature);
    }

    [Fact]
    public async Task Partial_classes_merge_all_parts_and_use_the_first_file()
    {
        var info = await Info("src/Sample.Core/Services/ReportService.Formatting.cs#ReportService");
        Assert.Equal(TestPaths.File("src/Sample.Core/Services/ReportService.Formatting.cs"), info.File);
        Assert.Equal(["BuildAsync", "Header", "Lines", "constructor"], info.Methods.Select(m => m.Name).Order(StringComparer.Ordinal));
        Assert.True(Field(info, "_orders").Injected);
        Assert.Equal("lib:System.Runtime#System.Object", (await f.Adapter.GetClassInfoAsync("lib:System.Runtime#System.Object"))?.Ref.Key);
        Assert.Null(await f.Adapter.GetClassInfoAsync("src/Sample.Core/Services/ReportService.cs#ReportService"));
    }

    [Fact]
    public async Task FR_12_18_private_and_protected_methods_are_marked()
    {
        var format = await Info("src/Sample.Core/Services/FormatService.cs#FormatService");
        Assert.Equal("private", Assert.Single(format.Methods, m => m.Name == "Render").Visibility);
        Assert.Equal("private", Assert.Single(format.Methods, m => m.Name == "Each").Visibility);
        Assert.Null(Assert.Single(format.Methods, m => m.Name == "FormatAll").Visibility);
        var worker = await Info("src/Sample.Web/Workers/CleanupWorker.cs#CleanupWorker");
        Assert.Equal("protected", Assert.Single(worker.Methods, m => m.Name == "ExecuteAsync").Visibility);
        var registry = await Info("src/Sample.Infrastructure/Legacy/ConfigRegistry.cs#ConfigRegistry");
        Assert.Equal("private", Assert.Single(registry.Methods, m => m.Name == "constructor").Visibility);
    }
}

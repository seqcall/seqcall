using Seqcall.CSharp.Protocol;

namespace Seqcall.CSharp.Tests;

/// <summary>FR-1.21: members of C# 14 extension blocks are calls on the static class, like classic extension methods.</summary>
[Collection(SampleCollection.Name)]
public sealed class ExtensionBlockTests(SampleFixture f)
{
    private const string Export = "src/Sample.Core/Services/ExportService.cs";
    private const string Ext = "src/Sample.Core/Util/UserExtensions.cs";
    private const string ExtKey = Ext + "#UserExtensions";

    [Fact]
    public async Task FR_1_21_calls_go_to_the_static_class_not_to_the_receiver()
    {
        var calls = await f.Calls(await f.MethodAt(Export, "first.ToDto()"));
        Assert.Equal(["FirstOrNone", "Guest", "ToDto"], calls.Select(c => c.MethodName));
        Assert.All(calls, c =>
        {
            Assert.Equal("static", c.Receiver.Kind);
            Assert.Equal(ExtKey, c.ReceiverType!.Key);
            Assert.Equal("UserExtensions", c.Target!.Owner.Name);
            Assert.True(c.Target.HasBody);
        });
        Assert.Equal(
            [$"{ExtKey}.FirstOrNone`1(IReadOnlyList<T>)", $"{ExtKey}.Guest()", $"{ExtKey}.ToDto(User)"],
            calls.Select(c => c.Target!.Key));
    }

    [Fact]
    public async Task FR_1_21_the_receiver_is_the_first_argument()
    {
        var calls = await f.Calls(await f.MethodAt(Export, "first.ToDto()"));
        Assert.Equal(new ArgumentOrigin("parameter", "users"), calls[0].ArgOrigins![0]);
        Assert.Null(calls[1].ArgOrigins); // static member: no receiver
        Assert.Equal(new ArgumentOrigin("local", "first"), calls[2].ArgOrigins![0]);
    }

    [Fact]
    public async Task FR_1_21_the_member_keeps_its_source()
    {
        var toDto = await f.MethodAt(Ext, "Format.Title");
        Assert.Equal($"{ExtKey}.ToDto(User)", toDto.Key);
        Assert.Equal("UserExtensions", toDto.Owner.Name);

        var resolved = await f.Method($"{ExtKey}.ToDto(User)");
        Assert.True(resolved.HasBody);
        Assert.NotNull(resolved.Declaration);
        Assert.Equal(["Title", "Slugify", "constructor"], (await f.Calls(resolved)).Select(c => c.MethodName));

        var callers = await f.Adapter.GetCallersAsync($"{ExtKey}.ToDto(User)");
        Assert.Equal("src/Sample.Core/Services/ExportService.cs#ExportService.Export(IReadOnlyList<User>)", Assert.Single(callers).Enclosing.Key);
    }

    [Fact]
    public async Task FR_1_21_the_class_lists_the_block_members()
    {
        var info = await f.Adapter.GetClassInfoAsync(ExtKey);
        Assert.Equal(["ToDto", "Guest", "FirstOrNone"], info!.Methods.Select(m => m.Name));
        Assert.Equal("ToDto(this User user): UserDto", info.Methods[0].Signature);
        Assert.All(info.Methods, m => Assert.True(m.IsStatic));
        Assert.Null(info.NestedTypes);
    }
}

using Seqcall.CSharp.Workspace;

namespace Seqcall.CSharp.Tests;

/// <summary>The SDK pin read for the "SDK not installed" message (MSBuild registration).</summary>
public sealed class GlobalJsonTests
{
    [Fact]
    public void Nearest_global_json_at_or_above_the_root_gives_version_and_roll_forward()
    {
        var top = Directory.CreateTempSubdirectory("seqcall-gj-").FullName;
        try
        {
            File.WriteAllText(Path.Combine(top, "global.json"), "{ // comment\n \"sdk\": { \"version\": \"8.0.400\", \"rollForward\": \"disable\", }, }");
            var nested = Directory.CreateDirectory(Path.Combine(top, "src", "App")).FullName;
            var pin = MsBuildRegistration.GlobalJsonPin(nested);
            Assert.NotNull(pin);
            Assert.Equal((Path.Combine(top, "global.json"), "8.0.400", "disable"), pin!.Value);
        }
        finally
        {
            Directory.Delete(top, true);
        }
    }

    [Fact]
    public void A_global_json_without_an_sdk_version_pins_nothing()
    {
        var top = Directory.CreateTempSubdirectory("seqcall-gj-").FullName;
        try
        {
            File.WriteAllText(Path.Combine(top, "global.json"), "{ \"msbuild-sdks\": { \"X\": \"1.0\" } }");
            Assert.Null(MsBuildRegistration.GlobalJsonPin(top));
        }
        finally
        {
            Directory.Delete(top, true);
        }
    }
}

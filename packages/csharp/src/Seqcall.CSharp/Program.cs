using System.Runtime.CompilerServices;
using System.Text;
using Seqcall.CSharp.Rpc;
using Seqcall.CSharp.Workspace;

namespace Seqcall.CSharp;

public static class Program
{
    /// <summary>
    /// <c>dotnet Seqcall.CSharp.dll --root &lt;projectRoot&gt; [--solution &lt;path&gt;] [--verbose]</c>.
    /// Main references no MSBuild / workspace types: MSBuildLocator must register first.
    /// </summary>
    public static int Main(string[] args)
    {
        var protocolOut = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = false, NewLine = "\n" };
        // nothing but protocol messages may reach stdout: route stray Console.Out writes to stderr
        Console.SetOut(Console.Error);

        string? root = null;
        string? solution = null;
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--root" when i + 1 < args.Length:
                    root = args[++i];
                    break;
                case "--solution" when i + 1 < args.Length:
                    solution = args[++i];
                    break;
                case "--verbose":
                    Log.Verbose = true;
                    break;
            }
        }
        root ??= Directory.GetCurrentDirectory();
        root = Path.GetFullPath(root);

        try
        {
            MsBuildRegistration.Register(root);
        }
        catch (Exception ex)
        {
            Log.Error($"MSBuild registration failed: {ex.Message}");
        }

        try
        {
            Serve(root, solution, protocolOut).GetAwaiter().GetResult();
            return 0;
        }
        catch (Exception ex)
        {
            Log.Error($"fatal: {ex}");
            return 1;
        }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static async Task Serve(string root, string? solution, StreamWriter output)
    {
        using var adapter = new CSharpAdapter();
        var server = new JsonRpcServer(adapter, root, solution);
        using var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        Log.Info($"Seqcall.CSharp ready (root {root})");
        await server.RunAsync(input, output).ConfigureAwait(false);
        Log.Info("Seqcall.CSharp exiting");
    }
}

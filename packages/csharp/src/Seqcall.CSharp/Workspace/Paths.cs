namespace Seqcall.CSharp.Workspace;

/// <summary>Path conventions: protocol paths are absolute with forward slashes (`c:/repo/...` on Windows).</summary>
public static class Paths
{
    public static readonly StringComparison Comparison =
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    public static readonly StringComparer Comparer =
        OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    /// <summary>OS path → protocol path.</summary>
    public static string ToProtocol(string path)
    {
        var p = path.Replace('\\', '/');
        if (p.Length >= 2 && p[1] == ':' && char.IsLetter(p[0])) p = char.ToLowerInvariant(p[0]) + p[1..];
        return p;
    }

    /// <summary>Protocol (or any) path → normalized absolute OS path.</summary>
    public static string ToOs(string path)
    {
        var p = path;
        if (Path.DirectorySeparatorChar == '\\') p = p.Replace('/', '\\');
        try
        {
            return Path.GetFullPath(p);
        }
        catch
        {
            return p;
        }
    }

    /// <summary>Path relative to the project root with forward slashes.</summary>
    public static string Relative(string root, string path)
    {
        try
        {
            return Path.GetRelativePath(root, path).Replace('\\', '/');
        }
        catch
        {
            return ToProtocol(path);
        }
    }

    public static bool IsUnder(string dir, string path)
    {
        var d = dir.TrimEnd('/', '\\') + Path.DirectorySeparatorChar;
        return path.StartsWith(d, Comparison);
    }
}

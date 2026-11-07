namespace Sample.Core.Util;

public static class StringExtensions
{
    public static string Slugify(this string value) => value.Trim().ToLowerInvariant().Replace(' ', '-');
}

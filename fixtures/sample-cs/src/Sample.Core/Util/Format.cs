namespace Sample.Core.Util;

/// <summary>Static helper with overloads.</summary>
public static class Format
{
    public static string Title(string value) => value.ToUpperInvariant();

    public static string Money(decimal amount) => amount.ToString("0.00");

    public static string Money(decimal amount, string currency) => Money(amount) + " " + currency;
}

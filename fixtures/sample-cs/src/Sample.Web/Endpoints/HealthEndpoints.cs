namespace Sample.Web.Endpoints;

/// <summary>Minimal-API registrations (entry points FR-16): a method group and an inline lambda.</summary>
public static class HealthEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/health", Check);
        app.MapPost("/ping", () => "pong");
    }

    public static string Check() => "ok";
}

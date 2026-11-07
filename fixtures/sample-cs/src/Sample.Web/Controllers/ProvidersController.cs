using Microsoft.AspNetCore.Mvc;

namespace Sample.Web.Controllers;

// Asp.Versioning's attributes, declared here so the sample needs no package (matched by name), with the
// constructors of the real Asp.Versioning 10.0.0: a double comes with an optional status, so [ApiVersion(1.6)]
// has two constructor arguments (1.6, null)
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, AllowMultiple = true)]
public sealed class ApiVersionAttribute : Attribute
{
    public ApiVersionAttribute(string version) { }
    public ApiVersionAttribute(double version, string? status = null) { }
    public ApiVersionAttribute(int year, int month, int day, string? status = null) { }
}

[AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
public sealed class MapToApiVersionAttribute : Attribute
{
    public MapToApiVersionAttribute(string version) { }
    public MapToApiVersionAttribute(double version, string? status = null) { }
    public MapToApiVersionAttribute(int year, int month, int day, string? status = null) { }
}

/// <summary>Versioned routes as in the C# reference solution: <c>v{version:apiVersion}</c> resolved from the attributes.</summary>
[ApiController]
[Route("v{version:apiVersion}/[controller]")]
[ApiVersion(1.6)]
[ApiVersion("1.4")]
[ApiVersion(1.3)]
public class ProvidersController : ControllerBase
{
    [HttpGet]
    [MapToApiVersion(1.4)]
    [MapToApiVersion("1.3")]
    public string List() => "old";

    [HttpGet]
    [MapToApiVersion(1.6)]
    public string ListV16() => "new";

    [HttpGet("beta")]
    [MapToApiVersion(1.7, "beta")]
    [MapToApiVersion(2025, 1, 15)]
    public string Beta() => "beta";

    [HttpGet("{providerId:long}/vendors")]
    public string Vendors(long providerId) => providerId.ToString();
}

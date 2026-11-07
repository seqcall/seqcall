using Microsoft.AspNetCore.Mvc;
using Sample.Core.Domain;
using Sample.Core.Services;

namespace Sample.Web.Controllers;

[ApiController]
[Route("api/reports")]
public class ReportsController(ReportService reports) : ControllerBase
{
    [HttpGet("{userId}")]
    public async Task<string> Get(string userId) => await reports.BuildAsync(userId);

    [HttpGet("shapes")]
    public IEnumerable<string> Shapes()
    {
        Shape[] shapes = [new Circle(1), new Square(2)];
        return shapes.Select(s => s.Describe());
    }
}

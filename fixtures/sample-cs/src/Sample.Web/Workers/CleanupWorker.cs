namespace Sample.Web.Workers;

/// <summary>Hosted job (entry point FR-16).</summary>
public sealed class CleanupWorker : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken) => Task.Delay(1000, stoppingToken);
}

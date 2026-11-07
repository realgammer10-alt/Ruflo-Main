# Monitoring and health checks

The CLI status command provides the live terminal dashboard:

```powershell
ruflo status --watch --interval 5
```

`--interval` must be a whole number between 1 and 300 seconds. Press `Ctrl+C`
to stop the dashboard.

## API endpoint checks

Set `RUFLO_HEALTH_ENDPOINTS` to a JSON array of named HTTP(S) health endpoints.
The targets are checked by `ruflo status`, included in JSON output under
`apiEndpoints`, and included in `ruflo status --health-check` exit status.
Health checks use GET, expect a 2xx response, have a five-second timeout, and
do not follow redirects. Endpoint URLs must not contain credentials or fragments.

```powershell
$env:RUFLO_HEALTH_ENDPOINTS = '[{"name":"gateway","url":"https://api.example.com/health"},{"name":"worker","url":"https://worker.example.com/ready"}]'
ruflo status
ruflo status --health-check
```

At most 20 endpoints can be configured. Names must be unique and contain 1-64
letters, numbers, dots, underscores, or hyphens. Invalid JSON, duplicate names,
unsupported fields, and invalid endpoint URLs are reported as configuration
errors instead of being silently skipped. The JSON configuration is limited to
16 KB and each URL to 2,048 characters.

## Monitoring API

The production monitor can collect counters, gauges, histograms, request
latencies, health-check results, and threshold alerts. Health-check updates can
be subscribed to or run periodically:

```ts
const monitor = new MonitoringHooks();
monitor.registerEndpointHealthCheck('gateway', 'https://api.example.com/health');

const unsubscribe = monitor.subscribe((update) => {
  renderDashboard(update.health, update.performance, update.alerts);
});
const stopChecks = monitor.startHealthChecks(5_000);
```

Endpoint probes support GET or HEAD, a timeout from 1 to 300,000 ms, and an
optional list of expected HTTP status codes. Call the returned `unsubscribe`
and `stopChecks` functions when the dashboard is closed.

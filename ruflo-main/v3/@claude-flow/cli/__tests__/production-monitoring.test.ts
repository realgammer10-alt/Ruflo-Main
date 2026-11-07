import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHealthEndpointConfig, runHealthEndpointChecks } from '../src/production/endpoint-health.js';
import { MonitoringHooks } from '../src/production/monitoring.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('MonitoringHooks', () => {
  it('validates monitor configuration and metric values', () => {
    expect(() => new MonitoringHooks({ samplingRate: 1.5 })).toThrow(/sampling rate/i);
    expect(() => new MonitoringHooks({ maxMetrics: 0 })).toThrow(/maximum metrics/i);

    const monitor = new MonitoringHooks();
    expect(() => monitor.counter('', 1)).toThrow(/metric name/i);
    expect(() => monitor.gauge('cpu', Number.NaN)).toThrow(/finite value/i);
    const invalidLabels: Record<string, string> = JSON.parse('{"method":42}');
    expect(() => monitor.counter('request', 1, invalidLabels)).toThrow(/string values/i);
  });

  it('publishes live request and metric updates and closes a request only once', () => {
    const monitor = new MonitoringHooks();
    const updates: string[] = [];
    const unsubscribe = monitor.subscribe((update) => updates.push(update.type));

    const finish = monitor.startRequest('request-1');
    expect(monitor.getPerformanceMetrics().activeRequests).toBe(1);
    finish();
    finish();

    expect(monitor.getPerformanceMetrics()).toMatchObject({
      requestCount: 1,
      activeRequests: 0,
    });
    expect(updates).toContain('request');
    expect(updates).toContain('metric');

    unsubscribe();
    const updateCount = updates.length;
    monitor.counter('after_unsubscribe');
    expect(updates).toHaveLength(updateCount);
  });

  it('runs registered health checks concurrently and returns defensive status copies', async () => {
    const monitor = new MonitoringHooks();
    let active = 0;
    let maxActive = 0;
    const check = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { healthy: true };
    };
    monitor.registerHealthCheck('first', check);
    monitor.registerHealthCheck('second', check);

    const result = await monitor.runHealthChecks();
    expect(result.healthy).toBe(true);
    expect(maxActive).toBe(2);
    result.checks.first.status = 'unhealthy';
    expect(monitor.getHealthStatus().checks.first.status).toBe('healthy');
  });

  it('probes HTTP endpoints and reports unexpected status codes', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const monitor = new MonitoringHooks();
    monitor.registerEndpointHealthCheck('ready', 'https://api.example.test/ready');
    monitor.registerEndpointHealthCheck('must-fail', 'https://api.example.test/error');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));

    const health = await monitor.runHealthChecks();
    expect(health.healthy).toBe(false);
    expect(health.checks.ready).toMatchObject({ status: 'healthy', message: 'HTTP 204' });
    expect(health.checks['must-fail']).toMatchObject({ status: 'unhealthy', message: 'HTTP 503' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/ready',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
  });

  it('rejects unsafe endpoint URLs and reports probe timeouts', async () => {
    const monitor = new MonitoringHooks();
    expect(() => monitor.registerEndpointHealthCheck('file', 'file:///etc/passwd')).toThrow(/HTTP or HTTPS/);
    expect(() => monitor.registerEndpointHealthCheck('fragment', 'https://api.example.test/health#')).toThrow(/fragment/);
    expect(() => monitor.registerEndpointHealthCheck('credentials', 'https://user:pass@example.test')).toThrow(/credentials/);

    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    monitor.registerEndpointHealthCheck('slow', 'https://api.example.test/slow', { timeoutMs: 5 });
    const health = await monitor.runHealthChecks();
    expect(health.checks.slow).toMatchObject({
      status: 'unhealthy',
      message: 'Timed out after 5 ms',
    });
  });

  it('schedules and stops periodic health checks', async () => {
    vi.useFakeTimers();
    const monitor = new MonitoringHooks();
    const check = vi.fn(async () => ({ healthy: true }));
    monitor.registerHealthCheck('ready', check);
    const stop = monitor.startHealthChecks(1000);

    await Promise.resolve();
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(check).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(check).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('configured API endpoint health checks', () => {
  it('validates endpoint configuration', () => {
    expect(parseHealthEndpointConfig(undefined)).toEqual([]);
    expect(parseHealthEndpointConfig(JSON.stringify([
      { name: 'public-api', url: 'https://api.example.test/health' },
    ]))).toEqual([
      { name: 'public-api', url: 'https://api.example.test/health' },
    ]);
    expect(() => parseHealthEndpointConfig('not-json')).toThrow(/JSON array/i);
    expect(() => parseHealthEndpointConfig(JSON.stringify([
      { name: 'api', url: 'https://one.example.test' },
      { name: 'api', url: 'https://two.example.test' },
    ]))).toThrow(/duplicate endpoint name/i);
    expect(() => parseHealthEndpointConfig(JSON.stringify([
      { name: 'local', url: 'file:///private/data' },
    ]))).toThrow(/HTTP\(S\)/i);
    expect(() => parseHealthEndpointConfig(JSON.stringify([
      { name: 'api gateway', url: 'https://api.example.test' },
    ]))).toThrow(/name may contain only/i);
    expect(() => parseHealthEndpointConfig(JSON.stringify([
      { name: 'api', url: 'https://api.example.test', timeoutMs: 100 },
    ]))).toThrow(/unsupported field/i);
  });

  it('returns health results for all configured APIs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    const result = await runHealthEndpointChecks([
      { name: 'gateway', url: 'https://gateway.example.test/health' },
    ]);

    expect(result?.healthy).toBe(true);
    expect(result?.checks.gateway.status).toBe('healthy');
    await expect(runHealthEndpointChecks([])).resolves.toBeUndefined();
  });
});

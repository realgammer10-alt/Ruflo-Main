/**
 * Production Monitoring and Observability
 *
 * Provides monitoring hooks for:
 * - Request/response metrics
 * - Error tracking
 * - Performance monitoring
 * - Health checks
 * - Alerting
 *
 * @module @claude-flow/cli/production/monitoring
 */

// ============================================================================
// Types
// ============================================================================

export type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary';

export interface MetricEvent {
  name: string;
  type: MetricType;
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

export interface MonitorConfig {
  // Enable monitoring
  enabled: boolean;
  // Metrics retention time (ms)
  retentionMs: number;
  // Maximum metrics to store
  maxMetrics: number;
  // Sampling rate (0-1)
  samplingRate: number;
  // Alert thresholds
  alertThresholds: Record<string, { warning: number; critical: number }>;
  // Health check interval (ms)
  healthCheckIntervalMs: number;
  // External reporting endpoint
  reportingEndpoint?: string;
  // Custom labels for all metrics
  globalLabels: Record<string, string>;
}

export interface HealthStatus {
  healthy: boolean;
  checks: Record<string, {
    status: 'healthy' | 'degraded' | 'unhealthy';
    message?: string;
    lastCheck: number;
    responseTimeMs?: number;
  }>;
  timestamp: number;
}

export interface EndpointHealthCheckOptions {
  timeoutMs?: number;
  method?: 'GET' | 'HEAD';
  expectedStatusCodes?: number[];
}

export interface MonitoringUpdate {
  type: 'metric' | 'health' | 'request' | 'error' | 'alert' | 'reset';
  timestamp: number;
  health: HealthStatus;
  performance: PerformanceMetrics;
  metric?: MetricEvent;
  alerts: Alert[];
}

export interface PerformanceMetrics {
  requestCount: number;
  errorCount: number;
  errorRate: number;
  avgResponseTimeMs: number;
  p50ResponseTimeMs: number;
  p95ResponseTimeMs: number;
  p99ResponseTimeMs: number;
  activeRequests: number;
  uptime: number;
}

type AlertLevel = 'info' | 'warning' | 'critical';

interface Alert {
  id: string;
  level: AlertLevel;
  metric: string;
  message: string;
  value: number;
  threshold: number;
  timestamp: number;
  acknowledged: boolean;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: MonitorConfig = {
  enabled: true,
  retentionMs: 3600000, // 1 hour
  maxMetrics: 100000,
  samplingRate: 1.0,
  alertThresholds: {
    'error_rate': { warning: 0.05, critical: 0.1 },
    'response_time_ms': { warning: 1000, critical: 5000 },
    'active_requests': { warning: 100, critical: 500 },
  },
  healthCheckIntervalMs: 30000,
  globalLabels: {},
};

// ============================================================================
// Monitoring Implementation
// ============================================================================

export class MonitoringHooks {
  private config: MonitorConfig;
  private metrics: MetricEvent[] = [];
  private responseTimes: number[] = [];
  private alerts: Alert[] = [];
  private listeners = new Set<(update: MonitoringUpdate) => void>();
  private healthStatus: HealthStatus;
  private startTime = Date.now();
  private activeRequests = 0;
  private requestCount = 0;
  private errorCount = 0;
  private healthChecks: Map<string, () => Promise<{ healthy: boolean; message?: string }>> = new Map();

  constructor(config: Partial<MonitorConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      alertThresholds: { ...DEFAULT_CONFIG.alertThresholds, ...config.alertThresholds },
      globalLabels: { ...DEFAULT_CONFIG.globalLabels, ...config.globalLabels },
    };
    this.validateConfig();
    this.healthStatus = {
      healthy: true,
      checks: {},
      timestamp: Date.now(),
    };
  }

  // ============================================================================
  // Metrics Collection
  // ============================================================================

  /**
   * Record a counter metric
   */
  counter(name: string, value: number = 1, labels: Record<string, string> = {}): void {
    this.recordMetric(name, 'counter', value, labels);
  }

  /**
   * Record a gauge metric
   */
  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    this.recordMetric(name, 'gauge', value, labels);
  }

  /**
   * Record a histogram metric
   */
  histogram(name: string, value: number, labels: Record<string, string> = {}): void {
    this.recordMetric(name, 'histogram', value, labels);
  }

  /**
   * Record a metric event
   */
  private recordMetric(
    name: string,
    type: MetricType,
    value: number,
    labels: Record<string, string>
  ): void {
    if (!name.trim()) throw new Error('Metric name must not be empty');
    if (!Number.isFinite(value)) throw new Error(`Metric "${name}" must have a finite value`);
    this.validateLabels(labels);
    if (!this.config.enabled) return;

    // Apply sampling
    if (Math.random() >= this.config.samplingRate) return;

    const event: MetricEvent = {
      name,
      type,
      value,
      labels: { ...this.config.globalLabels, ...labels },
      timestamp: Date.now(),
    };

    this.metrics.push(event);

    // Check alerts
    this.checkAlerts(name, value);

    // Cleanup old metrics
    this.cleanupMetrics();
    this.publishUpdate('metric', event);
  }

  // ============================================================================
  // Request Tracking
  // ============================================================================

  /**
   * Start tracking a request
   */
  startRequest(requestId: string): () => void {
    if (!requestId.trim()) throw new Error('Request ID must not be empty');
    this.activeRequests++;
    this.requestCount++;
    const startTime = Date.now();

    this.counter('request_started', 1, { requestId });
    this.publishUpdate('request');

    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      const duration = Date.now() - startTime;
      this.responseTimes.push(duration);
      this.histogram('response_time_ms', duration, { requestId });

      // Keep only last 1000 response times
      if (this.responseTimes.length > 1000) {
        this.responseTimes = this.responseTimes.slice(-1000);
      }
      this.publishUpdate('request');
    };
  }

  /**
   * Record an error
   */
  recordError(error: Error, labels: Record<string, string> = {}): void {
    if (!(error instanceof Error)) throw new TypeError('recordError expects an Error instance');
    this.validateLabels(labels);
    this.errorCount++;
    this.counter('error', 1, {
      ...labels,
      errorType: error.name,
      errorMessage: error.message.slice(0, 100),
    });
    this.publishUpdate('error');
  }

  // ============================================================================
  // Health Checks
  // ============================================================================

  /**
   * Register a health check
   */
  registerHealthCheck(
    name: string,
    check: () => Promise<{ healthy: boolean; message?: string }>
  ): void {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Health check name must not be empty');
    if (typeof check !== 'function') throw new TypeError('Health check must be a function');
    this.healthChecks.set(name, check);
  }

  /**
   * Register an HTTP endpoint probe. The target is fixed at registration time;
   * redirects are not followed so a probe cannot silently switch destinations.
   */
  registerEndpointHealthCheck(
    name: string,
    endpoint: string,
    options: EndpointHealthCheckOptions = {}
  ): void {
    const url = this.validateEndpoint(endpoint);
    const timeoutMs = options.timeoutMs ?? 5000;
    const method = options.method ?? 'GET';
    const expectedStatusCodes = options.expectedStatusCodes ?? [];

    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      throw new RangeError('Health check timeout must be between 1 and 300000 ms');
    }
    if (method !== 'GET' && method !== 'HEAD') {
      throw new Error('Health check method must be GET or HEAD');
    }
    if (
      !Array.isArray(expectedStatusCodes) ||
      expectedStatusCodes.some((status) => !Number.isInteger(status) || status < 100 || status > 599)
    ) {
      throw new Error('Expected status codes must be an array of HTTP status codes (100-599)');
    }

    const expected = expectedStatusCodes.length > 0
      ? new Set(expectedStatusCodes)
      : null;

    this.registerHealthCheck(name, async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method,
          redirect: 'manual',
          signal: controller.signal,
        });
        await response.body?.cancel();
        const healthy = expected
          ? expected.has(response.status)
          : response.status >= 200 && response.status < 300;

        return {
          healthy,
          message: healthy
            ? `HTTP ${response.status}`
            : `HTTP ${response.status}${expected ? ` (expected ${[...expected].join(', ')})` : ''}`,
        };
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).replace(url, '[endpoint]');
        return {
          healthy: false,
          message: controller.signal.aborted
            ? `Timed out after ${timeoutMs} ms`
            : message,
        };
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  /**
   * Run all health checks
   */
  async runHealthChecks(): Promise<HealthStatus> {
    const results = await Promise.all([...this.healthChecks].map(async ([name, check]) => {
      const startTime = Date.now();
      try {
        const result = await check();
        if (
          !result ||
          typeof result.healthy !== 'boolean' ||
          (result.message !== undefined && typeof result.message !== 'string')
        ) {
          throw new TypeError(`Health check "${name}" returned an invalid result`);
        }
        return [name, {
          status: result.healthy ? 'healthy' as const : 'unhealthy' as const,
          message: result.message,
          lastCheck: Date.now(),
          responseTimeMs: Date.now() - startTime,
        }] as const;
      } catch (error) {
        return [name, {
          status: 'unhealthy',
          message: error instanceof Error ? error.message : String(error),
          lastCheck: Date.now(),
          responseTimeMs: Date.now() - startTime,
        }] as const;
      }
    }));

    const healthChecks = Object.fromEntries(results);
    const allHealthy = results.every(([, result]) => result.status === 'healthy');

    this.healthStatus = {
      healthy: allHealthy,
      checks: healthChecks,
      timestamp: Date.now(),
    };
    this.publishUpdate('health');

    return this.getHealthStatus();
  }

  /**
   * Run health checks on a fixed interval without overlapping check cycles.
   * The returned function stops future checks; an in-progress check is allowed
   * to finish and publish its result.
   */
  startHealthChecks(intervalMs = this.config.healthCheckIntervalMs): () => void {
    if (!Number.isInteger(intervalMs) || intervalMs < 1) {
      throw new RangeError('Health check interval must be a positive integer');
    }

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (): void => {
      if (stopped) return;
      void this.runHealthChecks()
        .catch((error: unknown) => {
          console.error('[monitoring] Health check cycle failed:', error);
        })
        .finally(() => {
          if (!stopped) timer = setTimeout(run, intervalMs);
        });
    };

    run();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  /**
   * Subscribe to live monitor updates. The returned function unsubscribes.
   */
  subscribe(listener: (update: MonitoringUpdate) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('Monitor listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Get current health status
   */
  getHealthStatus(): HealthStatus {
    return {
      ...this.healthStatus,
      checks: Object.fromEntries(
        Object.entries(this.healthStatus.checks).map(([name, check]) => [name, { ...check }])
      ),
    };
  }

  // ============================================================================
  // Performance Metrics
  // ============================================================================

  /**
   * Get performance metrics
   */
  getPerformanceMetrics(): PerformanceMetrics {
    const sortedTimes = [...this.responseTimes].sort((a, b) => a - b);
    const count = sortedTimes.length;

    const percentile = (p: number) => {
      if (count === 0) return 0;
      const index = Math.ceil(count * p) - 1;
      return sortedTimes[Math.min(index, count - 1)];
    };

    const avgResponseTime = count > 0
      ? sortedTimes.reduce((a, b) => a + b, 0) / count
      : 0;

    return {
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      errorRate: this.requestCount > 0 ? this.errorCount / this.requestCount : 0,
      avgResponseTimeMs: Math.round(avgResponseTime),
      p50ResponseTimeMs: percentile(0.5),
      p95ResponseTimeMs: percentile(0.95),
      p99ResponseTimeMs: percentile(0.99),
      activeRequests: this.activeRequests,
      uptime: Date.now() - this.startTime,
    };
  }

  // ============================================================================
  // Alerting
  // ============================================================================

  /**
   * Get active alerts
   */
  getAlerts(level?: AlertLevel): Alert[] {
    let filtered = this.alerts.filter(a => !a.acknowledged);
    if (level) {
      filtered = filtered.filter(a => a.level === level);
    }
    return filtered.map(alert => ({ ...alert }));
  }

  /**
   * Acknowledge an alert
   */
  acknowledgeAlert(alertId: string): boolean {
    const alert = this.alerts.find(a => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      this.publishUpdate('alert');
      return true;
    }
    return false;
  }

  /**
   * Clear all alerts
   */
  clearAlerts(): void {
    this.alerts = [];
    this.publishUpdate('alert');
  }

  // ============================================================================
  // Data Export
  // ============================================================================

  /**
   * Get metrics for a specific name
   */
  getMetrics(name: string, since?: number): MetricEvent[] {
    if (since !== undefined && !Number.isFinite(since)) {
      throw new RangeError('Metric timestamp filter must be finite');
    }
    let filtered = this.metrics.filter(m => m.name === name);
    if (since !== undefined) {
      filtered = filtered.filter(m => m.timestamp >= since);
    }
    return filtered.map(metric => ({ ...metric, labels: { ...metric.labels } }));
  }

  /**
   * Get all metrics summary
   */
  getMetricsSummary(): Record<string, { count: number; lastValue: number; avgValue: number }> {
    const summary = new Map<string, { count: number; sum: number; lastValue: number }>();

    for (const metric of this.metrics) {
      let data = summary.get(metric.name);
      if (!data) {
        data = { count: 0, sum: 0, lastValue: 0 };
        summary.set(metric.name, data);
      }
      data.count++;
      data.sum += metric.value;
      data.lastValue = metric.value;
    }

    return Object.fromEntries([...summary].map(([name, data]) => [
      name, {
        count: data.count,
        lastValue: data.lastValue,
        avgValue: data.count > 0 ? data.sum / data.count : 0,
      },
    ]));
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.metrics = [];
    this.responseTimes = [];
    this.alerts = [];
    this.requestCount = 0;
    this.errorCount = 0;
    this.activeRequests = 0;
    this.startTime = Date.now();
    this.healthStatus = { healthy: true, checks: {}, timestamp: Date.now() };
    this.publishUpdate('reset');
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private checkAlerts(name: string, value: number): void {
    const thresholds = this.config.alertThresholds[name];
    if (!thresholds) return;

    let level: AlertLevel | null = null;
    let threshold = 0;

    if (value >= thresholds.critical) {
      level = 'critical';
      threshold = thresholds.critical;
    } else if (value >= thresholds.warning) {
      level = 'warning';
      threshold = thresholds.warning;
    }

    if (level) {
      // Check if we already have a recent alert for this metric
      const recentAlert = this.alerts.find(
        a => a.metric === name &&
        !a.acknowledged &&
        Date.now() - a.timestamp < 60000
      );

      if (!recentAlert) {
        this.alerts.push({
          id: `alert_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          level,
          metric: name,
          message: `${name} exceeded ${level} threshold: ${value} >= ${threshold}`,
          value,
          threshold,
          timestamp: Date.now(),
          acknowledged: false,
        });
        this.publishUpdate('alert');
      }
    }
  }

  private validateConfig(): void {
    if (typeof this.config.enabled !== 'boolean') {
      throw new TypeError('Monitor enabled must be a boolean');
    }
    if (!Number.isFinite(this.config.retentionMs) || this.config.retentionMs < 1) {
      throw new RangeError('Metric retention must be a positive finite number');
    }
    if (!Number.isInteger(this.config.maxMetrics) || this.config.maxMetrics < 1) {
      throw new RangeError('Maximum metrics must be a positive integer');
    }
    if (
      !Number.isFinite(this.config.samplingRate) ||
      this.config.samplingRate < 0 ||
      this.config.samplingRate > 1
    ) {
      throw new RangeError('Sampling rate must be between 0 and 1');
    }
    if (!Number.isFinite(this.config.healthCheckIntervalMs) || this.config.healthCheckIntervalMs < 1) {
      throw new RangeError('Health check interval must be a positive finite number');
    }

    for (const [name, thresholds] of Object.entries(this.config.alertThresholds)) {
      if (
        !name.trim() ||
        !thresholds ||
        typeof thresholds !== 'object' ||
        !Number.isFinite(thresholds.warning) ||
        !Number.isFinite(thresholds.critical) ||
        thresholds.warning < 0 ||
        thresholds.critical < thresholds.warning
      ) {
        throw new Error(`Invalid alert thresholds for "${name}"`);
      }
    }
    this.validateLabels(this.config.globalLabels);
  }

  private validateLabels(labels: Record<string, string>): void {
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
      throw new TypeError('Metric labels must be an object of string values');
    }
    for (const [key, value] of Object.entries(labels)) {
      if (!key.trim() || typeof value !== 'string') {
        throw new TypeError('Metric labels must have non-empty names and string values');
      }
    }
  }

  private validateEndpoint(endpoint: string): string {
    if (typeof endpoint !== 'string' || !endpoint.trim()) {
      throw new Error('Health check endpoint must not be empty');
    }

    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error('Health check endpoint must be a valid absolute URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Health check endpoint must use HTTP or HTTPS');
    }
    if (url.username || url.password || url.hash || endpoint.includes('#')) {
      throw new Error('Health check endpoint must not contain credentials or a fragment');
    }
    return url.toString();
  }

  private publishUpdate(type: MonitoringUpdate['type'], metric?: MetricEvent): void {
    if (this.listeners.size === 0) return;
    const update: MonitoringUpdate = {
      type,
      timestamp: Date.now(),
      health: this.getHealthStatus(),
      performance: this.getPerformanceMetrics(),
      alerts: this.getAlerts(),
      ...(metric ? { metric: { ...metric, labels: { ...metric.labels } } } : {}),
    };

    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch (error) {
        console.error('[monitoring] Subscriber callback failed:', error);
      }
    }
  }

  private cleanupMetrics(): void {
    const now = Date.now();
    const cutoff = now - this.config.retentionMs;

    // Remove old metrics
    this.metrics = this.metrics.filter(m => m.timestamp > cutoff);

    // Limit total metrics
    if (this.metrics.length > this.config.maxMetrics) {
      this.metrics = this.metrics.slice(-this.config.maxMetrics);
    }

    // Remove old acknowledged alerts
    this.alerts = this.alerts.filter(
      a => !a.acknowledged || Date.now() - a.timestamp < 300000
    );
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

let defaultMonitor: MonitoringHooks | null = null;

/**
 * Create or get the default monitor
 */
export function createMonitor(config?: Partial<MonitorConfig>): MonitoringHooks {
  if (!defaultMonitor) {
    defaultMonitor = new MonitoringHooks(config);
  }
  return defaultMonitor;
}

/**
 * Get the default monitor
 */
export function getMonitor(): MonitoringHooks {
  return createMonitor();
}

export default MonitoringHooks;

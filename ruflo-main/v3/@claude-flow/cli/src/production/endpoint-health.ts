import { MonitoringHooks, type HealthStatus } from './monitoring.js';

export interface HealthEndpointTarget {
  name: string;
  url: string;
}

const MAX_HEALTH_ENDPOINTS = 20;
const MAX_ENDPOINT_CONFIG_LENGTH = 16_384;

export function parseHealthEndpointConfig(value: string | undefined): HealthEndpointTarget[] {
  if (!value?.trim()) return [];
  if (value.length > MAX_ENDPOINT_CONFIG_LENGTH) {
    throw new Error(`RUFLO_HEALTH_ENDPOINTS must not exceed ${MAX_ENDPOINT_CONFIG_LENGTH} characters`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      'RUFLO_HEALTH_ENDPOINTS must be a JSON array of { "name": "...", "url": "https://..." } entries',
      { cause: error },
    );
  }

  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_HEALTH_ENDPOINTS) {
    throw new Error(`RUFLO_HEALTH_ENDPOINTS must contain between 1 and ${MAX_HEALTH_ENDPOINTS} endpoints`);
  }

  const names = new Set<string>();
  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`RUFLO_HEALTH_ENDPOINTS[${index}] must be an object`);
    }

    const target = item as Record<string, unknown>;
    if (typeof target.name !== 'string' || !target.name.trim()) {
      throw new Error(`RUFLO_HEALTH_ENDPOINTS[${index}].name must be a non-empty string`);
    }
    const name = target.name.trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
      throw new Error(`RUFLO_HEALTH_ENDPOINTS[${index}].name may contain only letters, numbers, ".", "_" and "-"`);
    }
    if (typeof target.url !== 'string' || !target.url.trim()) {
      throw new Error(`RUFLO_HEALTH_ENDPOINTS[${index}].url must be a non-empty string`);
    }
    if (target.url.length > 2048) {
      throw new Error(`RUFLO_HEALTH_ENDPOINTS[${index}].url must not exceed 2048 characters`);
    }
    const unexpectedKeys = Object.keys(target).filter((key) => key !== 'name' && key !== 'url');
    if (unexpectedKeys.length > 0) {
      throw new Error(`RUFLO_HEALTH_ENDPOINTS[${index}] has unsupported field "${unexpectedKeys[0]}"`);
    }
    let url: URL;
    try {
      url = new URL(target.url);
    } catch (error) {
      throw new Error(`RUFLO_HEALTH_ENDPOINTS[${index}].url must be an absolute HTTP(S) URL`, { cause: error });
    }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      url.hash ||
      target.url.includes('#')
    ) {
      throw new Error(`RUFLO_HEALTH_ENDPOINTS[${index}].url must use HTTP(S) without credentials or a fragment`);
    }
    if (names.has(name)) {
      throw new Error(`RUFLO_HEALTH_ENDPOINTS contains duplicate endpoint name "${name}"`);
    }

    names.add(name);
    return { name, url: target.url };
  });
}

export async function runHealthEndpointChecks(
  targets: readonly HealthEndpointTarget[],
): Promise<HealthStatus | undefined> {
  if (!Array.isArray(targets) || targets.length > MAX_HEALTH_ENDPOINTS) {
    throw new RangeError(`At most ${MAX_HEALTH_ENDPOINTS} health endpoints can be checked`);
  }
  if (targets.length === 0) return undefined;

  const monitor = new MonitoringHooks();
  for (const target of targets) {
    monitor.registerEndpointHealthCheck(target.name, target.url);
  }
  return monitor.runHealthChecks();
}

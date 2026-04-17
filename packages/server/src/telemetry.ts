/**
 * OpenTelemetry initialization.
 *
 * MUST be imported FIRST — before any other code, so auto-instrumentation can
 * hook into http/pg/express/prisma modules as they load.
 *
 * Configuration (env):
 *   OTEL_ENABLED=true                        — gate entire SDK
 *   OTEL_SERVICE_NAME=angel-ai-v2            — resource attribute
 *   OTEL_EXPORTER_OTLP_ENDPOINT=https://...  — backend (Axiom/Honeycomb/Jaeger/...)
 *   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20xxx
 *   OTEL_LOG_LEVEL=info
 *
 * With no OTLP endpoint, spans + metrics are buffered in-memory and quietly
 * dropped on flush — useful for dev. Set OTEL_EXPORTER_CONSOLE=true to print
 * to stdout instead.
 */
import { diag, DiagConsoleLogger, DiagLogLevel, trace, metrics } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const ENABLED = process.env.OTEL_ENABLED === 'true';
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'angel-ai-v2';
const SERVICE_VERSION = process.env.npm_package_version || '2.0.0';

let sdk: NodeSDK | null = null;

export function initTelemetry(): void {
  if (!ENABLED) {
    console.log('[otel] disabled (set OTEL_ENABLED=true to enable)');
    return;
  }

  // Surface SDK diagnostics at warn level by default
  const logLevel = (process.env.OTEL_LOG_LEVEL || 'warn').toUpperCase();
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel[logLevel as keyof typeof DiagLogLevel] ?? DiagLogLevel.WARN);

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
    'deployment.environment': process.env.NODE_ENV || 'development',
  });

  const traceExporter = new OTLPTraceExporter();    // picks up OTEL_EXPORTER_OTLP_* env vars
  const metricExporter = new OTLPMetricExporter();

  sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader: undefined, // auto-instrumentations node ships a default reader via SDK
    instrumentations: [
      getNodeAutoInstrumentations({
        // HTTP is noisy; keep but shallow
        '@opentelemetry/instrumentation-http': { enabled: true },
        '@opentelemetry/instrumentation-express': { enabled: true },
        '@opentelemetry/instrumentation-pg': { enabled: true },
        '@opentelemetry/instrumentation-fs': { enabled: false },  // way too noisy
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      }),
    ],
  });

  try {
    sdk.start();
    console.log(`[otel] ✓ started — service=${SERVICE_NAME} version=${SERVICE_VERSION}`);
  } catch (err: any) {
    console.warn('[otel] start failed:', err?.message?.slice(0, 200));
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    try { await sdk.shutdown(); } catch {}
    sdk = null;
  }
}

// Convenience helpers for manual spans on hot paths
export function getTracer(name = 'angel-ai-v2') {
  return trace.getTracer(name, SERVICE_VERSION);
}

export function getMeter(name = 'angel-ai-v2') {
  return metrics.getMeter(name, SERVICE_VERSION);
}

/**
 * Wrap an async function in a span. Sets span status from the result:
 * OK on success, ERROR on throw (with error attributes).
 */
export async function withSpan<T>(
  name: string,
  fn: (span: ReturnType<ReturnType<typeof getTracer>['startSpan']>) => Promise<T>,
  attrs?: Record<string, string | number | boolean>,
): Promise<T> {
  if (!ENABLED) return fn(null as any);
  const tracer = getTracer();
  const span = tracer.startSpan(name);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v as any);
  }
  try {
    const result = await fn(span);
    span.setStatus({ code: 1 }); // OK
    return result;
  } catch (err: any) {
    span.recordException(err);
    span.setStatus({ code: 2, message: err?.message?.slice(0, 200) }); // ERROR
    throw err;
  } finally {
    span.end();
  }
}

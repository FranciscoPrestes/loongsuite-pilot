import { describe, expect, it, vi } from 'vitest';
import { ExportResultCode } from '@opentelemetry/core';

// The REAL converter is used on purpose: only the network exporter is faked.
const exported = vi.hoisted(() => [] as any[]);
vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(() => ({
    export: vi.fn((spans: unknown[], cb: (r: { code: number }) => void) => { exported.push(...spans); cb({ code: ExportResultCode.SUCCESS }); }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { attachObservation } from '../../../../src/analytics/observation-exporter.js';
import { carrierFor } from '../../../../src/analytics/observation-pump.js';
import { job, observation } from '../../enrichment/fixtures.js';

async function exportCarrier(overrides: Record<string, unknown>) {
  exported.length = 0;
  const signalAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const o = { ...observation(job({ occurredAt: signalAt })), occurredAt: new Date().toISOString() };
  const entry = { ...attachObservation(carrierFor(o, '/tmp/example', 'u', signalAt), o), ...overrides } as never;
  const flusher = new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318', headers: {} }],
    protocol: 'http/protobuf' as const, serviceName: 'test-pilot' } as never);
  await flusher.send(entry);
  await flusher.flush();
  await flusher.shutdown();
  return { signalAt, spans: [...exported] };
}
const startMs = (span: any) => span.startTime[0] * 1000 + Math.floor(span.startTime[1] / 1e6);

describe('analytics carrier through the REAL OTLP conversion', () => {
  it('the exported span starts at the SOURCE event time (so failed-log startTimeUnixNano carries it)', async () => {
    const { signalAt, spans } = await exportCarrier({});
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.every(span => startMs(span) === Date.parse(signalAt))).toBe(true);
  });

  // KNOWN DEFECT (ruling pending): a standalone `other` carrier is reduced by the converter to bare
  // invoke_agent / entry spans and the ntconsult.analytics.* attributes are dropped. They survive only on
  // LLM/tool-shaped spans, which would be fake activity. it.fails flips to a failure the day this is fixed.
  it.fails('keeps the analytics annotations on an exported span', async () => {
    const { spans } = await exportCarrier({});
    expect(spans.some(span => span.attributes?.['ntconsult.analytics.kind'] === 'repo_snapshot')).toBe(true);
  });
});

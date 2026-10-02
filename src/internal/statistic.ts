// NTConsult fork: the upstream open-source build reports host, ip, hostname and metrics to
// an Alibaba SLS project every 12 h. That is third-party telemetry from corporate machines,
// so the fork keeps the export but makes it a no-op. On a sync conflict, keep this version.
export function sendRunningStatus(_data: Record<string, unknown>): void {}

import { createServer, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createLogger } from '../utils/logger.js';
import type { DashboardPanel } from '../types/index.js';

const logger = createLogger('DashboardServer');

export const DEFAULT_DASHBOARD_HOST = '127.0.0.1';
export const DEFAULT_DASHBOARD_PORT = 8_765;
export const DASHBOARD_ID_HEADER = 'x-loongsuite-pilot-dashboard';
export const DASHBOARD_ID_VALUE = 'metrics-summary-v1';
export const DASHBOARD_INSTANCE_HEADER = 'x-loongsuite-pilot-instance';

export interface DashboardServerOptions {
  dataDir: string;
  /** Upstream panel, always served as the fallback. */
  assetPath: string;
  /** NTConsult panel (`assets/dashboard/ntc/index.html`). Optional so upstream keeps working without it. */
  ntcAssetPath?: string;
  /** Panel served at `/` when the request has no `?panel=` override. Defaults to `original`. */
  panel?: DashboardPanel;
  host?: string;
  port?: number;
}

/**
 * In-process, read-only HTTP server for the local dashboard.
 *
 * It intentionally exposes only the static page and the MetricsSummaryWriter
 * output. Keeping the server inside the collector gives it the same lifecycle
 * as the orchestrator and avoids a separately managed child process.
 */
export class DashboardServer {
  private readonly host: string;
  private readonly port: number;
  private readonly assetPath: string;
  private readonly ntcAssetPath: string | null;
  private readonly panel: DashboardPanel;
  private readonly summaryPath: string;
  private readonly instanceId: string;
  private server: Server | null = null;
  private startPromise: Promise<void> | null = null;

  constructor(options: DashboardServerOptions) {
    this.host = options.host ?? DEFAULT_DASHBOARD_HOST;
    this.port = options.port ?? DEFAULT_DASHBOARD_PORT;
    this.assetPath = options.assetPath;
    this.ntcAssetPath = options.ntcAssetPath ?? null;
    this.panel = options.panel ?? 'original';
    this.summaryPath = path.join(options.dataDir, 'logs', 'metrics-summary.json');
    this.instanceId = createHash('sha256').update(path.resolve(options.dataDir)).digest('hex');
  }

  get running(): boolean {
    return this.server?.listening ?? false;
  }

  get address(): string | null {
    const address = this.server?.address();
    if (!address || typeof address === 'string') return null;
    return `http://${this.host}:${address.port}/`;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.listen();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    if (this.startPromise) await this.startPromise;
    const server = this.server;
    this.server = null;
    if (!server?.listening) return;

    const closed = new Promise<void>((resolve) => {
      server.close((error) => {
        if (error) {
          logger.warn('dashboard stop failed', { error: String(error) });
        }
        resolve();
      });
    });
    // Dashboard requests are read-only and disposable. Close any idle/active
    // browser sockets so collector shutdown is never delayed by HTTP keep-alive.
    const closeAllConnections = (server as Server & {
      closeAllConnections?: () => void;
    }).closeAllConnections;
    closeAllConnections?.call(server);
    await closed;
    logger.info('dashboard stopped');
  }

  private async listen(): Promise<void> {
    const server = createServer((request, response) => {
      void this.handleRequest(
        request.url ?? '/',
        request.method ?? 'GET',
        request.headers.host,
        response,
      );
    });

    await new Promise<void>((resolve) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        logger.warn('dashboard start failed (non-fatal)', {
          host: this.host,
          port: this.port,
          code: error.code,
          error: String(error),
        });
        resolve();
      };
      const onListening = () => {
        server.off('error', onError);
        server.on('error', error => {
          logger.warn('dashboard server error', { error: String(error) });
        });
        this.server = server;
        logger.info('dashboard started', { url: this.address });
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, this.host);
    });
  }

  private async handleRequest(
    requestUrl: string,
    method: string,
    hostHeader: string | undefined,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (!this.isAllowedHost(hostHeader)) {
        this.sendJson(response, 421, { error: 'invalid dashboard host' }, method === 'HEAD');
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        this.sendJson(response, 405, { error: 'method not allowed' }, method === 'HEAD');
        return;
      }

      const url = new URL(requestUrl, 'http://127.0.0.1');
      const pathname = url.pathname;
      if (pathname === '/' || pathname === '/index.html') {
        // ?panel=ntc|original overrides the configured panel per request, so
        // both panels stay reachable even when the flag picks the other one.
        const panel = resolveRequestedPanel(url.searchParams.get('panel'), this.panel);
        const html = await this.readPanel(panel);
        this.send(response, 200, html, 'text/html; charset=utf-8', method === 'HEAD');
        return;
      }

      if (pathname === '/metrics-summary.json') {
        try {
          // Return the file bytes directly so the dashboard consumes exactly the
          // same contract as the menu bar, without a second aggregation layer.
          const summary = await fs.readFile(this.summaryPath);
          this.send(response, 200, summary, 'application/json; charset=utf-8', method === 'HEAD');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            this.sendJson(response, 503, {
              error: 'metrics summary is not ready',
            }, method === 'HEAD');
            return;
          }
          throw error;
        }
        return;
      }

      this.sendJson(response, 404, { error: 'not found' }, method === 'HEAD');
    } catch (error) {
      logger.warn('dashboard request failed', { error: String(error) });
      this.sendJson(response, 500, { error: 'dashboard request failed' }, method === 'HEAD');
    }
  }

  /**
   * Reads the requested panel, falling back to the upstream panel when the
   * NTConsult asset is missing (older installs, partial packages).
   */
  private async readPanel(panel: DashboardPanel): Promise<Buffer> {
    if (panel === 'ntc' && this.ntcAssetPath) {
      try {
        return await fs.readFile(this.ntcAssetPath);
      } catch (error) {
        logger.warn('ntc dashboard panel unavailable, serving original', { error: String(error) });
      }
    }
    return fs.readFile(this.assetPath);
  }

  private isAllowedHost(hostHeader: string | undefined): boolean {
    const address = this.server?.address();
    if (!address || typeof address === 'string' || !hostHeader) return false;
    return isAllowedDashboardHost(hostHeader, this.host, address.port);
  }

  private sendJson(
    response: ServerResponse,
    statusCode: number,
    body: Record<string, unknown>,
    headOnly = false,
  ): void {
    this.send(
      response,
      statusCode,
      Buffer.from(JSON.stringify(body)),
      'application/json; charset=utf-8',
      headOnly,
    );
  }

  private send(
    response: ServerResponse,
    statusCode: number,
    body: Buffer,
    contentType: string,
    headOnly = false,
  ): void {
    response.writeHead(statusCode, {
      'content-type': contentType,
      'content-length': body.byteLength,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      [DASHBOARD_ID_HEADER]: DASHBOARD_ID_VALUE,
      [DASHBOARD_INSTANCE_HEADER]: this.instanceId,
    });
    response.end(headOnly ? undefined : body);
  }
}

/**
 * Resolves the panel for one request. An explicit `?panel=ntc|original` always
 * wins; any other value falls back to the configured default.
 */
export function resolveRequestedPanel(
  requested: string | null,
  configured: DashboardPanel,
): DashboardPanel {
  return requested === 'ntc' || requested === 'original' ? requested : configured;
}

export function isAllowedDashboardHost(hostHeader: string, host: string, port: number): boolean {
  const allowed = new Set([
    `${host}:${port}`.toLowerCase(),
    `${DEFAULT_DASHBOARD_HOST}:${port}`,
    `localhost:${port}`,
  ]);
  if (port === 80) {
    allowed.add(host.toLowerCase());
    allowed.add(DEFAULT_DASHBOARD_HOST);
    allowed.add('localhost');
  }
  return allowed.has(hostHeader.toLowerCase());
}

import type { Logger } from "../logger.js";
import type { Server } from "node:http";

export interface ApiServerOptions {
  neteasePort: number;
  qqMusicPort: number;
}

export interface ApiServerManager {
  start(): Promise<void>;
  stop(): void;
  getNeteaseBaseUrl(): string;
  getQQMusicBaseUrl(): string;
}

export function createApiServerManager(
  options: ApiServerOptions,
  logger: Logger
): ApiServerManager {
  let neteaseServer: Server | null = null;

  const neteaseBaseUrl = `http://127.0.0.1:${options.neteasePort}`;
  const qqMusicBaseUrl = `http://127.0.0.1:${options.qqMusicPort}`;

  return {
    async start(): Promise<void> {
      logger.info("Starting embedded music API servers...");

      // Start NetEase Cloud Music API
      try {
        // NeteaseCloudMusicApi exports differ between CJS/ESM — use dynamic require
        const ncmModule = await import("NeteaseCloudMusicApi") as any;
        const serverObj = ncmModule.server ?? ncmModule.default?.server;
        const app = await serverObj.serveNcmApi({ port: options.neteasePort });
        // serveNcmApi returns the express app; the server is already listening
        neteaseServer = app;
        logger.info(
          { port: options.neteasePort },
          "NetEase Cloud Music API started"
        );
      } catch (err) {
        logger.error({ err }, "Failed to start NetEase Cloud Music API");
      }

      // QQ Music API — placeholder (requires separate setup)
      try {
        logger.info(
          { port: options.qqMusicPort },
          "QQ Music API: not bundled, skipping"
        );
      } catch (err) {
        logger.warn(
          { err },
          "QQ Music API not available"
        );
      }
    },

    stop(): void {
      logger.info("Stopping music API servers");
      if (neteaseServer && typeof (neteaseServer as any).close === "function") {
        (neteaseServer as any).close();
      }
      neteaseServer = null;
    },

    getNeteaseBaseUrl(): string {
      return neteaseBaseUrl;
    },

    getQQMusicBaseUrl(): string {
      return qqMusicBaseUrl;
    },
  };
}

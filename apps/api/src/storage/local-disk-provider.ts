import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import type { StorageProvider } from "./storage-provider.js";

/**
 * Local-disk implementation of StorageProvider, backed by the `uploads`
 * volume declared in docker-compose.yml. Storage keys are always
 * server-generated opaque identifiers (see attachments.service.ts), but this
 * class defensively re-validates the key shape before touching the
 * filesystem so a path-traversal payload could never reach `fs` even if a
 * future caller passed one through by mistake.
 */
export class LocalDiskStorageProvider implements StorageProvider {
  private readonly rootDir: string;

  constructor(rootDir: string = env.UPLOAD_DIR) {
    this.rootDir = path.resolve(rootDir);
  }

  private resolveSafePath(storageKey: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(storageKey)) {
      throw new Error("Invalid storage key.");
    }
    return path.join(this.rootDir, storageKey);
  }

  async put(storageKey: string, data: Buffer): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(this.resolveSafePath(storageKey), data);
  }

  async get(storageKey: string): Promise<Buffer> {
    return fs.readFile(this.resolveSafePath(storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    await fs.rm(this.resolveSafePath(storageKey), { force: true });
  }

  async getSignedOrProxyUrl(): Promise<string | null> {
    // Local disk has no direct public URL — callers must always go through
    // the authorized proxy download endpoint.
    return null;
  }
}

export const storageProvider: StorageProvider = new LocalDiskStorageProvider();

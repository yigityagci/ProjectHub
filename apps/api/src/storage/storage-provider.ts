/**
 * Storage abstraction for Phase 4 task attachments.
 *
 * Call sites (attachments.service.ts) only ever talk to this interface —
 * never to the filesystem or any cloud SDK directly — so a future
 * S3-compatible implementation can be swapped in without touching any
 * calling code. `storageKey` is always an opaque, server-generated
 * identifier (never derived from a client-supplied filename), which keeps
 * this interface free of local-disk-specific assumptions like paths or
 * directory separators.
 */
export interface StorageProvider {
  /** Persists `data` under `storageKey`, overwriting if it already exists. */
  put(storageKey: string, data: Buffer): Promise<void>;

  /** Reads back the full contents previously stored under `storageKey`. */
  get(storageKey: string): Promise<Buffer>;

  /** Permanently removes the object stored under `storageKey`, if present. */
  delete(storageKey: string): Promise<void>;

  /**
   * Returns a URL the caller could redirect a client to in order to fetch
   * the object directly (e.g. a pre-signed S3 URL), or `null` if this
   * provider has no such concept and the object must always be proxied
   * through an authorized application endpoint (true of the local-disk
   * implementation — attachments must never become directly, publicly
   * linkable).
   */
  getSignedOrProxyUrl(storageKey: string): Promise<string | null>;
}

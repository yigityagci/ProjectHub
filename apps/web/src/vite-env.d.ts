/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base URL of the API as reachable from the browser (e.g.
   * `http://localhost:4000`). Left unset in local development so requests
   * stay relative and go through Vite's dev server proxy. Baked in at
   * build time in Docker via the VITE_API_URL build arg.
   */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

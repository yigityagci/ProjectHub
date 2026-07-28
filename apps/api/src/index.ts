import { buildServer } from "./server.js";
import { env } from "./config/env.js";

async function main() {
  const app = await buildServer();

  try {
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    app.log.info(`ProjectHub API listening on port ${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully.`);
    await app.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

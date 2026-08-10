import pino, { type LoggerOptions } from "pino";
import { env } from "../config/env.js";

/**
 * Structured logging options with redaction of anything that could
 * contain a secret. This is defense-in-depth: routes must never pass raw
 * request bodies or credentials into log calls in the first place, but
 * redaction paths guard against accidental leakage.
 *
 * Exported as plain options (rather than only a pre-built instance) so
 * Fastify can construct its own internally-typed logger from them
 * (`Fastify({ logger: pinoOptions })`), avoiding the type friction of
 * passing a standalone pino instance across Fastify's generic logger type.
 */
export const pinoOptions: LoggerOptions = {
  level: env.NODE_ENV === "test" ? "silent" : env.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.tokenHash",
      "*.rawToken",
      "*.secret",
      "*.appSecret",
      "*.authorization",
      "*.cookie",
      // Self-hosted Postfix control plane (see email/mail-control.client.ts)
      // — the existing "*.token" path above is an EXACT key-name match in
      // pino's redact syntax, not a substring match, so it does not catch a
      // literal key named MAIL_CONTROL_TOKEN. DKIM private key material
      // (PEM) must never be logged either.
      "*.dkimPrivateKeyPem",
      "*.privateKeyPem",
      "*.dkimPrivateKeyCiphertext",
      "*.MAIL_CONTROL_TOKEN",
      "*.mailControlToken",
      "*.bearer",
    ],
    censor: "[REDACTED]",
  },
};

/**
 * Standalone logger instance for use outside of Fastify's request
 * lifecycle (e.g. audit/email services), sharing the same level/redaction
 * configuration as the Fastify-internal logger.
 */
export const logger = pino(pinoOptions);

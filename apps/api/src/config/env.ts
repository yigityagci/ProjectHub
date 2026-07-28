import "dotenv/config";
import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    APP_URL: z.string().url().default("http://localhost:4000"),
    WEB_URL: z.string().url().default("http://localhost:5173"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    REDIS_URL: z.string().min(1, "REDIS_URL is required"),
    APP_SECRET: z
      .string()
      .min(32, "APP_SECRET must be at least 32 characters long"),
    SESSION_TTL_HOURS: z.coerce.number().positive().default(24),
    SESSION_ABSOLUTE_TTL_HOURS: z.coerce.number().positive().default(24 * 30),
    COOKIE_SECURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    CORS_ORIGIN: z.string().default("http://localhost:5173"),
    SMTP_URL: z.string().optional(),
    SMTP_FROM: z.string().optional(),
    RATE_LIMIT_LOGIN_MAX: z.coerce.number().positive().default(10),
    RATE_LIMIT_LOGIN_WINDOW_MINUTES: z.coerce.number().positive().default(15),
    RATE_LIMIT_GLOBAL_MAX: z.coerce.number().positive().default(300),
    RATE_LIMIT_GLOBAL_WINDOW_MINUTES: z.coerce.number().positive().default(1),
    INVITE_TTL_HOURS: z.coerce.number().positive().default(24 * 7),
    ARGON2_MEMORY_COST_KIB: z.coerce.number().positive().default(19456),
    ARGON2_TIME_COST: z.coerce.number().positive().default(2),
    ARGON2_PARALLELISM: z.coerce.number().positive().default(1),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production") {
      if (!value.DATABASE_URL) {
        ctx.addIssue({ code: "custom", message: "DATABASE_URL is required in production" });
      }
      if (!value.REDIS_URL) {
        ctx.addIssue({ code: "custom", message: "REDIS_URL is required in production" });
      }
      if (!value.APP_SECRET || value.APP_SECRET.length < 32) {
        ctx.addIssue({
          code: "custom",
          message: "APP_SECRET must be set to a strong random value (>= 32 chars) in production",
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail fast with a clear, actionable message. Never boot with an
    // invalid/incomplete configuration, especially in production.
    // eslint-disable-next-line no-console
    console.error("Invalid environment configuration:");
    for (const issue of parsed.error.issues) {
      // eslint-disable-next-line no-console
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

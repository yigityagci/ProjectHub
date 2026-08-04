import { z } from "zod";

export const RECURRENCE_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];
export const MAX_RECURRENCE_INTERVAL = 99;
export const MAX_RECURRENCE_COUNT = 365;
export const MAX_RECURRENCE_BACKDATE_MS = 24 * 60 * 60 * 1000;

/**
 * STRUCTURAL schema — the sole source of truth for the shape of the
 * Task.recurrenceRule Json column (mirrors the CustomFieldDefinition.options
 * precedent: a zod schema is the only place this shape is enforced, never
 * the database). This is the ONLY schema used to parse a STORED rule — it
 * has no now-relative checks, so a rule written months ago still parses
 * correctly today.
 */
export const recurrenceRuleSchema = z
  .object({
    freq: z.enum(RECURRENCE_FREQUENCIES, { errorMap: () => ({ message: "Invalid recurrence frequency." }) }),
    interval: z
      .number()
      .int()
      .min(1, "Interval must be at least 1.")
      .max(MAX_RECURRENCE_INTERVAL, `Interval must be at most ${MAX_RECURRENCE_INTERVAL}.`),
    startAt: z.string().datetime({ message: "startAt must be a UTC ISO-8601 timestamp." }),
    until: z.string().datetime({ message: "until must be a UTC ISO-8601 timestamp." }).nullable().optional(),
    count: z.number().int().min(1).max(MAX_RECURRENCE_COUNT).nullable().optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.until != null && rule.count != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A recurrence can end on a date or after a number of occurrences, not both.",
      });
    }
    if (rule.until != null && new Date(rule.until).getTime() < new Date(rule.startAt).getTime()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "until must not be before startAt.", path: ["until"] });
    }
  });
export type RecurrenceRule = z.infer<typeof recurrenceRuleSchema>;

/**
 * WRITE path only (client-settable): adds a clock-relative "not too far in
 * the past" guard on top of the structural schema above. Never used to
 * parse a stored rule (a rule anchored long ago must still parse fine).
 */
export const recurrenceRuleInputSchema = recurrenceRuleSchema.superRefine((rule, ctx) => {
  if (new Date(rule.startAt).getTime() < Date.now() - MAX_RECURRENCE_BACKDATE_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "startAt can't be more than 24 hours in the past.",
      path: ["startAt"],
    });
  }
});

/**
 * Tolerant narrowing of the raw Json column: returns null on unparseable or
 * legacy data rather than throwing (precedent: custom-fields.service.ts's
 * toOptionsArray). Callers must treat a null return as "not actually
 * recurring" and, where relevant, self-heal (see recurrence.service.ts).
 */
export function parseRecurrenceRule(raw: unknown): RecurrenceRule | null {
  const parsed = recurrenceRuleSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Computes the Nth occurrence (0-based; index 0 === startAt) of `rule`. Pure
 * and ALWAYS anchored to `startAt` — never computed relative to the
 * previous occurrence — which is what avoids schedule drift when a poll
 * tick runs late, and what makes monthly end-of-month clamping correct
 * (e.g. Jan 31 -> Feb 28 -> Mar 31, never Jan 31 -> Feb 28 -> Mar 28). All
 * arithmetic is UTC (v1 is deliberately timezone-less; see docs below).
 */
export function occurrenceAt(rule: RecurrenceRule, index: number): Date {
  const start = new Date(rule.startAt);
  if (rule.freq === "daily") return new Date(start.getTime() + index * rule.interval * 86_400_000);
  if (rule.freq === "weekly") return new Date(start.getTime() + index * rule.interval * 7 * 86_400_000);
  const monthsToAdd = index * rule.interval;
  const targetMonth = start.getUTCMonth() + monthsToAdd;
  const targetYear = start.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(start.getUTCDate(), lastDayOfTargetMonth);
  return new Date(
    Date.UTC(
      targetYear,
      normalizedMonth,
      clampedDay,
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds(),
    ),
  );
}

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Shared in-process scheduler — the FIRST scheduled/polling infrastructure
 * in this codebase. This module owns exactly two concerns: a single
 * `setInterval` heartbeat that fans out to zero or more registered
 * "handlers" every tick, and a tiny atomic-claim helper (`claimOne`) that
 * future handlers use to safely take ownership of a due row when this
 * process is running as one of several `api` replicas. Nothing else.
 *
 * (a) Why `setInterval`, not a queue library. ProjectHub is a single
 * self-hosted `api` service (see docker-compose.yml) — there is no separate
 * worker process, no message broker beyond the Redis instance already used
 * for rate-limiting/Socket.IO fan-out, and no product requirement (yet) for
 * cross-process job distribution, retries-with-backoff, or a job UI. Pulling
 * in BullMQ/agenda/node-cron for that would mean running (and operating,
 * and self-hosting-documenting) infrastructure that has no motivating use
 * case. A plain `setInterval` heartbeat, guarded by the atomic-claim
 * contract below, gets every property this codebase actually needs today:
 * periodic work, safe under N redundant replicas, zero new dependencies.
 * If a future requirement genuinely needs distributed scheduling (e.g. a
 * dedicated worker fleet), that's a new architectural decision to make
 * then — not something to speculatively build now.
 *
 * (b) The atomic-claim contract. Every "claim" of a due row MUST be a
 * single Prisma `updateMany` whose `where` clause encodes BOTH the row's
 * identity (e.g. `id: someId`) AND the not-yet-claimed/is-due condition
 * (e.g. `usedAt: null`, `runAt: { lte: now }`) in the same statement, so
 * the database itself — not this process — decides who wins. This matters
 * because ProjectHub can run multiple `api` replicas behind a load
 * balancer, all polling on the same interval against the same Postgres.
 * SELECT-then-UPDATE (read a row, decide in JS that it "looks" unclaimed,
 * then issue an UPDATE by id) is unsafe under that topology: two replicas
 * can both SELECT the same unclaimed row in the same instant, both decide
 * it's theirs, and both UPDATE it — there is no atomicity between the read
 * and the write. A single conditional `updateMany` has no such gap: Postgres
 * evaluates the WHERE clause and applies the UPDATE as one atomic
 * operation, so only one concurrent statement can ever affect that row; the
 * loser's `count` is simply 0. See `claimOne` below for the exact shape.
 *
 * (c) Security warning — handlers run as the system, not as a user.
 * `ScheduledPollHandler.run` is invoked directly by this module's internal
 * timer, completely outside Fastify's request pipeline: there is no
 * `req.ctx`, no session, no RBAC guard, nothing. Every handler is
 * responsible for scoping its own Prisma queries explicitly (e.g. by
 * iterating exactly the rows its own `where` clause names) and must NEVER
 * call into service functions, route handlers, or serializers that assume
 * they're already being invoked by an authenticated, authorized caller —
 * doing so would silently skip every permission check those functions
 * normally rely on their caller (a Fastify route) to have already performed.
 *
 * (d) Why the interval timer is deliberately NOT `.unref()`'d. An
 * un-refed timer lets Node exit even while the interval is still pending,
 * which would quietly paper over a forgotten `onClose` teardown (the
 * process — or a test's `vitest run` — would just exit "successfully" with
 * the scheduler secretly still running until the interval fired again into
 * a torn-down app). Leaving it ref'd means a leaked scheduler manifests
 * loudly, as a process/test-suite that never exits, which is a bug you
 * cannot fail to notice.
 *
 * (e) Explicit non-goals. No retries, backoff, or dead-lettering — a
 * handler that throws just gets logged and tried again next tick (see
 * `Scheduler.poll`'s per-handler try/catch). No Redis-based leader election
 * or distributed lock — multi-replica correctness comes entirely from the
 * atomic claim in (b); N replicas simply means N× redundant polling work
 * (cheap: a handful of `updateMany`/`findMany` calls every few seconds),
 * which is acceptable and correct, not a bug to engineer away. No job/queue
 * table — nothing here is persisted or enqueued; a handler decides what's
 * "due" by querying its own domain rows directly (e.g. `dueDate <= now`).
 */

export interface PollContext {
  now: Date;
  instanceId: string;
}

export interface ScheduledPollHandler {
  name: string;
  run: (ctx: PollContext) => Promise<void>;
}

export interface SchedulerOptions {
  intervalMs?: number;
  handlers?: ScheduledPollHandler[];
}

export class Scheduler {
  readonly instanceId = crypto.randomUUID();
  readonly intervalMs: number;
  private readonly handlers: ScheduledPollHandler[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private polls = 0;

  constructor(options: SchedulerOptions = {}) {
    this.intervalMs = options.intervalMs ?? env.SCHEDULER_POLL_INTERVAL_MS;
    for (const handler of options.handlers ?? []) this.register(handler);
  }

  get pollCount(): number {
    return this.polls;
  }

  get handlerNames(): readonly string[] {
    return this.handlers.map((h) => h.name);
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  register(handler: ScheduledPollHandler): void {
    if (this.stopped) throw new Error(`Cannot register "${handler.name}" on a stopped Scheduler.`);
    if (this.handlers.some((h) => h.name === handler.name)) {
      throw new Error(`A scheduler handler named "${handler.name}" is already registered.`);
    }
    this.handlers.push(handler);
  }

  start(): void {
    if (this.stopped || this.timer) return;
    // Deliberately NOT unref()'d: an un-cleared interval must keep the process
    // alive so a missing onClose teardown fails loudly (a hanging `vitest run`)
    // instead of being silently masked.
    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  async runOnce(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    this.tick();
    if (this.inFlight) await this.inFlight;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) await this.inFlight;
  }

  private tick(): void {
    if (this.stopped) return;
    if (this.inFlight) {
      logger.debug({ instanceId: this.instanceId }, "Scheduler tick skipped: previous poll still running");
      return;
    }
    const run = this.poll();
    this.inFlight = run;
    void run.finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
  }

  /** Never rejects — that is what makes `void run.finally(...)` and `await this.inFlight` safe. */
  private async poll(): Promise<void> {
    const ctx: PollContext = { now: new Date(), instanceId: this.instanceId };
    try {
      for (const handler of this.handlers) {
        try {
          await handler.run(ctx);
        } catch (err) {
          logger.error({ err, handler: handler.name, instanceId: this.instanceId }, "Scheduler handler failed");
        }
      }
    } catch (err) {
      logger.error({ err, instanceId: this.instanceId }, "Scheduler poll failed");
    }
    this.polls += 1;
  }
}

let scheduler: Scheduler | null = null;

/**
 * Initializes the shared scheduler on top of `app`, starts its interval
 * immediately, and registers an `onClose` hook that stops it (mirroring the
 * existing `initRealtime(app)` precedent in realtime/realtime.ts). Only
 * nulls the module-level singleton if it still points at the instance being
 * torn down, so closing one app instance can never blank a different,
 * already-newer instance's slot (relevant in tests, where several
 * `buildServer()`/`app.close()` cycles can happen within one process).
 */
export function initScheduler(app: FastifyInstance, options: SchedulerOptions = {}): Scheduler {
  const instance = new Scheduler(options);
  scheduler = instance;
  instance.start();
  logger.info(
    { instanceId: instance.instanceId, intervalMs: instance.intervalMs, handlers: instance.handlerNames },
    "Scheduler started",
  );
  app.addHook("onClose", async () => {
    await instance.stop();
    if (scheduler === instance) scheduler = null;
  });
  return instance;
}

/** Returns the shared Scheduler instance, or null if not initialized (e.g. some unit tests). */
export function getScheduler(): Scheduler | null {
  return scheduler;
}

/**
 * The ONLY sanctioned way for a scheduler handler to take ownership of a
 * due row. `update` must be a single Prisma `updateMany` call whose `where`
 * includes BOTH the target row's identity AND the conditions that make it
 * eligible (not already claimed, and due), e.g.:
 *
 *   claimOne(() =>
 *     prisma.someModel.updateMany({
 *       where: { id, claimedAt: null, runAt: { lte: ctx.now } },
 *       data: { claimedAt: ctx.now, claimedBy: ctx.instanceId },
 *     }),
 *   );
 *
 * Returns `true` if this call won the claim (exactly one row matched and
 * was updated), `false` if it lost (zero rows matched — already claimed by
 * another replica's concurrent poll, or no longer due).
 *
 * NEVER read the row first, decide in application code that it "looks"
 * unclaimed, and only then issue an `updateMany`/`update` by id — two
 * replicas polling concurrently would both pass that in-JS check before
 * either one has written anything, and both would then "win". A `findMany`
 * beforehand is fine as a hint about *which* ids might be worth attempting
 * a claim on, but it must never be treated as the authority on whether a
 * row is actually claimable — only the atomic `updateMany`'s `count` is.
 *
 * (Not implemented here, and intentionally out of scope: a batch variant
 * that stamps `claimedBy` across every due row in one `updateMany` and then
 * reads the winners back with a `findMany`, needed because Prisma's
 * `updateMany` has no `RETURNING`. That requires a `claimedBy` column on
 * the consumer's own model, which is a per-consumer schema decision for
 * whichever feature needs it, not something this model-agnostic helper can
 * decide on a caller's behalf.)
 */
export async function claimOne(update: () => Promise<{ count: number }>): Promise<boolean> {
  const { count } = await update();
  if (count > 1) {
    throw new Error(
      `claimOne matched ${count} rows; a claim's where clause must identify at most one row ` +
        `(key it on the row's id together with the unclaimed/due conditions).`,
    );
  }
  return count === 1;
}

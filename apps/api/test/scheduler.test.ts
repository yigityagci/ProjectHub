import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/core/prisma.js";
import { Scheduler, initScheduler, getScheduler, claimOne } from "../src/core/scheduler.js";
import { createTestApp, resetDatabase, closeTestApp, disconnectAll } from "./helpers.js";

/**
 * Bounded-wait helper: the primary synchronization mechanism used below.
 * Fixed-duration sleeps are only used to assert that nothing FURTHER
 * happened during a window (e.g. "the counter stayed frozen after stop()").
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000, intervalMs = 5): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: timed out waiting for condition");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function createFixtureUser(emailPrefix: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${emailPrefix}-${crypto.randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
      displayName: "Scheduler Fixture User",
    },
  });
  return user.id;
}

describe("core/scheduler.ts", () => {
  describe("claimOne — atomic claim under real Postgres concurrency", () => {
    // The claim helper is model-agnostic: it just wraps a caller-supplied
    // `updateMany`. Rather than inventing a speculative new table/model
    // purely for this test, these tests reuse the EXISTING
    // PasswordResetToken model, which already has exactly the shape a claim
    // needs — a due-timestamp (`expiresAt`) and a nullable claim-marker
    // (`usedAt`) — with no schema change and no migration required.
    let app: FastifyInstance;
    let userId: string;

    beforeAll(async () => {
      app = await createTestApp();
      await resetDatabase();
      userId = await createFixtureUser("claim-owner");
    });

    afterAll(async () => {
      await closeTestApp(app);
      await disconnectAll();
    });

    it("exactly one winner among 5 concurrent claims on the same due row", async () => {
      const now = new Date();
      const past = new Date(now.getTime() - 60_000);
      const row = await prisma.passwordResetToken.create({
        data: {
          userId,
          tokenHash: crypto.randomBytes(32).toString("hex"),
          expiresAt: past,
          usedAt: null,
        },
      });

      const claim = () =>
        claimOne(() =>
          prisma.passwordResetToken.updateMany({
            where: { id: row.id, usedAt: null, expiresAt: { lte: now } },
            data: { usedAt: now },
          }),
        );

      // Genuinely concurrent: 5 separate in-flight calls fired together via
      // Promise.all, not a sequential loop with awaits in between.
      const results = await Promise.all([claim(), claim(), claim(), claim(), claim()]);

      const winners = results.filter((r) => r === true);
      const losers = results.filter((r) => r === false);
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(4);

      const updated = await prisma.passwordResetToken.findUniqueOrThrow({ where: { id: row.id } });
      expect(updated.usedAt).not.toBeNull();
    });

    it("a subsequent sequential claim attempt on an already-claimed row returns false", async () => {
      const now = new Date();
      const past = new Date(now.getTime() - 60_000);
      const row = await prisma.passwordResetToken.create({
        data: {
          userId,
          tokenHash: crypto.randomBytes(32).toString("hex"),
          expiresAt: past,
          usedAt: now, // already claimed
        },
      });

      const won = await claimOne(() =>
        prisma.passwordResetToken.updateMany({
          where: { id: row.id, usedAt: null, expiresAt: { lte: now } },
          data: { usedAt: now },
        }),
      );

      expect(won).toBe(false);
    });

    it("a row that is not yet due (expiresAt in the future) is not claimable", async () => {
      const now = new Date();
      const future = new Date(now.getTime() + 60_000);
      const row = await prisma.passwordResetToken.create({
        data: {
          userId,
          tokenHash: crypto.randomBytes(32).toString("hex"),
          expiresAt: future,
          usedAt: null,
        },
      });

      const won = await claimOne(() =>
        prisma.passwordResetToken.updateMany({
          where: { id: row.id, usedAt: null, expiresAt: { lte: now } },
          data: { usedAt: now },
        }),
      );

      expect(won).toBe(false);
      const after = await prisma.passwordResetToken.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.usedAt).toBeNull();
    });

    it("guardrail: a where clause matching more than one row rejects with a count-mentioning error", async () => {
      const now = new Date();
      const past = new Date(now.getTime() - 60_000);
      await prisma.passwordResetToken.create({
        data: { userId, tokenHash: crypto.randomBytes(32).toString("hex"), expiresAt: past, usedAt: null },
      });
      await prisma.passwordResetToken.create({
        data: { userId, tokenHash: crypto.randomBytes(32).toString("hex"), expiresAt: past, usedAt: null },
      });

      await expect(
        claimOne(() =>
          // Deliberately non-unique: matches every due, unclaimed row for
          // this user rather than a single row by id.
          prisma.passwordResetToken.updateMany({
            where: { userId, usedAt: null, expiresAt: { lte: now } },
            data: { usedAt: now },
          }),
        ),
      ).rejects.toThrow(/matched 2 rows/);
    });
  });

  describe("Scheduler — poller fires on its interval and invokes handlers", () => {
    it("standalone scheduler ticks repeatedly and pollCount tracks it", async () => {
      let calls = 0;
      const scheduler = new Scheduler({
        intervalMs: 20,
        handlers: [{ name: "counter", run: async () => { calls++; } }],
      });
      scheduler.start();
      try {
        await waitUntil(() => calls >= 3);
        expect(scheduler.pollCount).toBeGreaterThanOrEqual(3);
      } finally {
        await scheduler.stop();
      }
    });

    it("end-to-end poller -> claim -> effect: only the due row gets claimed, exactly once", async () => {
      const app = await createTestApp();
      await resetDatabase();
      const userId = await createFixtureUser("e2e");

      const past = new Date(Date.now() - 60_000);
      const future = new Date(Date.now() + 60_000);
      const dueRow = await prisma.passwordResetToken.create({
        data: { userId, tokenHash: crypto.randomBytes(32).toString("hex"), expiresAt: past, usedAt: null },
      });
      const futureRow = await prisma.passwordResetToken.create({
        data: { userId, tokenHash: crypto.randomBytes(32).toString("hex"), expiresAt: future, usedAt: null },
      });

      let wonCount = 0;
      let dueRowWon = false;
      const scheduler = new Scheduler({
        intervalMs: 20,
        handlers: [
          {
            name: "reset-token-reaper",
            run: async (ctx) => {
              // A findMany here is only a hint about which ids might be
              // worth attempting a claim on — never the authority; the
              // authority is claimOne's atomic updateMany below.
              const candidates = await prisma.passwordResetToken.findMany({
                where: { usedAt: null, expiresAt: { lte: ctx.now } },
                select: { id: true },
              });
              for (const candidate of candidates) {
                const won = await claimOne(() =>
                  prisma.passwordResetToken.updateMany({
                    where: { id: candidate.id, usedAt: null, expiresAt: { lte: ctx.now } },
                    data: { usedAt: ctx.now },
                  }),
                );
                if (won) {
                  wonCount++;
                  if (candidate.id === dueRow.id) dueRowWon = true;
                }
              }
            },
          },
        ],
      });

      try {
        scheduler.start();
        await waitUntil(() => dueRowWon);

        // Give a few more ticks a chance to run, to prove it isn't re-claimed.
        await sleep(150);

        const finalDue = await prisma.passwordResetToken.findUniqueOrThrow({ where: { id: dueRow.id } });
        expect(finalDue.usedAt).not.toBeNull();

        const finalFuture = await prisma.passwordResetToken.findUniqueOrThrow({ where: { id: futureRow.id } });
        expect(finalFuture.usedAt).toBeNull();

        expect(wonCount).toBe(1);
      } finally {
        await scheduler.stop();
        await closeTestApp(app);
        await disconnectAll();
      }
    });

    it("the buildServer()-created scheduler is genuinely live end to end", async () => {
      const app = await createTestApp({ startScheduler: true });
      try {
        const live = getScheduler();
        expect(live).not.toBeNull();

        let count = 0;
        live!.register({ name: "live-counter", run: async () => { count++; } });

        await waitUntil(() => count > 0);
      } finally {
        await closeTestApp(app);
      }
    });

    it("does not run overlapping ticks even when a handler outlasts the interval", async () => {
      let inside = 0;
      let maxInside = 0;
      const scheduler = new Scheduler({
        intervalMs: 20,
        handlers: [
          {
            name: "slow",
            run: async () => {
              inside++;
              maxInside = Math.max(maxInside, inside);
              await sleep(200);
              inside--;
            },
          },
        ],
      });

      scheduler.start();
      try {
        await sleep(500);
      } finally {
        await scheduler.stop();
      }
      expect(maxInside).toBe(1);
    });

    it("one handler throwing does not stop a later handler or halt polling", async () => {
      let secondRuns = 0;
      const scheduler = new Scheduler({
        intervalMs: 20,
        handlers: [
          {
            name: "always-throws",
            run: async () => {
              throw new Error("boom");
            },
          },
          {
            name: "still-runs",
            run: async () => {
              secondRuns++;
            },
          },
        ],
      });

      scheduler.start();
      try {
        await waitUntil(() => secondRuns >= 3);
        expect(scheduler.pollCount).toBeGreaterThanOrEqual(3);
      } finally {
        await scheduler.stop();
      }
    });

    it("registering a duplicate handler name throws", () => {
      const scheduler = new Scheduler({ intervalMs: 1000 });
      scheduler.register({ name: "dup", run: async () => {} });
      expect(() => scheduler.register({ name: "dup", run: async () => {} })).toThrow(/already registered/);
    });
  });

  describe("onClose teardown actually stops the interval", () => {
    it("closing the app stops the scheduler for good", async () => {
      const app = await createTestApp({ startScheduler: true });
      const s = getScheduler()!;
      expect(s).toBeTruthy();

      let count = 0;
      s.register({ name: "teardown-counter", run: async () => { count++; } });
      await waitUntil(() => count > 0);

      await closeTestApp(app);

      expect(getScheduler()).toBeNull();

      const frozenCount = count;
      const frozenPollCount = s.pollCount;
      await sleep(250);

      expect(count).toBe(frozenCount);
      expect(s.pollCount).toBe(frozenPollCount);
      expect(s.isRunning).toBe(false);

      await s.runOnce();
      expect(count).toBe(frozenCount);
    });
  });

  describe("two buildServer()/app.close() cycles leak no timer", () => {
    it("neither cycle leaves a running interval behind", async () => {
      const activeTimersBefore = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

      // Cycle 1.
      const app1 = await createTestApp({ startScheduler: true });
      let count1 = 0;
      getScheduler()!.register({ name: "cycle-1-counter", run: async () => { count1++; } });
      await waitUntil(() => count1 > 0);
      await closeTestApp(app1);
      const frozenCount1 = count1;
      await sleep(150);
      expect(count1).toBe(frozenCount1);

      // Cycle 2 (fresh app/scheduler — sequential, never overlapping with
      // cycle 1's already-closed instance; safe under this file's
      // fileParallelism:false + per-file module isolation, per
      // vitest.config.ts).
      const app2 = await createTestApp({ startScheduler: true });
      let count2 = 0;
      getScheduler()!.register({ name: "cycle-2-counter", run: async () => { count2++; } });
      await waitUntil(() => count2 > 0);
      await closeTestApp(app2);
      const frozenCount2 = count2;
      await sleep(150);
      expect(count2).toBe(frozenCount2);

      expect(getScheduler()).toBeNull();

      // A delta comparison, not an absolute one: Vitest itself holds some
      // timers, so only assert no NET growth in active Timeout handles
      // across the two full create/close cycles.
      const activeTimersAfter = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
      expect(activeTimersAfter).not.toBeGreaterThan(activeTimersBefore);

      // The strongest form of this assertion is at the whole-suite level:
      // if the scheduler's interval ever leaked past onClose, `vitest run`
      // for this file (and the full suite) would hang and never exit. This
      // file/suite exiting cleanly on its own (no --forceExit needed) is
      // itself evidence the interval was properly cleared.
    });
  });
});

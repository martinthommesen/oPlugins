import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Function as Fn,
  Layer,
  MutableRef,
  Option,
} from "effect"
import { expect, it } from "@effect/vitest"
import type { Scope } from "effect"
import SidebarWatcher from "./sidebar-sync.ts"
import { TestClock } from "effect/testing"

type Controls = Parameters<typeof SidebarWatcher.start>[typeof FIRST]

type Connection = Controls["connection"]

const FIRST = 0,
  ONE_WARNING = 1,
  connection = (read: Effect.Effect<boolean, "unanswered">): Connection => ({
    client: {
      events: { on: () => Fn.constVoid },
      report: (): PromiseLike<{ readonly subscriptions: readonly never[] }> =>
        Effect.runPromise(Effect.succeed({ subscriptions: [] })),
      setSidebar: ({ shown }): PromiseLike<{ readonly shown: boolean }> =>
        Effect.runPromise(Effect.succeed({ shown })),
      sidebar: (_input, options): PromiseLike<{ readonly shown: boolean }> =>
        Effect.runPromise(read.pipe(Effect.map((shown) => ({ shown }))), {
          signal: options.signal,
        }),
    },
    location: { directory: "/work" },
  }),
  initially = (
    read: Effect.Effect<boolean>,
    next: Effect.Effect<boolean> = Effect.succeed(true),
  ): Effect.Effect<boolean> => {
    const first = MutableRef.make(true)

    return Effect.suspend(() => {
      if (MutableRef.getAndSet(first, false)) {
        return read
      }

      return next
    })
  },
  subjectFor = (
    controls: Controls,
  ): Effect.Effect<SidebarWatcher["Service"], never, Scope.Scope> =>
    Layer.build(SidebarWatcher.layer(controls)).pipe(
      Effect.map((context) => Context.get(context, SidebarWatcher)),
    )

it.effect(
  "rereads storage while hidden to recover missed or reordered events",
  () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const captured = MutableRef.make<readonly boolean[]>([]),
        stored = MutableRef.make(false),
        subject = yield* subjectFor({
          apply: (shown) => {
            MutableRef.update(captured, (values) => [...values, shown])
          },
          connection: connection(Effect.sync(() => MutableRef.get(stored))),
          warn: Fn.constVoid,
        })

      yield* subject.refresh
      MutableRef.set(stored, true)
      yield* TestClock.adjust("1 minute")
      yield* subject.refresh
      MutableRef.set(stored, false)
      yield* subject.refresh
      yield* subject.refresh
      expect(MutableRef.get(captured)).toStrictEqual([
        false,
        true,
        true,
        false,
        false,
      ])
    }).pipe(Effect.scoped),
)

it.effect(
  "ignores a superseded read and makes both waiters await current storage",
  () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const captured = MutableRef.make<readonly boolean[]>([]),
        finished = MutableRef.make(false),
        nextReady = yield* Deferred.make<boolean>(),
        nextRelease = yield* Deferred.make<boolean>(),
        nextResponse = Deferred.succeed(nextReady, true).pipe(
          Effect.andThen(Deferred.await(nextRelease)),
        ),
        ready = yield* Deferred.make<boolean>(),
        release = yield* Deferred.make<boolean>(),
        response = Deferred.succeed(ready, true).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
        script = initially(response, nextResponse),
        service = yield* subjectFor({
          apply: (shown) => {
            MutableRef.update(captured, (values) => [...values, shown])
          },
          connection: connection(script),
          warn: Fn.constVoid,
        }),
        settled = service.refresh.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              MutableRef.set(finished, true)
            }),
          ),
        ),
        task = yield* Effect.forkChild(settled).pipe(
          Effect.tap(() => Deferred.await(ready)),
        ),
        trailing = yield* Effect.forkChild(service.refresh, {
          startImmediately: true,
        })

      yield* Deferred.await(nextReady)
      expect(MutableRef.get(finished)).toBe(false)
      yield* Deferred.succeed(release, false)
      yield* Deferred.succeed(nextRelease, true)
      yield* Fiber.join(task)
      yield* Fiber.join(trailing)
      expect(MutableRef.get(captured)).not.toContain(false)
      expect(MutableRef.get(captured)).toContain(true)
    }).pipe(Effect.scoped),
)

it.effect("aborts the pending request when the owner scope closes", () =>
  Effect.gen(function* run() {
    expect.hasAssertions()

    const cancelled = yield* Deferred.make<boolean>(),
      captured = MutableRef.make(Option.none<boolean>()),
      ready = yield* Deferred.make<boolean>(),
      response = Deferred.succeed(ready, true).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Deferred.succeed(cancelled, true)),
      ),
      subject = subjectFor({
        apply: (shown) => {
          MutableRef.set(captured, Option.some(shown))
        },
        connection: connection(response),
        warn: Fn.constVoid,
      }).pipe(
        Effect.flatMap((watcher) => watcher.refresh),
        Effect.scoped,
      ),
      task = yield* Effect.forkChild(subject)

    yield* Deferred.await(ready)
    yield* Fiber.interrupt(task)
    expect(yield* Deferred.await(cancelled)).toBe(true)
    expect(MutableRef.get(captured)).toStrictEqual(Option.none())
  }),
)

it.effect(
  "reaches retry exhaustion without polling restarting the retry sequence",
  () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const applied = MutableRef.make<readonly boolean[]>([]),
        captured = MutableRef.make<readonly string[]>([]),
        subject = yield* subjectFor({
          apply: (shown) => {
            MutableRef.update(applied, (values) => [...values, shown])
          },
          connection: connection(Effect.fail("unanswered")),
          warn: (message) => {
            MutableRef.update(captured, (values) => [...values, message])
          },
        }),
        task = yield* Effect.forkChild(subject.follow)

      yield* TestClock.adjust("2 minutes")
      yield* Fiber.join(task)
      expect(MutableRef.get(captured)).toHaveLength(ONE_WARNING)
      expect(MutableRef.get(applied)).toStrictEqual([false])
    }).pipe(Effect.scoped),
)

it.effect(
  "aborts a caller's reconciliation without closing the watcher or leaving its permit held",
  () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const cancelled = yield* Deferred.make<boolean>(),
        captured = MutableRef.make<readonly boolean[]>([]),
        ready = yield* Deferred.make<boolean>(),
        response = Deferred.succeed(ready, true).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cancelled, true)),
        ),
        subject = yield* subjectFor({
          apply: (shown) => {
            MutableRef.update(captured, (values) => [...values, shown])
          },
          connection: response.pipe(initially, connection),
          warn: Fn.constVoid,
        }),
        task = yield* Effect.forkChild(subject.refresh)

      yield* Deferred.await(ready)
      yield* Fiber.interrupt(task)
      expect(yield* Deferred.await(cancelled)).toBe(true)
      yield* subject.refresh
      expect(MutableRef.get(captured)).toStrictEqual([true])
    }).pipe(Effect.scoped),
)

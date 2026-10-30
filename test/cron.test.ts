import assert from "node:assert/strict"
import test from "node:test"

import { nextCronOccurrence, parseCron } from "../index.ts"

// Date.UTC months are 0-based in these tests.
const utc = (...args: [number, number, number, number, number]) => Date.UTC(...args)
const next = (expr: string, after: number, tz?: string) => nextCronOccurrence(parseCron(expr), after, tz)

test("daily 08:20 in Europe/Rome (winter, UTC+1)", () => {
  const after = utc(2026, 9, 29, 12, 0) // Thu 29 Oct 2026 12:00Z
  assert.equal(next("20 8 * * *", after, "Europe/Rome"), utc(2026, 9, 30, 7, 20))
})

test("weekly Monday 08:20 in Europe/Rome", () => {
  const after = utc(2026, 9, 29, 12, 0)
  assert.equal(next("20 8 * * 1", after, "Europe/Rome"), utc(2026, 10, 2, 7, 20)) // Mon 2 Nov 08:20 CET
})

test("weekday name range mon-fri", () => {
  const after = utc(2026, 9, 30, 12, 0) // Friday noon
  assert.equal(next("0 9 * * mon-fri", after, "Europe/Rome"), utc(2026, 10, 2, 8, 0))
})

test("first of the month at 03:00", () => {
  const after = utc(2026, 9, 29, 12, 0)
  assert.equal(next("0 3 1 * *", after, "Europe/Rome"), utc(2026, 10, 1, 2, 0))
})

test("day-of-month OR day-of-week when both are restricted", () => {
  // Matches the 1st of any month or any Monday.
  assert.equal(next("0 0 1 * 1", utc(2026, 9, 29, 12, 0), "Europe/Rome"), utc(2026, 9, 31, 23, 0)) // Sun 1 Nov 00:00
  assert.equal(next("0 0 1 * 1", utc(2026, 10, 1, 12, 0), "Europe/Rome"), utc(2026, 10, 1, 23, 0)) // Mon 2 Nov 00:00
})

test("explicit timezone (America/New_York)", () => {
  assert.equal(next("0 9 * * *", utc(2026, 10, 5, 0, 0), "America/New_York"), utc(2026, 10, 5, 14, 0))
})

test("DST spring-forward gap is skipped", () => {
  // Europe/Rome, 28 Mar 2027: 02:00 -> 03:00, so 02:30 does not exist that day.
  const after = utc(2027, 2, 27, 12, 0)
  assert.equal(next("30 2 * * *", after, "Europe/Rome"), utc(2027, 2, 29, 0, 30)) // 29 Mar 02:30 CEST
})

test("DST fall-back fires exactly once per day", () => {
  const first = next("30 2 * * *", utc(2027, 9, 30, 12, 0), "Europe/Rome")
  assert.equal(first, utc(2027, 9, 31, 1, 30)) // 31 Oct 02:30 CET (second pass)
  assert.equal(next("30 2 * * *", first, "Europe/Rome"), utc(2027, 10, 1, 1, 30))
})

test("steps", () => {
  assert.equal(next("*/15 * * * *", utc(2026, 9, 30, 10, 7), "UTC"), utc(2026, 9, 30, 10, 15))
})

test("invalid expressions are rejected", () => {
  assert.throws(() => parseCron("60 * * * *"))
  assert.throws(() => parseCron("* * * *"))
  assert.throws(() => parseCron("0 0 32 * *"))
  assert.throws(() => parseCron("*/0 * * * *"))
})

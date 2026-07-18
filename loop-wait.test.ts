// Unit tests for the review WAIT-step decision (pure). Run: node loop-wait.test.ts
import assert from "node:assert/strict";
import { waitAction } from "./control.ts";

let passed = 0;
const check = (name: string, cond: boolean) => { assert.ok(cond, name); passed++; console.log(`  ✓ ${name}`); };
const NOW = 1_000_000;
const DL_FUTURE = NOW + 600_000;
const DL_PAST = NOW - 1;

console.log("waitAction — three-way branch + precedence:");
check("idle, before deadline → wait",
  waitAction(false, DL_FUTURE, NOW) === "wait");
check("idle, no deadline set → wait",
  waitAction(false, null, NOW) === "wait");
check("idle, past deadline → timeout",
  waitAction(false, DL_PAST, NOW) === "timeout");
check("fetch requested, before deadline → recheck",
  waitAction(true, DL_FUTURE, NOW) === "recheck");
check("fetch requested, NO deadline → recheck",
  waitAction(true, null, NOW) === "recheck");
check("precedence: fetch preempts an elapsed deadline (recheck, not timeout)",
  waitAction(true, DL_PAST, NOW) === "recheck");

console.log(`\nALL ${passed} CHECKS PASSED`);

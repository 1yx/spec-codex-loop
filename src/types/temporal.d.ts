// Node 26+ ships Temporal natively at runtime, but TypeScript does not yet
// include Temporal types. Bridge the polyfill's types to the global so
// `Temporal.Now.instant()` type-checks with zero runtime cost (no import).
// When TypeScript ships native Temporal types, delete this file and drop the
// @js-temporal/polyfill dev dependency.
import type { Temporal as TemporalType } from "@js-temporal/polyfill";

declare global {
  const Temporal: typeof TemporalType;
}

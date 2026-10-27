import type { MeasuredTotal } from '@semevolve/policy';
import { syntheticId } from '../support/synthetic.js';

const completeZero = { kind: 'complete', total: 0 } satisfies MeasuredTotal;
const complete = { kind: 'complete', total: 12 } satisfies MeasuredTotal;
const partial = {
  kind: 'partial', knownSubtotal: 7,
  missingInvocationIds: [syntheticId('invocation'), syntheticId('invocation')],
} satisfies MeasuredTotal;
const allMissing = {
  kind: 'partial', knownSubtotal: 0, missingInvocationIds: [syntheticId('invocation')],
} satisfies MeasuredTotal;

export function narrowedTotal(measurement: MeasuredTotal): number | null {
  if (measurement.kind === 'complete') {
    const total: number = measurement.total;
    return total;
  }
  const missingInvocation: typeof partial.missingInvocationIds[number] = measurement.missingInvocationIds[0];
  const knownSubtotal: number = measurement.knownSubtotal;
  void [missingInvocation, knownSubtotal];
  // @ts-expect-error A partial measurement cannot provide a complete numeric total.
  const total: number = measurement.total;
  void total;
  return null;
}

export function rejectIncompleteTotals() {
  // @ts-expect-error The previous untagged shape permits missing measurements with a numeric total.
  const legacy: MeasuredTotal = { knownSubtotal: 0, missingCount: 3, total: 0 };
  // @ts-expect-error A partial measurement cannot carry a numeric total.
  const fabricatedTotal: MeasuredTotal = { ...partial, total: 7 };
  // @ts-expect-error A partial measurement cannot carry a total through a non-literal value either.
  const widenedTotal: MeasuredTotal = Object.assign({}, partial, { total: 7 });
  // @ts-expect-error A complete measurement must have a numeric total.
  const nullTotal: MeasuredTotal = { kind: 'complete', total: null };
  // @ts-expect-error A complete measurement cannot declare missing invocations.
  const missingComplete: MeasuredTotal = { ...complete, missingInvocationIds: [syntheticId('invocation')] };
  // @ts-expect-error A complete measurement cannot carry missing invocations through structural assignment.
  const widenedComplete: MeasuredTotal = Object.assign({}, complete, { missingInvocationIds: [syntheticId('invocation')] });
  // @ts-expect-error A partial measurement must identify at least one missing invocation.
  const emptyMissing: MeasuredTotal = { kind: 'partial', knownSubtotal: 7, missingInvocationIds: [] };
  // @ts-expect-error A count alone does not identify the missing measurements.
  const countOnly: MeasuredTotal = { kind: 'partial', knownSubtotal: 7, missingCount: 1 };
  // @ts-expect-error Missing measurements must refer to invocations rather than messages.
  const wrongIdentity: MeasuredTotal = { kind: 'partial', knownSubtotal: 7, missingInvocationIds: [syntheticId('message')] };
  // @ts-expect-error A partial measurement still requires its known subtotal.
  const noSubtotal: MeasuredTotal = { kind: 'partial', missingInvocationIds: [syntheticId('invocation')] };
  void [legacy, fabricatedTotal, widenedTotal, nullTotal, missingComplete, widenedComplete, emptyMissing,
    countOnly, wrongIdentity, noSubtotal, completeZero, allMissing];
}

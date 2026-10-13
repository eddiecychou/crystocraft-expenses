import test from 'node:test'
import assert from 'node:assert/strict'
import { checkArithmetic } from '../netlify/edge-functions/process-receipt.js'

test('includes a separately printed service charge once', () => {
  assert.equal(checkArithmetic({ subtotal: 250, serviceCharge: 25, tax: 0, amount: 275 }).consistent, true)
})

test('uses a printed negative adjustment without hiding other differences', () => {
  assert.equal(checkArithmetic({ subtotal: 250, serviceCharge: 25, adjustment: -0.6, amount: 274.4 }).consistent, true)
  const mismatch = checkArithmetic({ subtotal: 250, serviceCharge: 25, amount: 274.4 })
  assert.equal(mismatch.consistent, false)
  assert.ok(Math.abs(mismatch.difference + 0.6) < 0.001)
})

test('skips arithmetic when the base subtotal is uncertain', () => {
  assert.equal(checkArithmetic({ subtotal: null, serviceCharge: 25, amount: 275 }), null)
})

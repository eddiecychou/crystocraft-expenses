import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewedExclusionsMatch } from '../src/lib/duplicateDetection.js'

const row = (merchantRaw, amount = 10) => ({ transactionDate: '2026-09-16', merchantRaw, settlementAmount: amount, direction: 'debit' })

test('only a precisely reviewed missing row resolves the PDF comparison', () => {
  const saved = [row('Shop')]
  const omitted = row('Header mistaken as transaction')
  assert.equal(reviewedExclusionsMatch([saved[0], omitted], saved, [omitted]), true)
  assert.equal(reviewedExclusionsMatch([saved[0], omitted], saved, [row('Different')]), false)
  assert.equal(reviewedExclusionsMatch([saved[0], omitted], saved, []), false)
  assert.equal(reviewedExclusionsMatch([saved[0], omitted, row('Other')], saved, [omitted]), false)
  assert.equal(reviewedExclusionsMatch([saved[0]], saved, [omitted]), false)
})

test('repeated identical rows still require the right number of exclusions', () => {
  const duplicate = row('Same', 25)
  assert.equal(reviewedExclusionsMatch([duplicate, duplicate], [duplicate], [duplicate]), true)
  assert.equal(reviewedExclusionsMatch([duplicate, duplicate, duplicate], [duplicate], [duplicate]), false)
})

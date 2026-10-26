import assert from 'node:assert/strict'
import test from 'node:test'
import { requiresEmailVerification } from '../src/lib/emailVerification.js'

const passwordUser = (creationTime, emailVerified = false) => ({
  emailVerified,
  providerData: [{ providerId: 'password' }],
  metadata: { creationTime },
})

test('new password accounts must verify before using the app', () => {
  assert.equal(requiresEmailVerification(passwordUser('2026-10-26T06:31:12Z')), true)
  assert.equal(requiresEmailVerification(passwordUser('2026-10-26T06:31:12Z', true)), false)
  assert.equal(requiresEmailVerification(passwordUser(undefined)), true)
})

test('existing password accounts keep access during rollout', () => {
  assert.equal(requiresEmailVerification(passwordUser('2026-10-25T00:00:00Z')), false)
})

test('Google sign-in is not sent through password verification', () => {
  assert.equal(requiresEmailVerification({
    emailVerified: false,
    providerData: [{ providerId: 'google.com' }],
    metadata: { creationTime: '2026-10-27T00:00:00Z' },
  }), false)
  assert.equal(requiresEmailVerification(null), false)
})

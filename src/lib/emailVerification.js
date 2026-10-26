// Existing password accounts were allowed into the app without verification.
// Keep that access during rollout; accounts created after this boundary must
// prove control of their email before a project or profile is created.
const VERIFICATION_ROLLOUT_AT = Date.parse('2026-10-26T06:31:11Z')

export function requiresEmailVerification(user) {
  if (!user || user.emailVerified) return false
  if (!user.providerData?.some(provider => provider.providerId === 'password')) return false
  const createdAt = Date.parse(user.metadata?.creationTime)
  return !Number.isFinite(createdAt) || createdAt >= VERIFICATION_ROLLOUT_AT
}

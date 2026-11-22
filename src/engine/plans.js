/**
 * Plan catalog — the single source of truth for AgentPulse tiers.
 *
 * Registration always lands on `free_verified` (flat 100 counted
 * requests/day). Paid plans raise the daily quota, nothing else: every
 * tier gets the same API, the same Good Citizen rules (304s never count),
 * and the same UTC-midnight reset.
 *
 * Self-serve checkout exists when the operator configures Stripe Payment
 * Links (STRIPE_PAYMENT_LINK_PRO / STRIPE_PAYMENT_LINK_TEAM): the plan
 * endpoint then serves per-agent checkout URLs and the Stripe webhook
 * (POST /v1/billing/webhook) activates/downgrades plans automatically.
 * Without those env vars there is no checkout and paid plans are
 * activated by the operator after purchase — see the upgrade instructions
 * served by GET /v1/agents/me/plan — or granted directly via
 * PATCH /v1/admin/agents/:id, which reads tier + quota from this catalog.
 */
export const PLANS = {
  free_verified: {
    tier: 'free_verified',
    name: 'Free',
    daily_quota: 100,
    price_usd_month: 0
  },
  pro: {
    tier: 'pro',
    name: 'Pro',
    daily_quota: 10000,
    price_usd_month: 29
  },
  team: {
    tier: 'team',
    name: 'Team',
    daily_quota: 50000,
    price_usd_month: 99
  }
};

export const PLAN_TIERS = Object.keys(PLANS);

/** The plan for a tier id, or null for an unknown tier. */
export function getPlan(tier) {
  return Object.prototype.hasOwnProperty.call(PLANS, tier) ? PLANS[tier] : null;
}

/** All plans as plain objects, in catalog order (free → pro → team). */
export function listPlans() {
  return PLAN_TIERS.map(tier => ({ ...PLANS[tier] }));
}

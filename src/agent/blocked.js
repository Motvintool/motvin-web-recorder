// Detects access-control states. We never try to get past them: the branch is marked blocked.
export function detectBlocked(snapshot) {
  const s = snapshot.signals;
  if (s.captcha) return { blocked: true, kind: 'captcha', label: 'CAPTCHA / bot check' };
  if (s.otp) return { blocked: true, kind: 'otp', label: 'One-time code verification' };
  if (s.paywall) return { blocked: true, kind: 'paywall', label: 'Paywall / subscription' };
  if (s.accessDenied) return { blocked: true, kind: 'denied', label: 'Access denied' };
  if (s.login) return { blocked: true, kind: 'auth', label: 'Sign-in required', inModal: Boolean(s.passwordInModal) };
  return { blocked: false };
}

/** Elements whose activation we must never attempt automatically. */
export const DESTRUCTIVE_RE = /\b(log ?out|sign ?out|delete|remove|unsubscribe|deactivate|cancel (my )?(account|subscription|order)|buy now|pay(ment)?|checkout|purchase|place order|confirm order|subscribe now|donate|upgrade now|add to (cart|basket|bag)|buy|order now|proceed to|send|submit payment|report|block|download|install|print|share|tweet|facebook|linkedin|whatsapp|telegram|pinterest|copy link|email this|rss|accept all|allow all|cookie settings|language|english|español|français|deutsch|日本語|skip to (main )?content)\b/i;
export const AUTH_RE = /\b(sign ?in|log ?in|sign ?up|register|create (an )?account|forgot password|reset password|get started free|start free trial|join (now|free))\b/i;

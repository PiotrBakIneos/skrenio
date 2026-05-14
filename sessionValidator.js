// sessionValidator.js
// Validates session token and returns subscription status
// Used by all analysis API files

export async function validateSession(sessionToken) {
  if (!sessionToken) return { valid: false, reason: 'no_session' };
  if (!process.env.UPSTASH_REDIS_REST_URL) return { valid: false, reason: 'no_redis' };

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;

  try {
    // Get session
    const sessRes  = await fetch(`${url}/get/session:${sessionToken}`, { headers: { Authorization: `Bearer ${tok}` } });
    const sessData = await sessRes.json();
    if (!sessData.result) return { valid: false, reason: 'session_expired' };

    const { email } = JSON.parse(sessData.result);

    // Get subscription
    const subRes  = await fetch(`${url}/get/user:${encodeURIComponent(email)}`, { headers: { Authorization: `Bearer ${tok}` } });
    const subData = await subRes.json();
    if (!subData.result) return { valid: false, email, reason: 'no_subscription' };

    const sub = JSON.parse(subData.result);
    if (sub.status !== 'active') return { valid: false, email, reason: 'inactive' };

    return { valid: true, email, plan: sub.plan };
  } catch (err) {
    console.error('Session validation error:', err);
    return { valid: false, reason: 'error' };
  }
}

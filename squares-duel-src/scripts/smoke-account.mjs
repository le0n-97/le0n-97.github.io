import assert from 'node:assert/strict';

// Test credentials live only in this process. Never create fixtures on a public
// deployment or include their passwords/tokens in the smoke output.
export async function smokeAccount(base, label = 'smoke') {
  const origin = new URL(base);
  assert.ok(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
    && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash,
  'Account smoke fixtures require an HTTP loopback origin.');
  assert.match(label, /^[A-Za-z0-9_]{1,7}$/);
  const username = `${label}_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const password = `Sq!${crypto.randomUUID()}${crypto.randomUUID()}`;
  async function account(action) {
    const response = await fetch(new URL('/api/account', origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin.origin },
      body: JSON.stringify({ action, username, password }), signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    assert.equal(response.status, action === 'register' ? 201 : 200,
      `Local account ${action}: ${body.error ?? 'Unexpected response'}`);
    assert.equal(body.user.username, username);
    assert.match(body.token, /^sq_account_[0-9a-f]{64}$/);
    return body;
  }
  await account('register');
  return account('login');
}

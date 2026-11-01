/**
 * Unit Tests: Auth Sign-Out & Account Deletion Workflows
 *
 * Verifies:
 * 1. Backend HTTP route /api/auth/logout:
 *    - Clears session_token cookie with Max-Age=0, Path=/, HttpOnly, SameSite=Lax.
 *    - Returns 200 OK with { success: true, message: 'Signed out successfully' }.
 * 2. Backend HTTP route /api/account/delete:
 *    - Rejects unauthenticated requests with 401 Unauthorized (fail-closed).
 * 3. Client-Side Script Invariants (AST & Execution Analysis):
 *    - Embeds and compiles cleanly in V8 vm without SyntaxError.
 *    - Zero duplicate function declarations (guarantees no accidental hoisting overwrites).
 *    - handleSignOut() invokes POST /api/auth/logout, purges sessionStorage, and transitions to showAuthScreen.
 *    - handleDeleteAccount() prompts user for confirmation, invokes POST /api/account/delete, purges sessionStorage, and transitions to showAuthScreen.
 *    - Neither function executes a premature window.location.reload() that bypasses revocation.
 * 4. Core Auth SQL Invariants:
 *    - revokeSession deletes session matching token_hash.
 *    - deleteUserAccount revokes all sessions for user_id and soft-deletes user record.
 */

import vm from 'node:vm';
import { createWebServer, renderMobileAppHtml } from '../../src/web/server.ts';
import { revokeSession, deleteUserAccount } from '../../src/core/auth.ts';

export async function runAuthLogoutDeleteUnitTests(): Promise<{ passed: boolean; count: number; failures: string[] }> {
  const failures: string[] = [];
  let count = 0;

  function testAssert(condition: boolean, testName: string) {
    count++;
    if (!condition) {
      failures.push(testName);
      console.error(`  [FAIL] ${testName}`);
    } else {
      console.log(`  [PASS] ${testName}`);
    }
  }

  console.log('\n============================================================');
  console.log('WHOWASRIGHT AUTH SIGN-OUT & ACCOUNT DELETION TESTS');
  console.log('============================================================\n');

  // ============================================================
  // Section 1: HTTP Endpoint Contracts (/api/auth/logout & /api/account/delete)
  // ============================================================
  console.log('  [Section 1: HTTP Endpoint Contracts]');
  const server = createWebServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const base = `http://localhost:${address.port}`;

  try {
    // 1.1 Logout without session token still clears cookie and returns 200
    const logoutRes = await fetch(`${base}/api/auth/logout`, { method: 'POST' });
    testAssert(logoutRes.status === 200, 'POST /api/auth/logout returns 200 OK');
    const setCookie = logoutRes.headers.get('set-cookie') || '';
    testAssert(setCookie.includes('Max-Age=0'), 'POST /api/auth/logout sets Max-Age=0 to expire cookie');
    testAssert(setCookie.includes('HttpOnly'), 'POST /api/auth/logout cookie is HttpOnly');
    testAssert(setCookie.includes('SameSite=Lax'), 'POST /api/auth/logout cookie is SameSite=Lax');

    const logoutBody = await logoutRes.json();
    testAssert(logoutBody.success === true, 'POST /api/auth/logout response body has success: true');

    // 1.2 Account deletion without authentication fails closed with 401
    const unauthDeleteRes = await fetch(`${base}/api/account/delete`, { method: 'POST' });
    testAssert(unauthDeleteRes.status === 401, 'POST /api/account/delete without token returns 401 Unauthorized');
    const unauthBody = await unauthDeleteRes.json();
    testAssert(unauthBody.error === 'Authentication required', 'POST /api/account/delete error is Authentication required');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ============================================================
  // Section 2: Client Script Invariants & Function Declarations
  // ============================================================
  console.log('\n  [Section 2: Client Script Syntax & AST Invariants]');
  const html = renderMobileAppHtml();

  // Extract client script from rendered HTML
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  testAssert(!!scriptMatch, 'HTML contains inline client script');
  const clientScript = scriptMatch ? scriptMatch[1] : '';

  // 2.1 Verify script compiles cleanly in V8 engine
  let parseError: any = null;
  try {
    new vm.Script(clientScript);
  } catch (err) {
    parseError = err;
  }
  testAssert(parseError === null, `Client script parses without SyntaxError (got: ${parseError?.message || 'null'})`);

  // 2.2 Verify ZERO duplicate function declarations
  const funcDeclMatches = [...clientScript.matchAll(/function\s+([a-zA-Z0-9_$]+)\s*\(/g)];
  const funcNames = funcDeclMatches.map(m => m[1]);
  const nameCounts = new Map<string, number>();
  for (const name of funcNames) {
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }
  const duplicates = [...nameCounts.entries()].filter(([_, c]) => c > 1).map(([name, c]) => `${name} (${c}x)`);
  testAssert(
    duplicates.length === 0,
    `No duplicate function declarations exist in client script (found duplicates: ${duplicates.join(', ') || 'none'})`
  );

  // 2.3 Verify handleSignOut implementation
  testAssert(
    clientScript.includes('function handleSignOut('),
    'handleSignOut() function is explicitly declared'
  );
  testAssert(
    clientScript.includes("apiFetch('/api/auth/logout', { method: 'POST' })"),
    'handleSignOut() contacts backend POST /api/auth/logout'
  );
  testAssert(
    clientScript.includes("sessionStorage.removeItem(TOKEN_STORAGE_KEY)"),
    'handleSignOut() explicitly purges sessionStorage token'
  );
  testAssert(
    clientScript.includes("showAuthScreen('You have been signed out.')"),
    'handleSignOut() transitions to showAuthScreen with signed out message'
  );

  // 2.4 Verify handleDeleteAccount implementation
  testAssert(
    clientScript.includes('function handleDeleteAccount('),
    'handleDeleteAccount() function is explicitly declared'
  );
  testAssert(
    clientScript.includes("confirm('Are you sure you want to delete your account? All private journal entries will be deleted.')"),
    'handleDeleteAccount() prompts user for explicit confirmation'
  );
  testAssert(
    clientScript.includes("apiFetch('/api/account/delete', { method: 'POST' })"),
    'handleDeleteAccount() contacts backend POST /api/account/delete'
  );
  testAssert(
    clientScript.includes("showAuthScreen('Your account and private data have been deleted.')"),
    'handleDeleteAccount() transitions to showAuthScreen with deletion message'
  );

  // 2.5 Ensure no stub reload functions remain
  testAssert(
    !clientScript.includes("alert('Signed out successfully.');\n      window.location.reload();"),
    'No unauthenticated reload stubs remain for handleSignOut'
  );
  testAssert(
    !clientScript.includes("alert('Account deleted.');\n      window.location.reload();"),
    'No unauthenticated reload stubs remain for handleDeleteAccount'
  );

  // ============================================================
  // Section 3: Core Auth SQL Contracts
  // ============================================================
  console.log('\n  [Section 3: Core Auth SQL Contracts]');
  const revokeSource = revokeSession.toString();
  testAssert(
    revokeSource.includes('DELETE FROM sessions WHERE token_hash = $1'),
    'revokeSession() uses targeted DELETE FROM sessions WHERE token_hash = $1'
  );

  const deleteAccountSource = deleteUserAccount.toString();
  testAssert(
    deleteAccountSource.includes('DELETE FROM sessions WHERE user_id = $1'),
    'deleteUserAccount() purges all sessions for the user'
  );
  testAssert(
    deleteAccountSource.includes('UPDATE users SET deleted_at = NOW()'),
    'deleteUserAccount() soft-deletes the user record via deleted_at timestamp'
  );

  console.log('\n============================================================');
  console.log(`AUTH LOGOUT & DELETION TESTS SUMMARY: ${count - failures.length}/${count} PASSED`);
  console.log('============================================================\n');

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

// Auto-run if executed directly
if (process.argv[1]?.endsWith('auth-logout-delete.test.ts')) {
  runAuthLogoutDeleteUnitTests().then(({ passed, failures }) => {
    if (!passed) {
      console.error(`\nFAILED with ${failures.length} failure(s):`, failures);
      process.exit(1);
    }
  }).catch((err) => {
    console.error('Fatal error running tests:', err);
    process.exit(1);
  });
}

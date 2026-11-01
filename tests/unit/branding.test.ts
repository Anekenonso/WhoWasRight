/**
 * Branding & Static Asset Delivery Unit Tests
 * Verifies favicon.svg, favicon.ico, manifest.json, and HTML branding integration.
 */

import assert from 'node:assert';
import http from 'node:http';
import { createWebServer, renderMobileAppHtml } from '../../src/web/server.ts';
import { FAVICON_SVG, PWA_MANIFEST } from '../../src/web/branding.ts';

export async function runBrandingTests() {
  console.log('\n============================================================');
  console.log('WHOWASRIGHT BRANDING & STATIC ASSET TESTS');
  console.log('============================================================\n');

  // 1. Verify SVG structure
  assert(FAVICON_SVG.startsWith('<svg'), 'FAVICON_SVG starts with <svg');
  assert(FAVICON_SVG.includes('viewBox="0 0 48 48"'), 'FAVICON_SVG has 48x48 viewBox');
  assert(FAVICON_SVG.includes('wwr-shield-bg'), 'FAVICON_SVG contains brand shield gradient');
  assert(FAVICON_SVG.includes('wwr-w-grad'), 'FAVICON_SVG contains W monogram gradient');
  assert(FAVICON_SVG.includes('wwr-check-grad'), 'FAVICON_SVG contains verification check gradient');
  console.log('  [PASS] FAVICON_SVG markup and gradients validated');

  // 2. Verify Manifest structure
  assert.strictEqual(PWA_MANIFEST.name, 'WhoWasRight — Private Sports Prediction Journal');
  assert.strictEqual(PWA_MANIFEST.short_name, 'WhoWasRight');
  assert.strictEqual(PWA_MANIFEST.display, 'standalone');
  assert.strictEqual(PWA_MANIFEST.theme_color, '#0F172A');
  assert(PWA_MANIFEST.icons.some(i => i.src === '/favicon.svg'), 'Manifest links to /favicon.svg');
  console.log('  [PASS] PWA_MANIFEST structure and icons validated');

  // 3. Verify HTML template embedding
  const html = renderMobileAppHtml();
  assert(html.includes('href="/favicon.svg"'), 'HTML contains /favicon.svg link');
  assert(html.includes('href="/manifest.json"'), 'HTML contains /manifest.json link');
  assert(html.includes('name="theme-color" content="#0F172A"'), 'HTML contains theme-color meta tag');
  assert(html.includes('hero-shield-bg'), 'HTML landing view contains hero shield brand mark');
  assert(!html.includes('⚽ ⚖️'), 'HTML landing view no longer uses generic emojis for logo');
  console.log('  [PASS] HTML template branding and meta tags validated');

  // 4. Verify HTTP endpoint delivery
  const server = createWebServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const base = `http://localhost:${address.port}`;

  try {
    // /favicon.svg
    const svgRes = await fetch(`${base}/favicon.svg`);
    assert.strictEqual(svgRes.status, 200, '/favicon.svg returns 200');
    assert(svgRes.headers.get('content-type')?.includes('image/svg+xml'), '/favicon.svg content-type is image/svg+xml');
    const svgBody = await svgRes.text();
    assert(svgBody.includes('<svg'), '/favicon.svg body is SVG');
    console.log('  [PASS] GET /favicon.svg returns valid SVG with 200 OK');

    // /favicon.ico
    const icoRes = await fetch(`${base}/favicon.ico`);
    assert.strictEqual(icoRes.status, 200, '/favicon.ico returns 200');
    assert(icoRes.headers.get('content-type')?.includes('image/svg+xml'), '/favicon.ico content-type is image/svg+xml');
    console.log('  [PASS] GET /favicon.ico returns 200 OK');

    // /manifest.json
    const manifestRes = await fetch(`${base}/manifest.json`);
    assert.strictEqual(manifestRes.status, 200, '/manifest.json returns 200');
    assert(manifestRes.headers.get('content-type')?.includes('application/manifest+json'), '/manifest.json content-type is application/manifest+json');
    const manifestJson = await manifestRes.json();
    assert.strictEqual(manifestJson.name, PWA_MANIFEST.name);
    console.log('  [PASS] GET /manifest.json returns valid JSON with 200 OK');

  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log('\n============================================================');
  console.log('BRANDING TESTS COMPLETE: ALL ASSERTIONS PASSED');
  console.log('============================================================\n');
}

runBrandingTests().catch(err => {
  console.error('Branding test failed:', err);
  process.exit(1);
});

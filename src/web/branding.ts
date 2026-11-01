/**
 * WhoWasRight Brand Identity & Static Assets
 * Vector logo, scalable SVG favicon, and PWA Web Manifest.
 */

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none">
  <defs>
    <linearGradient id="wwr-shield-bg" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#1E293B"/>
      <stop offset="100%" stop-color="#0B0F19"/>
    </linearGradient>
    <linearGradient id="wwr-w-grad" x1="12" y1="16" x2="36" y2="36" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#60A5FA"/>
      <stop offset="100%" stop-color="#2563EB"/>
    </linearGradient>
    <linearGradient id="wwr-check-grad" x1="20" y1="16" x2="38" y2="34" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#34D399"/>
      <stop offset="100%" stop-color="#059669"/>
    </linearGradient>
    <filter id="wwr-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="#10B981" flood-opacity="0.4"/>
    </filter>
  </defs>

  <!-- Obsidian Curved Shield Base -->
  <rect x="4" y="4" width="40" height="40" rx="12" fill="url(#wwr-shield-bg)"/>
  <rect x="4" y="4" width="40" height="40" rx="12" stroke="#334155" stroke-width="1.5"/>

  <!-- Subdued Precision Reticle / Pitch Circle -->
  <circle cx="24" cy="24" r="13.5" stroke="#334155" stroke-width="1" stroke-dasharray="2.5 2.5" opacity="0.8"/>

  <!-- Interlocking 'W' Monogram (WhoWasRight) -->
  <path d="M12.5 17.5L18 31L23.5 19.5L29 31L34.5 17.5" stroke="url(#wwr-w-grad)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>

  <!-- Sovereign Verification Checkmark (Right / Accuracy) -->
  <path d="M21 24.5L26 29.5L37.5 15" stroke="url(#wwr-check-grad)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#wwr-glow)"/>
</svg>`;

export const PWA_MANIFEST = {
  name: "WhoWasRight — Private Sports Prediction Journal",
  short_name: "WhoWasRight",
  description: "Private sports prediction journal with cryptographically immutable credibility tracking.",
  start_url: "/",
  display: "standalone",
  background_color: "#F8FAFC",
  theme_color: "#0F172A",
  icons: [
    {
      src: "/favicon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any maskable"
    }
  ]
};

export const LOGO_TOPBAR_SVG = `<svg width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex-shrink: 0; vertical-align: middle;">
  <rect x="4" y="4" width="40" height="40" rx="12" fill="#0F172A"/>
  <rect x="4" y="4" width="40" height="40" rx="12" stroke="#334155" stroke-width="1.5"/>
  <path d="M13 18L18 30L23.5 20L29 30L34 18" stroke="#3B82F6" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M21 25L26 30L37 16" stroke="#10B981" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const LOGO_HERO_SVG = `<div style="display: inline-flex; align-items: center; justify-content: center; width: 72px; height: 72px; margin: 0 auto 14px auto; position: relative;">
  <div style="position: absolute; inset: -4px; background: radial-gradient(circle, rgba(37,99,235,0.2) 0%, rgba(16,185,129,0.15) 50%, transparent 70%); border-radius: 24px; filter: blur(8px);"></div>
  <svg width="68" height="68" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" style="position: relative; z-index: 1;">
    <defs>
      <linearGradient id="hero-shield-bg" x1="4" y1="4" x2="44" y2="44" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#1E293B"/>
        <stop offset="100%" stop-color="#0F172A"/>
      </linearGradient>
      <linearGradient id="hero-w-grad" x1="12" y1="16" x2="36" y2="36" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#60A5FA"/>
        <stop offset="100%" stop-color="#2563EB"/>
      </linearGradient>
      <linearGradient id="hero-check-grad" x1="20" y1="16" x2="38" y2="34" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#34D399"/>
        <stop offset="100%" stop-color="#059669"/>
      </linearGradient>
      <filter id="hero-check-glow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#10B981" flood-opacity="0.5"/>
      </filter>
    </defs>
    <rect x="4" y="4" width="40" height="40" rx="12" fill="url(#hero-shield-bg)"/>
    <rect x="4" y="4" width="40" height="40" rx="12" stroke="#334155" stroke-width="1.5"/>
    <circle cx="24" cy="24" r="14" stroke="#334155" stroke-width="1" stroke-dasharray="3 3"/>
    <path d="M12.5 17.5L18 31L23.5 19.5L29 31L34.5 17.5" stroke="url(#hero-w-grad)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M21 24.5L26 29.5L37.5 15" stroke="url(#hero-check-grad)" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round" filter="url(#hero-check-glow)"/>
  </svg>
</div>`;

import React from 'react';

// Colour tokens from the SolwAI logo family spec (handoff/LOGO-SPEC.md §3).
// Light = on a white/light surface, dark = on the navy (#0F2B3D) surface.
const INK = { light: '#0F2B3D', dark: '#FFFFFF' };
const ORGANISER_ACCENT = { light: 'oklch(0.60 0.09 200)', dark: 'oklch(0.76 0.10 200)' };
const SOLWAI_ACCENT = { light: 'oklch(0.63 0.075 225)', dark: 'oklch(0.78 0.08 225)' };

// This-Organiser mark: three rows on a shared 48x33 "tide line" grid.
// `theme` picks the ink/accent pair for a light or dark (navy) background.
export function BrandMark({ theme = 'dark', size = 46 }) {
  const ink = INK[theme];
  const height = Math.round((size * 33) / 48);
  return (
    <svg width={size} height={height} viewBox="0 0 48 33" fill="none" aria-hidden="true">
      <path d="M11 4.5H19" stroke={ink} strokeWidth="5" strokeLinecap="round" />
      <path d="M29 4.5H37" stroke={ink} strokeWidth="5" strokeLinecap="round" />
      <path d="M3 16.5H45" stroke={ORGANISER_ACCENT[theme]} strokeWidth="5" strokeLinecap="round" />
      <path d="M17 28.5H35" stroke={ink} strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

// SolwAI (parent house) mark — same grid, single top stroke, solwai accent.
export function SolwaiMark({ theme = 'dark', size = 20 }) {
  const ink = INK[theme];
  const height = Math.round((size * 33) / 48);
  return (
    <svg width={size} height={height} viewBox="0 0 48 33" fill="none" aria-hidden="true">
      <path d="M11 4.5H41" stroke={ink} strokeWidth="5" strokeLinecap="round" />
      <path d="M3 16.5H45" stroke={SOLWAI_ACCENT[theme]} strokeWidth="5" strokeLinecap="round" />
      <path d="M17 28.5H35" stroke={ink} strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

// "THIS-ORGANISER" wordmark, Quadrillion Extra Light 200 — the product
// weight. The bundled demo font's hyphen glyph is a placeholder, so the
// hyphen is set in Manrope instead — drop this span once a licensed
// Quadrillion is available.
export function Wordmark({ className }) {
  return (
    <span className={className}>
      THIS<span style={{ fontFamily: 'Manrope', fontWeight: 300 }}>-</span>ORGANISER
    </span>
  );
}

// "SOLWAI" wordmark, Quadrillion Semibold 700 — the house weight, never the
// product's 200. The only coloured text anywhere in the system is the "AI",
// which always takes the solwai accent.
export function SolwaiWordmark({ className, theme = 'dark' }) {
  return (
    <span className={className}>
      SOLW<span style={{ color: SOLWAI_ACCENT[theme] }}>AI</span>
    </span>
  );
}

import React from 'react';

// This-Organiser mark: four rounded strokes, viewBox 0 0 48 33. `ink` is
// white on navy surfaces (header) and navy on white ones (sign-in).
export function BrandMark({ ink, size = 46 }) {
  const height = Math.round((size * 33) / 48);
  return (
    <svg width={size} height={height} viewBox="0 0 48 33" fill="none" aria-hidden="true">
      <path d="M11 4.5H19" stroke={ink} strokeWidth="5" strokeLinecap="round" />
      <path d="M29 4.5H37" stroke={ink} strokeWidth="5" strokeLinecap="round" />
      <path d="M3 16.5H45" stroke="oklch(0.76 0.10 200)" strokeWidth="5" strokeLinecap="round" />
      <path d="M17 28.5H35" stroke={ink} strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

// SolwAI mark for the footer: same geometry, but the top line is a single
// stroke rather than two — replace with the official SolwAI logo if one exists.
export function SolwaiMark({ size = 20 }) {
  const height = Math.round((size * 33) / 48);
  return (
    <svg width={size} height={height} viewBox="0 0 48 33" fill="none" aria-hidden="true">
      <path d="M11 4.5H37" stroke="#FFFFFF" strokeWidth="5" strokeLinecap="round" />
      <path d="M3 16.5H45" stroke="oklch(0.76 0.10 200)" strokeWidth="5" strokeLinecap="round" />
      <path d="M17 28.5H35" stroke="#FFFFFF" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

// "THIS-ORGANISER" wordmark in Quadrillion Extra Light. The bundled demo
// font's hyphen glyph is a placeholder, so the hyphen is set in Manrope
// instead — drop this span once a licensed Quadrillion is available.
export function Wordmark({ className }) {
  return (
    <span className={className}>
      THIS<span style={{ fontFamily: 'Manrope', fontWeight: 300 }}>-</span>ORGANISER
    </span>
  );
}

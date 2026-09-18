// The same harness, but with real accounts turned on.
//
// AUTH_MODE and ALLOW_INSECURE are read when auth.js and app.js are first
// imported, so they are set here BEFORE the dynamic import of helpers.js
// pulls those modules in. A static `export * from` would be hoisted above
// these assignments and defeat the whole arrangement.
process.env.AUTH_MODE = 'multi';
process.env.ALLOW_INSECURE = '1'; // no TLS in a test process
process.env.ALLOW_REGISTRATION = 'true';

const h = await import('./helpers.js');

export const {
  call, raw, cleanup, get, post, patch, put, del, baseUrl,
  createAccount, loginAs, currentCookie, useCookie, signOutLocally,
} = h;

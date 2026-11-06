// Walk Playground — three.ws stable entry.
// ========================================
// The full-page stroll/platformer engine lives in the SDK (walk-sdk/,
// @three-ws/walk). This module re-exports it at the stable, unhashed URL
// /walk-playground.js (a Vite entry) so any page can `import('/walk-playground.js')`
// and the corner companion's lazy import() resolves to the same singleton —
// preserving one shared playground instance across the whole site.
//
// Importing the SDK module also installs window.__walkPlayground, which the IBM
// partnership demo and console debugging rely on.

export * from '../walk-sdk/src/playground.js';

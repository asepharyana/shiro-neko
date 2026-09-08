---
name: perf-frontend
description: Make a web page faster. Use when a page loads slowly, feels janky, fails Core Web Vitals, or ships too much JavaScript.
---

# Frontend performance

Measure the user's experience first: a Lighthouse lab score and, better, real-user data. Optimise
the metric that is actually failing, not the one easiest to move.

## The vitals and what drives them

- **LCP** (largest contentful paint) — almost always the hero image or a web font. Preload it,
  size it correctly, serve it in a modern format, and do not let render-blocking resources delay it.
- **INP / responsiveness** — long tasks on the main thread. Break up work, defer non-urgent JS,
  and keep event handlers fast. A click that responds in 50ms feels instant; 300ms feels broken.
- **CLS** (layout shift) — images and embeds without dimensions, late-injected banners, web fonts
  swapping. Reserve the space before the content arrives.

## Ship less JavaScript

The bundle is usually the problem. Route-level code splitting so a page loads only what it needs,
lazy-load the heavy below-the-fold component, and audit the dependency tree for a large library
imported for one function. Removing 100KB of JS beats most micro-optimisations.

## Network discipline

- Cache static assets with long, content-hashed lifetimes; the second visit should cost almost
  nothing.
- Compress (brotli/gzip) and serve images at the size they are displayed, responsive `srcset`,
  not a 3000px original in a 300px slot.
- Fetch in parallel, not in waterfalls: start independent requests together, and preload the
  critical few.

## Change one thing, measure it

Take a baseline (the metric, the page, the device class), make one change, re-measure on the same
setup. Two changes at once and you do not know which paid. Report the before/after you actually
measured, on a realistic device and connection — a developer's fast laptop and fiber hides what a
mid-range phone on 4G feels.

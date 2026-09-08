---
name: frontend
description: Build or fix a web UI. Use when working on components, state, rendering performance, forms, or anything the user sees and interacts with in a browser.
---

# Frontend

The user's experience is the metric. Fast, clear, and forgiving beats clever.

## State lives as low as it can

Lift state only as high as the components that share it. Global state for something two siblings
need is re-render and complexity for everything. Server data is not client state — cache it with
the data layer rather than duplicating it into a store you must keep in sync by hand.

## Rendering is the usual bottleneck

Before optimising, find what re-renders. A component that re-renders on every parent render
because of an inline object or function prop is the common case. Memoize the expensive subtree,
not everything — `useMemo` and `useCallback` have a cost too, and slapping them everywhere is
its own slowdown.

## Forms respect the user

- Validate on blur or submit, not on every keystroke, and show the message at the field.
- Never clear a form on an error. The user's input is the most expensive thing on the page.
- Disable the submit while submitting, and say what is happening. A double-submitted form is a
  duplicate record.

## Accessibility is not a later pass

Semantic HTML first: a `<button>` that looks like a button beats a `<div>` with a click
handler. Keyboard-reachable everything, visible focus, labels on inputs, alt text that conveys
the point not the pixels. Colour is never the only carrier of meaning.

## Measure what the user feels

Load: get the first meaningful paint and the time-to-interactive down before micro-tuning.
Bundle: split the route nobody opens, lazy-load the heavy component. A Lighthouse number is a
proxy; the goal is that it never feels slow.

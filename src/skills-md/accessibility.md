---
name: accessibility
description: Make a UI accessible. Use when adding a feature that must work with a keyboard or screen reader, fixing contrast or focus issues, or reviewing for WCAG.
---

# Accessibility

Accessibility is usability for everyone, including people using a keyboard, a screen reader, a
magnifier, or a noisy display. Build it in, not on.

## Semantic HTML does the heavy lifting

A `<button>`, `<a>`, `<input>`, `<nav>`, `<main>` carries behaviour and meaning for free
that a `<div>` with a click handler does not. Reach for the native element first; add ARIA only
when no native element fits. The first rule of ARIA is do not use ARIA if a native element exists.

## Keyboard is the baseline

- Every interactive element is reachable and operable with Tab and Enter/Space alone.
- A visible focus indicator on everything — never `outline: none` without a replacement.
- Logical tab order following the visual order, and focus managed into and out of modals,
  menus, and dialogs (trapped while open, returned to the trigger on close).

## Screen readers hear structure

- Headings in order (`h1` once, then down a level at a time) so the page has a navigable outline.
- Every `<input>` has a `<label>`; every icon-only button has an accessible name; every image
  has alt text that conveys its point (or empty alt when it is purely decorative).
- Dynamic changes announce themselves: a toast, an error, a loaded region uses a live region so
  it is heard, not just seen.

## Contrast and meaning

Text meets 4.5:1 against its background (3:1 for large text). Colour is never the only carrier
of meaning — pair it with an icon, a label, or a pattern. A red-only "error" is invisible to a
colour-blind user.

## Test it the way it is used

Tab through the whole flow. Turn on a screen reader and listen. Zoom to 200% and 400%. Run an
automated checker for the mechanical half — then do the manual half it cannot cover, because
most accessibility failures are not machine-detectable.

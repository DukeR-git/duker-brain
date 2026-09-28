---
id: css_layout
title: CSS Layout
criteria: CSS layout bugs, flexbox shrinking and min-width, grid template areas, responsive breakpoints, z-index and stacking contexts
---

# CSS Layout

## Flexbox collapse
A flex item's default `min-width: auto` prevents it shrinking below its content.
When a sidebar is hidden and the layout collapses, `min-width: 0` on the flex
child is almost always the fix.

## Grid
`grid-template-areas` makes a responsive rearrangement a one-line change per
breakpoint rather than a reordering of the DOM.

## Stacking contexts
`transform`, `filter`, `opacity < 1` and `will-change` each create a stacking
context, which is why a z-index that "should work" does not.

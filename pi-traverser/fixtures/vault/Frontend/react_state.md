---
id: react_state
title: React State
criteria: React component state, hooks and useEffect, context providers, lifting state up, unnecessary rerenders and memoisation
---

# React State

## Local versus lifted
Keep state in the lowest component that needs it. Lifting it higher than
necessary rerenders siblings that did not change.

## Context
Context is a delivery mechanism, not a store: every consumer rerenders when the
value identity changes. Memoise the provider value.

## Effects
`useEffect` is for synchronising with something outside React. Deriving state
from props inside an effect causes a second render; compute it during render.

# Intelligence Domain

## Purpose

The intelligence domain owns BeeKeeper's derived insight layer.

This domain is responsible for representing and operating on:

- health scores
- alerts
- predictions
- evidence
- readiness and confidence summaries
- intelligence-oriented selectors and transforms

This domain sits downstream of raw hive, inspection, and hardware signals.

---

## What This Domain Owns

- Health score concepts and types
- Alert records and summaries
- Prediction records and summaries
- Evidence structures
- Confidence and readiness summaries
- Intelligence-oriented API adapters and selectors

---

## What This Domain Does Not Own

This domain does **not** own:

- raw hardware device management
- raw inspection draft handling
- hive structure
- dashboard rendering
- LLM chat UI
- DOM or native presentation concerns

---

## Core Concepts

### HealthScore
A structured score and component breakdown for hive state.

### Alert
An actionable signal that should be surfaced to the user.

### Prediction
A derived forecast, classification, or estimate.

Examples:
- swarm risk
- queen status
- mite load estimate
- harvest timing
- winter survival

### Evidence
A structured explanation element supporting a prediction or score.

### Readiness
A summary of whether sufficient data exists for a prediction or score to be reliable.

---

## Initial File Responsibilities

### `types.ts`
Canonical types for scores, alerts, predictions, evidence, and readiness.

### `api.ts`
All intelligence-related backend calls.

Examples:
- get hive score
- get alerts
- get prediction summaries
- get health analysis
- fetch score history

### `actions.ts`
Intelligence workflows.

Examples:
- build a score card model
- summarize alerts for dashboard use
- derive prediction readiness
- normalize evidence into user-facing structures

### `selectors.ts`
Pure transforms for UI view models.

Examples:
- derive score severity labels
- summarize top evidence
- group alerts by urgency
- build dashboard intelligence widgets

### `validators.ts`
Validation for intelligence payload shapes where needed.

### `constants.ts`
Prediction types, score bands, alert severity labels, and readiness states.

---

## Architecture Direction

This domain is the product's insight layer.

It should not collapse into dashboard-only logic. The dashboard should consume intelligence; it should not own intelligence.

The intelligence domain must remain explicit so it can support:

- web dashboard
- future iOS experience
- notifications
- weekly summaries
- future LLM advisory layers

---

## Initial Extraction Guidance

Early extraction goals:

- centralize score / alert / prediction contracts
- keep page behavior stable
- avoid baking intelligence transforms directly into dashboard code
- create clear selectors for downstream UI use

---

## Related Domains

- `hardware` for signal availability and freshness
- `inspections` for human-confirmed observations
- `hives` for hive identity and summary context
- `health` for disease, treatment, and mite-related facts

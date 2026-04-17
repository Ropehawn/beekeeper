# Hives Domain

## Purpose

The hives domain owns hive identity, structure, and hive-level summaries.

This domain is responsible for representing and operating on:

- apiaries and hive grouping
- hive records
- hive structure
- hive components
- hive frames
- hive summaries

This is a foundational domain for the product.

---

## What This Domain Owns

- Hive identity and metadata
- Hive structure and component stack
- Frame identity and frame-level structure
- Hive summaries used by other surfaces
- Hive-related API adapters and selectors

---

## What This Domain Does Not Own

This domain does **not** own:

- inspections as workflows
- hardware device assignments
- intelligence predictions
- task records
- financial records
- UI rendering of 3D or page layouts

---

## Core Concepts

### Apiary
A site or grouping that contains one or more hives.

### Hive
A single colony container record with identity and metadata.

### HiveComponent
A physical component in the hive structure.

Examples:
- bottom board
- brood box
- honey super
- inner cover
- feeder
- lid

### HiveFrame
A frame within a hive component or box.

### HiveSummary
A UI-ready summary for dashboard, cards, and overview surfaces.

---

## Initial File Responsibilities

### `types.ts`
Canonical types for apiaries, hives, components, frames, and summaries.

### `api.ts`
All hive-related backend calls.

Examples:
- list hives
- fetch hive
- create hive
- update hive
- update hive components
- update frame

### `actions.ts`
Hive workflows and structural changes.

Examples:
- add hive
- update stack
- update frame metadata
- normalize hive structure for UI use

### `selectors.ts`
Pure transforms for UI view models.

Examples:
- summarize hive composition
- build frame labels
- compute active box/frame counts
- create dashboard-ready hive cards

### `validators.ts`
Rules for valid structure and edits.

### `constants.ts`
Hive component kinds, structure rules, and labels.

---

## Architecture Direction

This domain is the structural truth of the apiary.

Inspection, hardware, intelligence, and dashboard layers should reference hives rather than recreating hive structure logic locally.

---

## Initial Extraction Guidance

Early extraction goals:

- centralize hive types and selectors
- move structure logic out of page files
- preserve existing behavior
- avoid mixing hive structure rules with inspection or hardware concerns

---

## Related Domains

- `apiaries` for site-level grouping
- `inspections` for observational workflows
- `hardware` for device-to-hive assignment
- `intelligence` for hive-level derived scores and predictions

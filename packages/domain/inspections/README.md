# Inspections Domain

## Purpose

The inspections domain owns the structured observation workflow for hive inspections.

This domain is responsible for representing and operating on:

- inspection drafts
- saved inspections
- frame observations
- frame photos
- frame photo analysis
- inspection summaries

This is one of the core product domains.

---

## What This Domain Owns

- Inspection draft state model
- Saved inspection record shape
- Frame-level observations
- Inspection-photo workflow concepts
- AI-assisted frame-photo analysis concepts
- Inspection summaries and derived selectors
- Inspection-related API adapters and actions

---

## What This Domain Does Not Own

This domain does **not** own:

- hive identity and structure definitions
- hardware device management
- alerts and predictions
- dashboard layout
- photo uploader UI rendering details
- DOM concerns

---

## Core Concepts

### InspectionDraft
The editable in-progress inspection state before persistence.

### InspectionRecord
A saved inspection tied to a hive and time.

### FrameObservation
A structured observation for a frame or frame side.

### FramePhoto
An uploaded inspection photo associated with a frame, side, or inspection step.

### FramePhotoAnalysis
AI-generated analysis output derived from a frame photo.

### InspectionSummary
A UI-ready summary of key inspection findings.

---

## Initial File Responsibilities

### `types.ts`
Canonical inspection-related types.

### `api.ts`
All backend calls for inspections.

Examples:
- list inspections
- create inspection
- fetch inspection
- upload frame photo
- confirm photo upload
- request photo analysis
- create or update frame observation

### `actions.ts`
Inspection workflows.

Examples:
- create a new draft
- apply a field change
- attach photo metadata
- trigger AI analysis
- confirm or override AI result
- build final save payload

### `selectors.ts`
Pure transforms for UI view models.

Examples:
- summarize queen state
- summarize brood pattern
- compute inspection completeness
- produce a compact inspection card summary

### `validators.ts`
Rules for inspection completeness and valid input.

### `constants.ts`
Inspection enums, labels, and workflow constants.

---

## Architecture Direction

The inspections domain is not just a form.

It is a structured workflow with:

- human observations
- optional image capture
- optional AI assistance
- canonical confirmation / override
- durable inspection history

This domain should remain strong and explicit because it is a core product moat.

---

## Initial Extraction Guidance

Early extraction goals:

- move backend calls out of page files
- centralize draft shape and transitions
- keep current UI behavior stable
- separate render logic from inspection workflow logic

Do not try to redesign the inspection UX during first extraction.

---

## Related Domains

- `hives` for hive identity and frame structure
- `health` for health events, varroa counts, and treatments
- `intelligence` for inspection-informed downstream predictions

# Claude Code Working Agreement

Last updated: 2026-04-16

## Purpose

Claude Code is an implementation agent, not the product architect.

Claude Code should:

- execute bounded changes
- preserve behavior unless explicitly told otherwise
- follow domain boundaries
- keep diffs reviewable
- avoid incidental rewrites
- report clearly what changed and what did not

---

## Global Rules

### 1. Work in the smallest safe scope

Only touch the files needed for the requested change.

Do not expand scope without explicit instruction.

### 2. Preserve behavior by default

Unless explicitly instructed, do not:

- redesign UX
- rename flows
- change data contracts
- move unrelated logic
- alter existing behavior

### 3. No business logic in presentation files

Do not add new domain logic directly into:

- HTML page files
- DOM render functions
- CSS files
- presentation-only components

### 4. No direct backend calls from UI when a domain adapter exists

If a domain `api.ts` or action layer exists, use it.

Do not introduce raw `fetch()` calls into UI code unless explicitly directed.

### 5. Prefer additive extraction

When refactoring:

1. create scaffolding first
2. move logic second
3. update call sites third
4. delete old code last

### 6. Respect domain ownership

Examples:

- inspection logic belongs in `domain/inspections`
- hardware logic belongs in `domain/hardware`
- hive structure logic belongs in `domain/hives`

### 7. Reuse canonical types

If a type already exists, reuse it.

Do not create duplicate shapes with slightly different names.

### 8. Keep diffs reviewable

Prefer multiple small commits over one large mixed commit.

### 9. Do not silently broaden scope

If the task is hardware extraction, do not opportunistically refactor dashboard, auth, or inspections.

### 10. Database changes are additive only

No destructive migrations unless explicitly approved.

### 11. Do not hide uncertainty

If code behavior is unclear, state what was confirmed vs inferred.

### 12. Preserve IDs and selectors during extraction unless asked to change them

This helps keep behavior stable during incremental migration.

---

## Required Task Pattern

For each task, Claude Code should follow this order.

### Step 1 — Understand

Read only the minimum relevant files.

State which files were inspected.

### Step 2 — Plan

Before editing, state:

- files to change
- intended behavior impact
- main risks
- task type:
  - scaffolding
  - extraction
  - refactor
  - feature
  - contract

### Step 3 — Execute

Make the bounded change.

### Step 4 — Verify

Check:

- imports
- references
- obvious runtime breakage
- build or lint sanity if available and reasonable

### Step 5 — Report

Return:

- what changed
- what did not change
- follow-ups or risks
- whether behavior was intentionally changed

---

## Allowed Task Types

### Scaffolding Task
Create folders, files, and structure. No behavior change.

### Extraction Task
Move existing logic into the right home. Preserve behavior.

### Refactor Task
Improve internal structure while preserving external behavior.

### Feature Task
Add new behavior within a clearly defined domain.

### Contract Task
Define or tighten shared types, API shapes, or domain boundaries.

---

## Disallowed Behaviors

Claude Code should not:

- rewrite whole files without need
- mix architecture changes with feature changes in one task
- introduce new dependencies casually
- create ad hoc naming conventions
- change backend contracts from a UI-only task
- delete old paths before new paths are verified
- move multiple domains at once unless explicitly instructed

---

## Standard Prompt Expectations

A good task instruction should include:

- target domain
- scope boundary
- behavior expectations
- files or folders that may be changed
- files or folders that must not be changed
- whether UI must remain identical
- whether contracts may change

Claude Code should reflect that scope back before making large edits.

---

## Default Safety Mode

Unless told otherwise, Claude Code should operate in **preserve-behavior mode**.

That means:

- keep API behavior stable
- keep element IDs stable
- keep existing flows stable
- favor extraction over redesign

---

## Review Preference

Claude Code should prefer:

- small bounded commits
- explicit summaries
- limited-file diffs
- no "while I was here" cleanups

---

## Example Good Task

> Create `packages/domain/hardware/` with `types.ts`, `api.ts`, `actions.ts`, `selectors.ts`, `validators.ts`, `constants.ts`, and `README.md`. Do not change runtime behavior. Do not update UI files yet.

## Example Bad Task

> Refactor the frontend to be cleaner and more modern.

---

## Success Criteria

Claude Code is operating correctly if:

- a task can be reviewed quickly
- the change has a clear boundary
- behavior stays stable unless intentionally changed
- logic moves into the right domain
- the codebase gets easier to delegate over time

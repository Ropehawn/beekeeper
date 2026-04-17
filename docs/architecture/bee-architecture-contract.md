# BeeKeeper Architecture Contract

Last updated: 2026-04-16

## Purpose

BeeKeeper is a product platform, not just a web app. It must support:

- Web application
- Future iOS application
- Hardware ingestion from Tachyon hubs and field devices
- Intelligence / prediction workflows
- AI-assisted implementation through Claude Code

The architecture must optimize for:

- clear domain boundaries
- safe incremental changes
- reusable business logic
- platform-specific presentation layers
- small, reviewable work packets

---

## Core Rule

**Business logic does not live in page files.**

Pages and screens may:

- render state
- collect input
- trigger actions
- display loading / error / success states

Pages and screens may not become the long-term home for:

- domain rules
- canonical data transforms
- API contract definitions
- validation logic
- cross-feature business workflows

Those belong in domain modules.

---

## Canonical Product Domains

BeeKeeper is organized around these product domains:

- auth
- users
- apiaries
- hives
- inspections
- hardware
- intelligence
- tasks
- health
- feeding
- harvest
- financials

These domains are the durable product structure across web, iOS, API, and future tooling.

---

## System Layers

### 1. Domain Layer

The domain layer owns:

- canonical types
- domain API adapters
- selectors and transforms
- use-cases / actions
- validation
- domain constants

This layer is platform-agnostic.

It should be reusable by:

- web presentation
- future iOS presentation
- internal tooling
- background jobs where appropriate

### 2. Platform Layer

The platform layer owns:

- web presentation
- future iOS presentation
- platform-specific navigation
- platform-specific interaction patterns
- browser / DOM concerns
- native iOS concerns

This layer should remain thin relative to the domain layer.

### 3. Infrastructure Layer

The infrastructure layer owns:

- backend API
- database
- storage
- external integrations
- hardware ingest
- ML / training pipelines
- deployment and runtime services

---

## Design Principles

### Domain-first

Code should be organized by product capability, not by current page layout.

### Additive evolution

Prefer adding new modules and migrating call sites over large rewrites.

### Stable contracts

Types and domain actions should change less frequently than page implementations.

### Thin presentation

UI code should call domain actions and selectors, not raw backend endpoints directly.

### Explicit boundaries

Cross-domain imports must be intentional and minimal.

### AI-safe implementation

The repository must support bounded implementation tasks that Claude Code can execute safely.

### Incremental modernization

The current app may remain operational during transition. We do not require a rewrite to move toward the target architecture.

---

## Canonical Repo Direction

Target direction:

```text
apps/
  api/
  web/
packages/
  domain/
  shared/
  db/
docs/
  architecture/
  product/
  runbooks/
hardware/
training/
```

This is a target structure, not a requirement for one-step migration.

---

## Domain Boundaries

### auth

Owns session state model, login/reset flows, and auth token handling rules.

### users

Owns user records, roles, invites, and permission-related user data.

### apiaries

Owns apiary identity, site metadata, and location-level grouping.

### hives

Owns hive identity, hive structure, components, frames, and hive summaries.

### inspections

Owns inspection drafts, saved inspections, frame observations, frame-photo workflows, and inspection summaries.

### hardware

Owns hubs, sensors, cameras, device assignments, signal health, reading summaries, and device registry concepts.

### intelligence

Owns alerts, scores, predictions, evidence, and readiness derived from signals and historical data.

### tasks

Owns task records, assignment, due dates, status transitions, and task summaries.

### health

Owns health events, varroa counts, treatment logs, and disease / issue tracking.

### feeding

Owns feeding logs, feed type, quantity, and timing.

### harvest

Owns harvest events, yield, harvest metadata, and batch summaries.

### financials

Owns expenses, income, receipts, and financial summaries.

---

## Web Direction

The current web app may remain a single operational surface during migration, but the long-term direction is:

- shell and routing in web layer
- domain logic extracted into domain modules
- page render code separated from domain logic
- no new business rules added to giant page files

---

## iOS Direction

The future iOS application should align to the same domain model and backend contracts.

We do not assume web and iOS will share UI code.

We do assume they should share:

- product vocabulary
- canonical types
- API behavior
- domain actions and rules at the conceptual level

---

## What We Are Not Doing

Not current goals:

- full rewrite
- framework change for its own sake
- heavy abstraction before boundaries are clear
- premature shared web/iOS UI code strategy
- redesigning all screens before extracting domain logic

---

## Success Criteria

The architecture is working if:

- Claude Code can execute small tasks safely
- a human can identify where a feature belongs quickly
- web screens do not own business logic
- backend contracts are explicit and reusable
- iOS can be built against the same domain model later
- refactors can happen without destabilizing the whole app

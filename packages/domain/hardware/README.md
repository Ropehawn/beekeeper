# Hardware Domain

## Purpose

The hardware domain owns the product model for BeeKeeper field hardware and its observability layer.

This domain is responsible for representing and operating on:

- hubs
- sensor devices
- camera devices
- device assignments
- signal health
- reading summaries
- hardware readiness / status concepts

This domain should support both:

- current web admin / management surfaces
- future productized experiences across web and iOS

---

## What This Domain Owns

- Hub identity and hub status
- Sensor and camera device records
- Device-to-hive assignment concepts
- Device registry concepts
- Signal health and freshness
- Reading summaries for UI consumption
- Derived hardware readiness and observability summaries
- Hardware-oriented API adapters and selectors

---

## What This Domain Does Not Own

This domain does **not** own:

- hive structure itself
- inspections
- intelligence predictions
- dashboard layout
- DOM rendering
- CSS
- generic auth/session behavior

Those belong to other domains or the platform layer.

---

## Core Concepts

### Hub
A field collection unit, such as a Tachyon hub, responsible for gathering and forwarding signal data.

### SensorDevice
A hardware sensor associated with a hub and optionally assigned to a hive or role.

Examples:
- BLE environmental sensor
- thermal sticker
- weight input source
- audio input source

### CameraDevice
A video or image capture source associated with the system.

### DeviceAssignment
The relationship between a device and a hive, hive role, or physical position.

### SignalHealth
Health/status information for a hardware signal, such as:

- last seen
- RSSI
- freshness
- connectivity
- battery state
- ingest health

### ReadingSummary
A UI-ready summary of current readings or recent signal state.

---

## Initial File Responsibilities

### `types.ts`
Canonical types for hubs, devices, assignments, signal health, and reading summaries.

### `api.ts`
All hardware-related backend calls.

Examples:
- list hubs
- list devices
- discover devices
- register device
- assign device
- fetch latest reading summary
- fetch signal health

### `actions.ts`
Use-cases and domain workflows.

Examples:
- discover and normalize devices
- assign a device to a hive role
- build observability status for a hive
- reconcile hub/device readiness state

### `selectors.ts`
Pure transformations for UI view models.

Examples:
- summarize device inventory for a hive
- derive connection severity label
- derive missing-signal warnings
- produce prediction-readiness prerequisites from available signals

### `validators.ts`
Validation rules for assignments and hardware input.

### `constants.ts`
Hardware roles, statuses, device types, and thresholds.

---

## Architecture Direction

This domain should evolve away from pure "device management" and toward **observability**.

That means the long-term center of gravity is not:
- discover device
- assign device
- register device

It is:
- what signals does this hive have
- how healthy are those signals
- what can the system infer from them
- what is missing or degraded

---

## Initial Extraction Guidance

During early refactor work:

- preserve existing behavior
- preserve existing API contracts unless explicitly changing them
- move logic out of page files
- do not redesign the UX during initial extraction

First goal:
- centralize hardware API usage and normalization

Second goal:
- support future observability-first UI

---

## Related Domains

- `hives` for hive identity and structure
- `intelligence` for scores, alerts, predictions, and evidence
- `inspections` for operational hive workflows

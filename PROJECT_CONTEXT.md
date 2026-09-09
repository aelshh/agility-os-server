# AgilityOS: Architecture & Context Specification

This document serves as the foundational system prompt and architectural context for AI agents operating within the AgilityOS development environment. All generated code and architectural decisions must align with the parameters defined herein.

---

# 1. System Identity and Vision

AgilityOS is an Enterprise Deliberate Practice Engine specifically engineered for frontline revenue teams. It is distinct from generic Learning Management Systems (LMS) or basic roleplay tools.
- **The Habit:** A 2-minute daily voice practice habit delivered via WhatsApp.
- **Infrastructure:** Powered by the **Telenow Voice AI** infrastructure for low-latency, high-fidelity conversational coaching.
- **Core Differentiation:** Unlike static LMS platforms that push top-down content, AgilityOS is an adaptive environment where practice is triggered by real-world field signals.

---

# 2. Adoption Engineering Rules (Non-Negotiable)

The following four rules are hardcoded into the system’s logic and user experience design:
- **Rule 1: Net Receiver of Value.** Every role (from Rep to VP) must receive more value from the system than the effort they expend to maintain it.
- **Rule 2: No Direct Nagging.** The system never sends automated "reminders" or "nags" to sales representatives. All nudges and accountability loops flow exclusively through managers.
- **Rule 3: Content Flows Up.** Practice modules are not generic top-down courses. Content is "signal-fed" based on specific challenges identified in the field.
- **Rule 4: Privacy is Sacred.** Managers are strictly prohibited from accessing raw audio recordings of practice sessions. Reps own their practice space. This is enforced at the middleware and database query layer.

---

# 3. Roles and Access Boundaries

Access control is governed by seven distinct personas:

| Role | Responsibility | Boundary |
| :--- | :--- | :--- |
| **Practitioner (Rep)** | Daily 2-minute drills via WhatsApp. | Access to personal skill profile and own sessions only. |
| **Field Coach (ASM)** | Reviewing team signals and nudging reps. | Access to team-level aggregate data; no raw audio. |
| **Content Curator (L&D)** | Designing drills based on field signals. | Access to drill builder and signal repository. |
| **Quality Gate (Compliance)** | Reviewing drill content for regulatory safety. | Approval rights for drill publishing. |
| **Strategist (VP Sales)** | High-level performance and win correlation. | Global org-unit visibility and strategic reporting. |
| **Architect (CEO)** | System configuration and tenant management. | Full administrative oversight. |
| **Talent Steward (HR)** | Syncing talent data and competency models. | HRMS/ATS integration management (anonymized aggregates). |

---

# 4. Foundational HRMS & ATS Context Layer

The system maintains high data fidelity through a dual-layer integration strategy to prevent "JD Drift."

## Unified APIs & Regional Connectors
- **Global Unified APIs:** Integration via Merge.dev and Kombo.
- **Indian Native Connectors:** Direct support for Keka, Darwinbox, ZingHR, GreytHR, Zoho People, and HROne via an `IHrmsConnector` interface.
- **Fallback:** CSV/Excel ingestion for legacy systems.

## Sync Scopes and ATS Layer
- **Dynamic Sync:** Utilizes department whitelists and configurable maximum hierarchy depth.
- **ATS Layer:** Integrates with Greenhouse, Lever, Ashby, and Naukri RMS to capture hiring-time Job Descriptions (JDs), providing a baseline to compare against current HRMS JDs.

---

# 5. Sales Agility Code

All pedagogical logic within the AI agent follows the **Sales Agility Code**:
- **4 Phases:** Assess, Choose, Execute, Feedback (ACEF).
- **4 Strategies:** Consultative, Disruptive, Competitive, and Financial.

---

# 6. Core 2-Minute Drill Loop & Telenow Voice Stack

The execution lifecycle for a practice session follows a specific technical sequence:

## The Voice Stack
- **STT (Speech-to-Text):** Deepgram or Sarvam.
- **LLM (Logic & Analysis):** GPT-4o-mini or Claude.
- **TTS (Text-to-Speech):** Sarvam or ElevenLabs.
- **Transport:** Telephony integrated with WhatsApp.

## Execution Lifecycle
1. **Trigger:** Drill delivered via WhatsApp (scheduled or CRM event).
2. **Ingestion:** Webhook listeners for `call.ended` and `analysis.complete`.
3. **Evaluation:** Post-call QA scorecard mapping against the Sales Agility Code.
4. **Feedback:** Generation of a 15–20 second voice feedback note delivered to the rep.

---

# 7. Database Schema & Data Models

The system utilizes **Drizzle ORM** with a **PostgreSQL** backend (`src/db/schema.ts`). Key models include:
- **Organizations & Org_Units:** Multi-tenant structural hierarchy.
- **Job_Descriptions:** Stores both ATS (hiring) and HRMS (current) versions.
- **Employees & Users:** Represents the workforce and their system credentials.
- **Reporting_Edges:** Graph-based representation of management hierarchies.
- **Drills & Sessions:** The definition of practice modules and their individual attempts.
- **Signals:** Field-derived triggers that inform drill creation.
- **Approvals & Nudges:** State-tracking for content workflows and manager interactions.
- **Skill_Profiles:** A materialized view calculating proficiency:
  - **Red:** < 50
  - **Yellow:** 50 – 70
  - **Green:** > 70
- **Win_Correlations:** Data mapping practice performance to actual CRM sales outcomes ($p < 0.05$, $R^2 > 0.3$).

---

# 8. State Machines

## Drill Lifecycle
`draft` -> `regional_review` -> `compliance_review` (with AI Pre-Screening) -> `vp_review` -> `published` (Telenow Agent Created) -> `expired`.

## Adaptive Difficulty Engine
The engine manages five difficulty tiers (1 to 5):
- **Escalation:** Move up a tier after 3 consecutive sessions with scores > 75/80/85 (relative to current tier).
- **Regression:** Move down a tier after 3 consecutive sessions with scores < 50.

---

# 9. Background Queues & Event Architecture

Powered by **BullMQ** and **Redis** for asynchronous processing:
- **Queues:** `drill_delivery`, `feedback_generation`, `signal_processing`, `analytics_pipeline`, `approval_escalation`, `crm_sync`.
- **Event Catalog:** `session.created`, `signal.created`, `drill.published`, `analysis.ready`.

-
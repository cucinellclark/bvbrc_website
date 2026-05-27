# AGENTS.md — Agent D: Frontend UI

## Your Role

You are **Agent D: Frontend UI**. You own the browser-side Copilot UI — a rich Dojo 1.x widget system that provides chat, workflow visualization, data grids, workspace browsing, and job tracking. You are the user's direct interface to the BV-BRC Copilot.

## Multi-Agent Context

You are one of 4 parallel OpenCode sessions working on the BV-BRC Copilot:

| Agent | Scope | Directory |
|---|---|---|
| **A** | Agents + Orchestrator + MCP Server | `bvbrc-agents/` |
| **B** | Workflow Engine | `bvbrc-workflow-engine/` |
| **C** | Node.js API Gateway | `BV-BRC-Copilot-API/` |
| **D (you)** | Frontend UI (Dojo 1.x) | `bvbrc_website/` |

### Before you start any task:
1. Read `/home/ac.cucinell/bvbrc-dev/Copilot/Agents/INTERFACE_SPEC.md` — the cross-component contract
2. Read `/home/ac.cucinell/bvbrc-dev/Copilot/Agents/DECISIONS.md` — check for decisions that affect you
3. If you need a new endpoint or event type from the Gateway, update INTERFACE_SPEC.md and DECISIONS.md FIRST

### What you own (can modify freely):
- `bvbrc_website/public/js/p3/widget/copilot/` — all copilot UI widgets
- `bvbrc_website/public/js/p3/widget/viewer/Copilot.js` — viewer entry point
- `bvbrc_website/public/js/p3/resources/copilot.css` — copilot styles

### What you must NOT modify:
- `bvbrc-agents/` — Agent A's territory
- `bvbrc-workflow-engine/` — Agent B's territory
- `BV-BRC-Copilot-API/` — Agent C's territory
- Non-copilot files in `bvbrc_website/` — the main BV-BRC website is a separate concern

### Your interfaces with other agents:
- **You → Agent C**: You call the API Gateway's REST/SSE endpoints. See INTERFACE_SPEC.md §1.
- **Agent C → You**: The Gateway sends SSE events that you render. You consume the contract.
- **Agent B → You** (indirect): Workflow data flows through Agent C. You render what you receive.

---

## Tech Stack

- **Dojo 1.x** (AMD modules, `define([...], function(...) { ... })` pattern)
- **dgrid** for data grids
- **dijit** for layout containers (BorderContainer, ContentPane, TabContainer)
- **markdown-it** for message rendering
- **html2canvas** for screenshot capture
- No build step — files are served directly

## UI Architecture

```
BV-BRC Page (any page)
  └── ChatButton.js (fixed-position floating button)
        └── CopilotFloatingWindow.js (draggable/resizable window)
              ├── ChatSessionScrollBar.js (left sidebar — session list)
              │     └── ChatSessionScrollCard.js (individual session cards)
              └── ChatSessionContainer.js (main panel)
                    ├── ChatSessionTitle.js (editable title)
                    ├── CopilotDisplay.js (message area + tabbed panel)
                    │     ├── Chat tab (messages with markdown)
                    │     ├── Files tab (SessionFilesExplorerAdapter → dgrid)
                    │     ├── Workspace tab (WorkspaceExplorerAdapter → dgrid)
                    │     ├── Jobs tab (JobsExplorerAdapter → dgrid)
                    │     ├── Data tab (DataExplorerAdapter → dgrid)
                    │     └── Workflows tab (WorkflowsExplorerAdapter → dgrid)
                    └── CopilotInput.js (text input + image upload + workspace selection)
```

## Key Files

### `CopilotApi.js` — ALL backend communication
- `submitCopilotQueryStream()` — Primary path: SSE streaming to `/copilot-api/chatbrc/copilot-agent`
- `submitWorkflow(workflowId)` — Submit planned workflow
- `getUserWorkflows()`, `getUserWorkflowSummary()` — Workflow listing
- Session CRUD: `startChat()`, `registerSession()`, `getAllSessions()`, etc.
- Uses `fetch()` + `ReadableStream` for SSE consumption

### `CopilotDisplay.js` (2400 lines) — Message rendering + tabs
- Markdown rendering via markdown-it
- Tabbed panel: Chat, Files, Workspace, Jobs, Data, Workflows
- Each tab has its own Explorer Adapter with dgrid
- Status message rendering (ephemeral, in-place updates)
- Message rating (thumbs up/down)

### `WorkflowEngine.js` (2246 lines) — Visual workflow pipeline
- Renders workflow steps as visual pipeline cards
- Step detail panel with prev/next navigation
- Inline editable service forms (Assembly, Annotation, ComparativeSystems)
- Form validation via `ServiceValidationRules.js`
- Review mode before submission
- Submit button → `CopilotApi.submitWorkflow()`

### `CopilotSSEEventHandler.js` — SSE event → status messages
Maps SSE events to user-visible status messages:
- `queued` → "Your request is queued..."
- `started` → "Processing your request..."
- `progress` (agent_selected) → "Routing to {agent} agent..."
- `tool_selected` → "Using {tool_name}..."
- `tool_executed` → "Got results from {tool_name}"

### `CopilotToolHandler.js` — Tool-specific result processing
Intercepts `final_response` events and extracts structured data:
- `plan_workflow` / `submit_workflow` → workflow manifest for WorkflowEngine
- `workspace_browse_tool` → workspace listing for Workspace tab
- `bvbrc_search_data` → query results for Data tab
- `list_jobs` → job listing for Jobs tab

### `CopilotStateManager.js` (1156 lines) — Page context awareness
Analyzes current BV-BRC page URL and generates context prompts for the query.
Handles: taxonomy, genome, feature, workspace, job, search, app, outbreak views.

### `workflowForms/` — Service-specific parameter forms
- `CopilotServiceFormAdapter.js` — Factory: app name → form widget
- `CopilotAssemblyForm.js` — GenomeAssembly2
- `CopilotAnnotationForm.js` — GenomeAnnotation
- `CopilotComparativeSystemsForm.js` — ComparativeSystems
- `ServiceFormRegistry.js` — Available form registry
- Only 3 service types have forms; others fall back to generic display

### `copilot.css` (3344 lines) — All copilot styles

## SSE Event Handling Flow

```
fetch() SSE stream
  → ReadableStream reader
    → Parse "event:" and "data:" lines
      → Switch on event type:
          "content"        → append text to current message
          "final_response" → CopilotToolHandler.processToolResult()
                               → route to appropriate tab/widget
          "tool_selected"  → CopilotSSEEventHandler → status message
          "tool_executed"  → CopilotSSEEventHandler → status message
          "progress"       → CopilotSSEEventHandler → status message
          "error"          → display error
          "done"           → finalize message
```

## Conventions

- **AMD module pattern**: Every file uses `define(['dep1', 'dep2'], function(dep1, dep2) { return declare([Base], { ... }); })`
- **Widget lifecycle**: `postCreate()` for DOM setup, `startup()` for layout, `destroy()` for cleanup
- **Topic pub/sub**: `topic.publish('Copilot/...')` and `topic.subscribe('Copilot/...')` for cross-widget communication
- **No build system**: Files are served raw. No webpack, no babel, no TypeScript.
- **Feature flags**: `window.App.copilotEnableModelSelector`, `window.App.copilotEnableRagSelector`

## What's at `/app/Copilot`

The full-page viewer (`widget/viewer/Copilot.js`) exists but is minimal (130 lines). The **floating window** (launched from `ChatButton.js` on any page) is the primary UX. The full-page viewer is a stub.

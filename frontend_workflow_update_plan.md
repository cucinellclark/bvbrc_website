# Frontend Workflow Update — Replace Legacy Flat Fields with `msg.workflow`

## Goal

Remove all legacy flat-field workflow handling (`isWorkflow`, `workflowData`,
`workflow_id` on messages) and replace with a single source of truth:
`msg.workflow`, a nested object written by the gateway at persist time.
The full workflow manifest is fetched from the engine on demand via
`getWorkflowById()` — it is no longer embedded on the message.

---

## 1. What the Backend Now Provides

### On persisted assistant messages (in MongoDB)

```javascript
message.workflow = {                 // NEW — always present for workflow messages
  workflow_id: "wf_abc123",
  status:      "planned",            // snapshot at write time
  persisted:   true,                 // false if engine registration failed
  workflow_name: "Genome Assembly",
  step_count:  2
}

// These legacy fields are ALSO written during transition but will be
// dropped from the gateway once the frontend no longer reads them:
message.workflow_id    // string
message.isWorkflow     // boolean
message.workflowData   // object (full manifest)
```

### On SSE `final_response` events (streaming)

The gateway sends `final_response` with a `call` envelope on the first
synthesis chunk. The `call.arguments_executed` has the tool_trace args,
and `call.result` has the manifest (if any). The raw `result_for_ui`
now also contains:

```javascript
result_for_ui.workflow_id   // string
result_for_ui.persisted     // boolean
result_for_ui.manifest      // object (full workflow manifest)
result_for_ui.workflow_plan // object (plan DAG)
```

### Workflow engine endpoints used by the frontend

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/workflows/{id}` | GET | Fetch full workflow manifest |
| `/workflows/{id}/status` | GET | Get live status |
| `/workflows/{id}/submit` | POST | Submit planned workflow |
| `/workflows/batch-status` | POST | Batch status (new) |

---

## 2. Architecture of the Replacement

### Old flow (being removed)

```
SSE → CopilotToolHandler._processWorkflowManifest()
    → 6 detection paths (A0/A1/A2/B/C/D)
    → sets { isWorkflow, workflowData, workflow_id }
    → buildToolMetadata() copies them
    → CopilotInput._applyToolMetadataToAssistantMessage() merges flat fields
    → ChatMessage.renderMessage() re-infers isWorkflow from source_tool
    → dispatches to renderWorkflowManifestCard() / renderSimplifiedServiceCard()
```

### New flow (replacement)

```
SSE → CopilotToolHandler._processWorkflowManifest()
    → ONE detection path: look for workflow_id + persisted on payload
    → sets { workflow: { workflow_id, status, persisted, ... } }
    → buildToolMetadata() copies msg.workflow
    → CopilotInput._applyToolMetadataToAssistantMessage() sets msg.workflow
    → ChatMessage.renderMessage() checks msg.workflow.workflow_id
    → dispatches to renderWorkflowCard()
    → card fetches full manifest from engine via getWorkflowById() if needed
```

### Key differences

1. **No more `isWorkflow` / `workflowData` / flat `workflow_id`.**
   One field: `msg.workflow`.
2. **No more embedding full manifests on messages.**
   The card fetches from the engine on demand.
3. **No more 6 SSE parsing paths.** One path: does the payload have
   `workflow_id` + `persisted`?
4. **No more re-inference from `source_tool` on session reload.**
   `msg.workflow` is persisted to DB; no guessing needed.

---

## 3. Files to Change

### Frontend (`bvbrc_website/public/js/p3/widget/copilot/`)

| File | What Changes |
|------|-------------|
| `CopilotToolHandler.js` | Replace `_processWorkflowManifest()` (6 paths → 1), remove `_normalizeServicePlanResponse()`, update `processMessageContent()` to return `workflow` instead of `isWorkflow`/`workflowData` |
| `CopilotInput.js` | Update `_applyToolMetadataToAssistantMessage()` — replace flat field merging with `msg.workflow` |
| `CopilotApi.js` | Add `getBatchWorkflowStatus()`; update `submitCopilotQueryStream()` `buildToolMetadata()` |
| `ChatMessage.js` | Replace workflow detection + dispatch; replace card renderers to use engine-fetched data; refactor `showWorkflowDialog()` to accept workflow data as a parameter instead of reading from `this.message.workflowData` |
| `CopilotDisplay.js` | Extract workflow IDs from `msg.workflow` for Workflows panel |
| `WorkflowsExplorerAdapter.js` | Use `getBatchWorkflowStatus()` instead of per-ID fetch loop |
| `ChatSessionContainer.js` | Update `_applySessionWorkflowContext()` to merge message-level workflow IDs; update `_handleWorkflowCardStatusUpdated()` to write `message.workflow` instead of `message.workflowData` |

### Gateway (`BV-BRC-Copilot-API/services/`)

| File | What Changes |
|------|-------------|
| `agentOrchestrator.js` | **Legacy agent path.** `buildDisplayMetadata()` (line 456-466) returns `isWorkflow`/`workflow_id` flat fields. Lines 1688-1708 write `assistantMessage.workflow_id`, `assistantMessage.workflowData`, `assistantMessage.isWorkflow`. Must be updated to write `assistantMessage.workflow` nested object instead. This is the non-orchestrator code path — if it is not updated, all messages created by the legacy agent will continue to have old-shape fields and the frontend compatibility shim can never be removed. |
| `orchestratorClient.js` | (Already addressed in backend plan Step 8) Remove legacy flat field writes after frontend deploys. |

### Files NOT changed

| File | Why |
|------|-----|
| `WorkflowEngine.js` | Its `workflowData` is a widget-level property, not a message field. It receives data from `getWorkflowById()` at instantiation time. No message-level changes needed. |
| `CopilotSSEEventHandler.js` | Event dispatch only; never touches workflow fields |
| `CopilotFloatingWindow.js` | Layout/chrome widget; no workflow field references or topic subscriptions |
| `SessionWorkflowsSelectionStore.js` | Store internals compatible as-is |
| `workflowForms/*` | Service forms operate on workflow data from engine, not from messages |
| `ServiceValidationRules.js` | Validation rules unaffected |
| `copilot.css` | CSS classes are tied to DOM class names, not JS field names — unaffected |

---

## 4. Implementation Steps

### Step 1: `CopilotApi.js` — Add `getBatchWorkflowStatus()` and update `buildToolMetadata()`

**Add new method** (~after `getWorkflowStatus`, line 1487):

```javascript
getBatchWorkflowStatus: function(workflowIds) {
    if (!this._checkLoggedIn()) return Promise.reject('Not logged in');
    if (!workflowIds || !workflowIds.length) {
        return Promise.resolve({ statuses: {}, not_found: [] });
    }
    var workflowEngineUrl = window.App.workflow_url || 'https://dev-7.bv-brc.org/api/v1';
    return request.post(workflowEngineUrl + '/workflows/batch-status', {
        data: JSON.stringify({ workflow_ids: workflowIds.slice(0, 20) }),
        headers: {
            'Content-Type': 'application/json',
            'Authorization': (window.App.authorizationToken || '')
        },
        handleAs: 'json'
    });
},
```

**Update `buildToolMetadata()`** (inside `submitCopilotQueryStream()`,
~line 375). Replace the `isWorkflow`/`workflowData` block:

```javascript
// OLD:
if (processed.isWorkflow) {
    toolMetadata.isWorkflow = processed.isWorkflow;
    toolMetadata.workflowData = processed.workflowData;
    if (processed.workflowData && processed.workflowData.workflow_id) {
        toolMetadata.workflow_id = processed.workflowData.workflow_id;
    }
}

// NEW:
if (processed.workflow) {
    toolMetadata.workflow = processed.workflow;
}
```

---

### Step 2: `CopilotToolHandler.js` — Replace `_processWorkflowManifest()`

**Delete** the entire `_processWorkflowManifest()` function (lines 28-272)
and `_normalizeServicePlanResponse()` (lines 742-770).

**Replace with a single function:**

```javascript
_processWorkflowManifest: function(chunk, parsed) {
    var baseData = { source_tool: parsed.tool || parsed.source_tool || null };

    // Parse the payload to an object if it's a string
    var payload = chunk;
    if (typeof chunk === 'string') {
        try { payload = JSON.parse(chunk); } catch (e) { return null; }
    }
    if (typeof payload !== 'object' || payload === null) return null;

    // Unwrap .content if present
    if (payload.content && typeof payload.content === 'string') {
        try { payload = JSON.parse(payload.content); } catch (e) { /* keep as-is */ }
    }

    // The source of truth: look for call.result (from gateway envelope)
    // or top-level workflow_id (from result_for_ui)
    var source = payload;
    if (payload.call && typeof payload.call === 'object') {
        // Gateway envelope: { call: { tool, arguments_executed, result } }
        source = payload.call.result || payload.call.arguments_executed || payload;
        baseData.source_tool = payload.call.tool || payload.tool || baseData.source_tool;
    }

    // Detect workflow identity
    var workflowId = source.workflow_id || null;
    var persisted = source.persisted === true;

    if (!workflowId) return null;

    console.log('[CopilotToolHandler] Workflow detected:', workflowId,
                'persisted:', persisted);

    var callInfo = null;
    if (payload.call && typeof payload.call === 'object') {
        callInfo = payload.call;
    }

    return {
        ...baseData,
        chunk: typeof chunk === 'string' ? chunk : JSON.stringify(chunk),
        workflow: {
            workflow_id: workflowId,
            status: source.status || 'planned',
            persisted: persisted,
            workflow_name: (source.manifest && source.manifest.workflow_name)
                || source.workflow_name || null,
            step_count: (source.manifest && source.manifest.steps && source.manifest.steps.length)
                || source.step_count || null
        },
        tool_call: callInfo
    };
},
```

This single function replaces all 6 paths (A0, A1, A2, B, C, D).
It returns `workflow` instead of `isWorkflow`/`workflowData`.

**Also update `processMessageContent()`** (line 1065). This function is
called during session-reload content re-processing. It currently returns
`isWorkflow`/`workflowData` from the workflow path (lines 1076-1080).
Update to return `workflow` instead:

```javascript
// In the workflow tool branch (lines 1072-1081):
// OLD:
return {
    content: processed.chunk,
    isWorkflow: processed.isWorkflow,
    workflowData: processed.workflowData
};

// NEW:
return {
    content: processed.chunk,
    workflow: processed.workflow
};
```

And update the caller in `ChatMessage.js` (line 578-582) which spreads
the result — see Step 4b.

---

### Step 3: `CopilotInput.js` — Update `_applyToolMetadataToAssistantMessage()`

**Replace** the flat field merging (lines 153-173):

```javascript
_applyToolMetadataToAssistantMessage: function(assistantMessage, toolMetadata) {
    if (!assistantMessage || !toolMetadata) return;

    assistantMessage.source_tool = toolMetadata.source_tool || assistantMessage.source_tool;
    assistantMessage.tool_call = toolMetadata.tool_call || assistantMessage.tool_call;

    // Workflow — single nested object
    if (toolMetadata.workflow) {
        assistantMessage.workflow = toolMetadata.workflow;
    }

    // Workspace browse
    assistantMessage.isWorkspaceListing = toolMetadata.isWorkspaceListing;
    assistantMessage.workspaceData = toolMetadata.workspaceData;
    assistantMessage.isWorkspaceBrowse = toolMetadata.isWorkspaceBrowse;
    assistantMessage.workspaceBrowseResult = toolMetadata.workspaceBrowseResult;

    // Jobs browse
    assistantMessage.isJobsBrowse = toolMetadata.isJobsBrowse;
    assistantMessage.jobsBrowseResult = toolMetadata.jobsBrowseResult;

    // Query collection
    assistantMessage.isQueryCollection = toolMetadata.isQueryCollection;
    assistantMessage.queryCollectionData = toolMetadata.queryCollectionData;

    // UI action/payload
    assistantMessage.chatSummary = toolMetadata.chatSummary;
    assistantMessage.uiPayload = toolMetadata.uiPayload;
    assistantMessage.uiAction = toolMetadata.uiAction;
},
```

**Removed:** `isWorkflow`, `workflowData`, `workflow_id` (flat).

---

### Step 4: `ChatMessage.js` — Replace workflow detection and card rendering

#### 4a. Remove the re-inference block (lines 442-462)

Delete the entire `if (sourceTool && (sourceTool.indexOf('plan_workflow') ...`
block. This is no longer needed because `msg.workflow` is persisted to DB.

#### 4a-ii. Remove the "already processed" workflow check (lines 526-537)

Delete:
```javascript
if (sourceTool && (sourceTool.indexOf('plan_workflow') !== -1 || ...) &&
    (this.message.workflowData || this.message.workflow_id || this.message.isWorkflow)) {
    alreadyProcessed = true;
}
```

Replace with:
```javascript
if (this.message.workflow && this.message.workflow.workflow_id) {
    alreadyProcessed = true;
}
```

#### 4a-iii. Update `processedData` spread (lines 578-582)

This block spreads results from `toolHandler.processMessageContent()`
onto the message. Currently writes `isWorkflow` and `workflowData`:

```javascript
// OLD (lines 581-582):
this.message.isWorkflow = typeof processedData.isWorkflow !== 'undefined' ? processedData.isWorkflow : this.message.isWorkflow;
this.message.workflowData = typeof processedData.workflowData !== 'undefined' ? processedData.workflowData : this.message.workflowData;
```

Replace with:
```javascript
// NEW:
if (processedData.workflow) {
    this.message.workflow = processedData.workflow;
}
```

#### 4b. Replace the card dispatch (lines 743-756)

Replace:

```javascript
// OLD:
var hasWorkflowIdentity = !!(
    this.message.workflow_id ||
    (this.message.workflowData && this.message.workflowData.workflow_id) || ...
);

if ((this.message.isWorkflow && this.message.workflowData) ||
    (renderSourceTool.indexOf('plan_workflow') !== -1 && hasWorkflowIdentity) || ...
```

With:

```javascript
// NEW:
if (this.message.workflow && this.message.workflow.workflow_id) {
    if (this.message.workflow.persisted === false) {
        // Engine persistence failed — render an inline warning instead of a card
        this._renderWorkflowPersistWarning(messageDiv);
    } else {
        this.renderWorkflowCard(messageDiv);
    }
} else if ( /* ...existing workspace / jobs / query checks unchanged... */ ) {
```

#### 4c. Add `renderWorkflowCard()` — replaces both `renderWorkflowManifestCard()` and `renderSimplifiedServiceCard()`

This is a **new unified function** that:

1. Reads `msg.workflow` for identity (`workflow_id`, `status`, `workflow_name`, `step_count`).
2. Renders a card immediately with available metadata (name, step count, status badge).
3. Adds "Review" and "Submit" buttons.
4. "Review" calls `copilotApi.getWorkflowById(workflow_id)` and opens the existing `WorkflowEngine` dialog or Dojo form modal with the fetched data.
5. "Submit" calls `copilotApi.submitWorkflowForExecution({ workflow_id, status: 'planned' })` (the existing submit-by-ID path).
6. "Check Status" calls `copilotApi.getWorkflowStatus(workflow_id)` and updates the badge.

```javascript
renderWorkflowCard: function(messageDiv) {
    var wf = this.message.workflow;
    var workflowId = wf.workflow_id;
    var workflowName = wf.workflow_name || 'Workflow';
    var stepCount = wf.step_count || null;
    var currentStatus = wf.status || 'planned';
    var self = this;

    // -- Card container --
    var card = domConstruct.create('div', {
        class: 'copilot-service-card workflow-manifest-card'
    }, messageDiv);

    // -- Header row: name + status badge --
    var headerRow = domConstruct.create('div', {
        class: 'copilot-service-card-actions',
        style: 'display: flex; align-items: center; justify-content: space-between;'
    }, card);

    domConstruct.create('div', {
        class: 'copilot-service-card-title',
        innerHTML: this.escapeHtml(workflowName)
    }, headerRow);

    var statusBadge = domConstruct.create('span', {
        innerHTML: this.escapeHtml(currentStatus.toUpperCase()),
        style: 'padding: 2px 6px; font-size: 11px; border-radius: 3px; font-weight: 500; '
             + this._getWorkflowStatusStyle(currentStatus)
    }, headerRow);

    // -- Details row --
    if (stepCount) {
        domConstruct.create('div', {
            innerHTML: stepCount + ' step' + (stepCount > 1 ? 's' : ''),
            style: 'font-size: 12px; color: #6b7280; margin-bottom: 6px;'
        }, card);
    }

    // -- Actions row --
    var actionsRow = domConstruct.create('div', {
        class: 'copilot-service-card-actions'
    }, card);

    // Review button
    var reviewButton = domConstruct.create('button', {
        innerHTML: (currentStatus !== 'planned' ? 'View Workflow' : 'Review'),
        class: 'workflow-review-btn',
        title: 'Review workflow parameters'
    }, actionsRow);

    on(reviewButton, 'click', function() {
        reviewButton.innerHTML = 'Loading...';
        reviewButton.disabled = true;
        self.copilotApi.getWorkflowById(workflowId).then(function(fullWorkflow) {
            // Inject workflow_id + execution_metadata for WorkflowEngine compat
            fullWorkflow.workflow_id = workflowId;
            fullWorkflow.execution_metadata = {
                workflow_id: workflowId,
                status: currentStatus,
                is_planned: currentStatus === 'planned',
                is_submitted: currentStatus !== 'planned'
            };
            self._openWorkflowDialog(fullWorkflow);
        }).catch(function(err) {
            console.error('[ChatMessage] Failed to fetch workflow:', err);
            topic.publish('/Notification', {
                message: 'Failed to load workflow details', type: 'error'
            });
        }).then(function() {
            reviewButton.innerHTML = (currentStatus !== 'planned' ? 'View Workflow' : 'Review');
            reviewButton.disabled = false;
        });
    });

    // Submit button (only for planned workflows)
    var submitButton = null;
    if (currentStatus === 'planned') {
        submitButton = domConstruct.create('button', {
            innerHTML: 'Submit',
            type: 'button',
            style: 'padding: 8px 16px; background: #2563eb; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;'
        }, actionsRow);

        on(submitButton, 'click', function() {
            if (submitButton.disabled) return;
            submitButton.disabled = true;
            submitButton.innerHTML = 'Submitting...';

            self.copilotApi.submitWorkflowForExecution({
                workflow_id: workflowId,
                status: 'planned'
            }).then(function(response) {
                var newStatus = (response && response.status) || 'submitted';
                currentStatus = newStatus;
                wf.status = newStatus;

                // Update badge
                statusBadge.innerHTML = self.escapeHtml(newStatus.toUpperCase());
                statusBadge.style.cssText += self._getWorkflowStatusStyle(newStatus);
                submitButton.innerHTML = 'Submitted';

                topic.publish('/Notification', {
                    message: 'Workflow submitted successfully.', type: 'message'
                });
                topic.publish('CopilotWorkflowCardStatusUpdated', {
                    session_id: self.sessionId || null,
                    message_id: self.message && self.message.message_id || null,
                    workflow: wf
                });

                // Track on session
                if (self.sessionId && self.copilotApi.addWorkflowToSession) {
                    self.copilotApi.addWorkflowToSession(self.sessionId, workflowId).catch(function() {});
                }
            }).catch(function(err) {
                submitButton.disabled = false;
                submitButton.innerHTML = 'Submit';
                topic.publish('/Notification', {
                    message: 'Submission failed: ' + (err.message || err), type: 'error'
                });
            });
        });
    }

    // Check Status button (for submitted/running/etc.)
    if (currentStatus !== 'planned' && self.copilotApi && self.copilotApi.getWorkflowStatus) {
        var checkBtn = domConstruct.create('button', {
            innerHTML: 'Check Status',
            class: 'workflow-check-status-button',
            style: 'padding: 4px 10px; background: #fff; color: #374151; border: 1px solid #d1d5db; border-radius: 3px; cursor: pointer; font-size: 13px;'
        }, actionsRow);

        on(checkBtn, 'click', function() {
            checkBtn.disabled = true;
            checkBtn.innerHTML = 'Checking...';
            self.copilotApi.getWorkflowStatus(workflowId).then(function(statusResp) {
                var liveStatus = statusResp && statusResp.status;
                if (liveStatus) {
                    currentStatus = liveStatus;
                    wf.status = liveStatus;
                    statusBadge.innerHTML = self.escapeHtml(liveStatus.toUpperCase());
                    statusBadge.style.cssText += self._getWorkflowStatusStyle(liveStatus);
                }
            }).catch(function(err) {
                console.error('[ChatMessage] Status check failed:', err);
            }).then(function() {
                checkBtn.disabled = false;
                checkBtn.innerHTML = 'Check Status';
            });
        });
    }
},
```

#### 4d. Add helper `_renderWorkflowPersistWarning()`

```javascript
_renderWorkflowPersistWarning: function(messageDiv) {
    domConstruct.create('div', {
        innerHTML: 'Workflow planning completed but failed to register with the '
                 + 'engine. Please try again.',
        style: 'padding: 10px; color: #b45309; background: #fffbeb; '
             + 'border: 1px solid #fbbf24; border-radius: 4px; font-size: 13px;'
    }, messageDiv);
},
```

#### 4e. Extract `_getWorkflowStatusStyle()` as a shared helper

The existing status-to-style mapping is duplicated in
`renderSimplifiedServiceCard()` and `renderWorkflowManifestCard()`.
Extract it once:

```javascript
_getWorkflowStatusStyle: function(statusValue) {
    var s = (statusValue || '').toLowerCase();
    if (s === 'succeeded' || s === 'completed') return 'background: #10b981; color: #fff;';
    if (s === 'failed' || s === 'error')        return 'background: #ef4444; color: #fff;';
    if (s === 'cancelled')                       return 'background: #6b7280; color: #fff;';
    if (s === 'running')                         return 'background: #2563eb; color: #fff;';
    if (s === 'queued' || s === 'pending')       return 'background: #f59e0b; color: #111827;';
    if (s === 'submitted')                       return 'background: #14b8a6; color: #fff;';
    if (s === 'planned')                         return 'background: #6366f1; color: #fff;';
    return 'background: #9ca3af; color: #fff;';
},
```

#### 4f. Refactor `showWorkflowDialog()` → `_openWorkflowDialog(workflowData)`

The existing `showWorkflowDialog()` (lines 2886-3022) does three things:

1. Reads `this.message.workflowData` to find the workflow ID (line 2887)
2. If no steps are present, calls `getWorkflowById()` to hydrate, then
   **writes back** `this.message.workflowData = fullWorkflow` (line 2919)
   and recursively calls itself
3. Opens the dialog (Dojo form for single-step, WorkflowEngine for multi-step)

Refactor into `_openWorkflowDialog(workflowData)` that accepts the
already-fetched workflow data as a parameter. The hydration fetch is
already handled in `renderWorkflowCard()`'s "Review" button click handler
(see Step 4c above), so this function no longer needs to fetch.

Remove:
- The `this.message.workflowData` read at line 2887
- The `getWorkflowById()` hydration + write-back at lines 2916-2925
- The recursive `this.showWorkflowDialog()` call at line 2921
- The `this.message.workflowData` read at line 2928
- The `workflowData: this.message.workflowData` at line 2945

Replace with a single parameter:

```javascript
_openWorkflowDialog: function(workflowData) {
    if (!workflowData || !workflowData.steps || !workflowData.steps.length) {
        console.error('[ChatMessage] No workflow data available for dialog');
        return;
    }
    var isSingleStep = workflowData.steps.length === 1;
    var step = isSingleStep ? workflowData.steps[0] : null;
    var appName = step ? step.app : '';
    var hasDojoForm = isSingleStep && CopilotServiceFormAdapter.hasDojoForm(appName);

    if (hasDojoForm) {
        this._showDirectFormModal(workflowData, step, appName);
        return;
    }

    // Open WorkflowEngine dialog
    var workflowEngine = new WorkflowEngine({
        workflowData: workflowData,   // WorkflowEngine's own widget property
        copilotApi: this.copilotApi,
        sessionId: this.sessionId
    });
    // ... existing modal overlay/dialog DOM creation unchanged ...
},
```

The "Review" button in `renderWorkflowCard()` (Step 4c) calls:
```javascript
self._openWorkflowDialog(fullWorkflow);
```

No callers use the old `showWorkflowDialog()` with no arguments any more
because `renderSimplifiedServiceCard()` and `renderWorkflowManifestCard()`
are both deleted.

#### 4g. Delete dead code

Remove the following functions (now unused):
- `renderWorkflowManifestCard()` — replaced by `renderWorkflowCard()`
- `renderSimplifiedServiceCard()` — replaced by `renderWorkflowCard()`
- The re-inference block at lines 442-462
- The `hasWorkflowIdentity` variable and associated dispatch conditions

---

### Step 5: `CopilotDisplay.js` — Extract workflow IDs from `msg.workflow`

Update the session-loading path where `setSessionWorkflows()` is called.
Scan messages for `msg.workflow.workflow_id` and merge with session-level
`workflow_ids`:

```javascript
// After messages are loaded:
var messageWorkflowIds = [];
messages.forEach(function(msg) {
    if (msg.workflow && msg.workflow.workflow_id) {
        messageWorkflowIds.push(msg.workflow.workflow_id);
    }
});

// Merge with session-level workflow_ids (dedup)
var allWorkflowIds = (sessionWorkflowIds || []).concat(messageWorkflowIds);
var seen = {};
var uniqueIds = allWorkflowIds.filter(function(id) {
    if (!id || seen[id]) return false;
    seen[id] = true;
    return true;
});

if (uniqueIds.length > 0) {
    this.setSessionWorkflows(uniqueIds);
}
```

---

### Step 6: `WorkflowsExplorerAdapter.js` — Replace per-ID fetch with batch status

Replace `setWorkflowIds()` (lines 191-241):

```javascript
setWorkflowIds: function(workflowIds) {
    var ids = Array.isArray(workflowIds)
        ? workflowIds.filter(function(id) { return typeof id === 'string' && id.trim().length > 0; })
        : [];

    if (ids.length === 0) {
        this.setWorkflowData([]);
        return Promise.resolve([]);
    }

    // Show placeholders while loading
    var placeholders = ids.map(function(id) {
        return {
            id: id, workflow_id: id,
            workflow_name: 'Loading...', status: 'loading',
            step_count: '', submitted_at: '', completed_at: ''
        };
    });
    this.setWorkflowData(placeholders);

    var self = this;
    return this.copilotApi.getBatchWorkflowStatus(ids).then(function(response) {
        var statuses = response.statuses || {};
        var notFound = response.not_found || [];
        var rows = ids.map(function(id) {
            if (statuses[id]) {
                return statuses[id];
            }
            return {
                workflow_id: id,
                workflow_name: notFound.indexOf(id) !== -1 ? 'Not Found' : 'Unavailable',
                status: 'unknown'
            };
        });
        self.setWorkflowData(rows);
        return rows;
    }).catch(function(err) {
        console.warn('[WorkflowsExplorer] Batch status failed', err);
        var fallbackRows = ids.map(function(id) {
            return { workflow_id: id, workflow_name: 'Unavailable', status: 'unknown' };
        });
        self.setWorkflowData(fallbackRows);
        return fallbackRows;
    });
},
```

---

### Step 7: `ChatSessionContainer.js` — Update `_applySessionWorkflowContext()` and `_handleWorkflowCardStatusUpdated()`

#### 7a. Merge message-level workflow IDs into the session workflows

```javascript
_applySessionWorkflowContext: function(data) {
    var sessionWorkflowIds = [];

    // From session-level response
    if (data && data.workflow_grid && Array.isArray(data.workflow_grid.items)) {
        data.workflow_grid.items.forEach(function(item) {
            var id = typeof item === 'string' ? item : (item && item.workflow_id);
            if (id) sessionWorkflowIds.push(id);
        });
    } else if (data && Array.isArray(data.workflow_ids)) {
        sessionWorkflowIds = data.workflow_ids.slice();
    }

    // From messages (msg.workflow.workflow_id)
    var messages = this.chatStore ? this.chatStore.query() : [];
    messages.forEach(function(msg) {
        if (msg.workflow && msg.workflow.workflow_id) {
            var wfId = msg.workflow.workflow_id;
            if (sessionWorkflowIds.indexOf(wfId) === -1) {
                sessionWorkflowIds.push(wfId);
            }
        }
    });

    SessionWorkflowsSelectionStore.setItems(
        this._sessionWorkflowsSelectionState, sessionWorkflowIds
    );
    if (this.displayWidget && this.displayWidget.setSessionWorkflows) {
        this.displayWidget.setSessionWorkflows(sessionWorkflowIds);
    }
    this._syncWorkflowsSelectionsToWidgets();
},
```

---

#### 7b. Update `_handleWorkflowCardStatusUpdated()` (lines 1104-1180)

This handler syncs the message card data when a workflow status changes
(e.g. after Submit or Check Status). At line 1130 it writes directly
to the legacy field:

```javascript
// OLD (line 1130):
message.workflowData = updatedWorkflow;
```

Replace with:
```javascript
// NEW:
if (!message.workflow) {
    message.workflow = {};
}
message.workflow.status = (updatedWorkflow.execution_metadata
    && updatedWorkflow.execution_metadata.status)
    || updatedWorkflow.status || message.workflow.status;
message.workflow.workflow_name = updatedWorkflow.workflow_name
    || message.workflow.workflow_name;
```

The `CopilotWorkflowCardStatusUpdated` topic payload currently carries
the full `workflow` data object (from `WorkflowEngine` or the card submit
handler). The new `renderWorkflowCard()` publishes
`{ session_id, message_id, workflow: wf }` where `wf` is the lightweight
`msg.workflow` object — so the handler only needs to merge status fields.

---

### Step 8: Update `agentOrchestrator.js` — Legacy gateway path

**File:** `BV-BRC-Copilot-API/services/agentOrchestrator.js`

The legacy agent path (non-orchestrator) also persists assistant messages
to MongoDB. It currently writes flat fields at two locations:

**Location 1: `buildDisplayMetadata()` (lines 456-466)**

```javascript
// OLD:
if (isWorkflowTool(toolId)) {
    return {
        isWorkflow: true,
        workflow_id: resolvedWorkflowId || null,
        workflow_name: displayResult.workflow_name || null,
        workflow_status: displayResult.status || null,
        uiAction: 'open_workflow_viewer'
    };
}

// NEW:
if (isWorkflowTool(toolId)) {
    var resolvedWorkflowId = extractWorkflowId(displayResult);
    return {
        workflow: resolvedWorkflowId ? {
            workflow_id: resolvedWorkflowId,
            status: displayResult.status || 'planned',
            persisted: true,
            workflow_name: displayResult.workflow_name || null,
            step_count: displayResult.steps ? displayResult.steps.length : null
        } : null,
        uiAction: 'open_workflow_viewer'
    };
}
```

**Location 2: Post-loop message enrichment (lines 1688-1708)**

```javascript
// OLD:
assistantMessage.workflow_id = resolvedWorkflowId;
assistantMessage.workflowData = { ... };
assistantMessage.isWorkflow = true;

// NEW:
assistantMessage.workflow = {
    workflow_id: resolvedWorkflowId,
    status: 'planned',
    persisted: true,
    workflow_name: assistantMessage.workflowData
        && assistantMessage.workflowData.workflow_name || null,
    step_count: assistantMessage.workflowData
        && assistantMessage.workflowData.steps
        && assistantMessage.workflowData.steps.length || null
};
```

Delete the `assistantMessage.isWorkflow`, `assistantMessage.workflow_id`,
and `assistantMessage.workflowData` writes entirely.

**This must be updated at the same time as the frontend**, not deferred.
Otherwise all messages created by the legacy agent path will have the
old shape and the frontend compatibility shim is permanent.

---

### Step 9: Remove legacy flat-field writes from `orchestratorClient.js`

**File:** `BV-BRC-Copilot-API/services/orchestratorClient.js`

With `agentOrchestrator.js` updated (Step 8) and the frontend reading
only from `msg.workflow`, the transitional legacy flat-field writes in
the orchestrator path can be removed. Delete from the
`orchestrator_done` handler (lines 837-842):

```javascript
// REMOVE:
assistantMessage.workflow_id = workflowId;
assistantMessage.isWorkflow = true;
if (rui.manifest) {
    assistantMessage.workflowData = rui.manifest;
}
```

Keep only `assistantMessage.workflow = workflowMeta;`.

---

### Step 10: Build

Run `buildClient.sh` or manually copy modified source files into the
release directory (if one exists for this deployment).

---

## 5. Implementation Order

| Order | Step | File(s) | Risk | Reason |
|-------|------|---------|------|--------|
| 1 | Step 1 | `CopilotApi.js` | Low | Additive — new method + small edit to existing helper |
| 2 | Step 2 | `CopilotToolHandler.js` | Medium | Core SSE parsing replacement — must handle all payload shapes |
| 3 | Step 3 | `CopilotInput.js` | Low | Drop flat fields from merge function |
| 4 | Step 4 | `ChatMessage.js` | High | Largest change — delete old renderers, add unified `renderWorkflowCard()`, refactor `showWorkflowDialog()` |
| 5 | Step 5 | `CopilotDisplay.js` | Low | Additive scan for msg.workflow |
| 6 | Step 6 | `WorkflowsExplorerAdapter.js` | Medium | Replace per-ID fetch with batch |
| 7 | Step 7 | `ChatSessionContainer.js` | Medium | Both `_applySessionWorkflowContext()` and `_handleWorkflowCardStatusUpdated()` |
| 8 | Step 8 | Gateway `agentOrchestrator.js` | High | Legacy agent path — must deploy simultaneously with frontend |
| 9 | Step 9 | Gateway `orchestratorClient.js` | Low | Remove legacy writes |
| 10 | Step 10 | Build | Low | Mechanical |

---

## 6. What Gets Deleted

### `CopilotToolHandler.js`

| Lines | Function / Block | Replaced By |
|-------|-----------------|-------------|
| 28-272 | `_processWorkflowManifest()` (6 paths) | New single-path `_processWorkflowManifest()` |
| 742-770 | `_normalizeServicePlanResponse()` | Deleted (no longer needed) |
| 1076-1079 | `processMessageContent()` workflow return block | Returns `workflow` instead of `isWorkflow`/`workflowData` |

### `ChatMessage.js`

| Lines | Function / Block | Replaced By |
|-------|-----------------|-------------|
| 442-462 | Re-inference block (source_tool → isWorkflow) | Deleted (msg.workflow is persisted) |
| 526-537 | "Already processed" workflow check | Check `msg.workflow.workflow_id` instead |
| 581-582 | `processedData` spread (isWorkflow, workflowData) | Spread `processedData.workflow` |
| 743-754 | `hasWorkflowIdentity` + dispatch conditions | `msg.workflow.workflow_id` check |
| 2302-2432 | `renderSimplifiedServiceCard()` | `renderWorkflowCard()` |
| 2440-2713 | `renderWorkflowManifestCard()` | `renderWorkflowCard()` |
| 2886-3022 | `showWorkflowDialog()` (reads/writes `this.message.workflowData`) | `_openWorkflowDialog(workflowData)` (accepts parameter) |

### `CopilotInput.js`

| Lines | Code | Replaced By |
|-------|------|-------------|
| 157-159 | `isWorkflow`, `workflowData`, `workflow_id` assignments | `workflow` object assignment |

### `CopilotApi.js` `submitCopilotQueryStream()`

| Lines | Code | Replaced By |
|-------|------|-------------|
| 382-387 | `buildToolMetadata()` `isWorkflow`/`workflowData` block | `workflow` object copy |

### `ChatSessionContainer.js`

| Lines | Code | Replaced By |
|-------|------|-------------|
| 1130 | `message.workflowData = updatedWorkflow` | Write to `message.workflow.status` |

### Gateway `agentOrchestrator.js` (Step 8, simultaneous with frontend)

| Lines | Code | Replaced By |
|-------|------|-------------|
| 456-466 | `buildDisplayMetadata()` returns `isWorkflow`, `workflow_id` | Returns `workflow` nested object |
| 1688-1708 | `assistantMessage.workflow_id/workflowData/isWorkflow` writes | `assistantMessage.workflow` nested object |

### Gateway `orchestratorClient.js` (Step 9, after frontend deploy)

| Lines | Code | Replaced By |
|-------|------|-------------|
| 837-842 | Legacy flat field writes | Already have `assistantMessage.workflow` |

---

## 7. Backward Compatibility with Old Persisted Messages

Old messages in the DB have `isWorkflow`, `workflowData`, and `workflow_id`
but no `msg.workflow`. These messages exist in production session history.

**Two options:**

### Option A: One-time migration script (recommended)

Write a migration script that scans all `chat_sessions` in MongoDB and,
for any message with `isWorkflow === true` and `workflow_id`, adds a
`workflow` object:

```javascript
db.chat_sessions.find({ "messages.isWorkflow": true }).forEach(function(session) {
    session.messages.forEach(function(msg, i) {
        if (msg.isWorkflow && msg.workflow_id && !msg.workflow) {
            msg.workflow = {
                workflow_id: msg.workflow_id,
                status: (msg.workflowData && msg.workflowData.execution_metadata &&
                         msg.workflowData.execution_metadata.status) || 'planned',
                persisted: true,
                workflow_name: (msg.workflowData && msg.workflowData.workflow_name) || null,
                step_count: (msg.workflowData && msg.workflowData.steps &&
                             msg.workflowData.steps.length) || null
            };
        }
    });
    db.chat_sessions.updateOne(
        { _id: session._id },
        { $set: { messages: session.messages } }
    );
});
```

After migration, the legacy fields can optionally be stripped in a
follow-up pass.

### Option B: Fallback in ChatMessage.renderMessage()

If a migration script is not practical, add a one-time bridge in
`renderMessage()` that checks for old messages:

```javascript
// Bridge for pre-migration messages — remove after migration
if (!this.message.workflow && this.message.isWorkflow && this.message.workflow_id) {
    this.message.workflow = {
        workflow_id: this.message.workflow_id,
        status: (this.message.workflowData && this.message.workflowData.execution_metadata
                 && this.message.workflowData.execution_metadata.status) || 'planned',
        persisted: true,
        workflow_name: (this.message.workflowData && this.message.workflowData.workflow_name) || null,
        step_count: (this.message.workflowData && this.message.workflowData.steps
                     && this.message.workflowData.steps.length) || null
    };
}
```

This block is temporary and can be removed after the migration runs.

---

## 8. Testing

No tests currently exist for the workflow UI path. The following manual
test scenarios should be verified, and ideally automated tests added.

### Manual Test Matrix

| # | Scenario | Verify |
|---|----------|--------|
| T1 | Plan a workflow via orchestrator path | Card appears with name, step count, status "PLANNED", Review and Submit buttons |
| T2 | Plan a workflow via legacy agent path | Same as T1 (verifies `agentOrchestrator.js` update) |
| T3 | Click Submit on a planned card | Button shows "Submitting...", then "Submitted". Badge updates. Session workflow_ids updated. |
| T4 | Click Review on a planned card | Full workflow loads from engine. Single-step → Dojo form opens. Multi-step → WorkflowEngine dialog opens. |
| T5 | Click Check Status on a submitted card | Badge updates to live status from engine |
| T6 | Reload session with workflow messages | Cards re-render correctly from `msg.workflow` (no re-inference from source_tool) |
| T7 | Reload session with OLD messages (pre-migration) | Either: (a) migration script has run → cards render from `msg.workflow`; or (b) bridge code converts flat fields → cards render |
| T8 | Workflow engine persistence fails (`persisted: false`) | No card rendered. Inline warning appears. |
| T9 | Workflows panel loads | Sidebar shows workflows via batch-status endpoint. Fallback works if engine is down. |
| T10 | Workflow engine is unreachable | Review button shows error notification. Submit button shows error. Batch status falls back gracefully. |

### Automated Test Recommendations

Add tests to `copilot/tests/`:

1. **CopilotToolHandler `_processWorkflowManifest` test** — Verify the
   new single-path function correctly extracts `workflow` from various
   payload shapes (object, string-wrapped, call-envelope-wrapped).
2. **ChatMessage workflow card rendering test** — Verify `renderWorkflowCard()`
   renders correct DOM for planned/submitted/running/failed states.
3. **ChatSessionContainer status update test** — Verify
   `_handleWorkflowCardStatusUpdated()` correctly updates `message.workflow.status`.

---

## 9. Acceptance Criteria

1. New workflow messages from **both** the orchestrator path and the
   legacy agent path render a card with correct name, step count, status
   badge, Review button, and Submit button.
2. "Submit" button submits via the `/workflows/{id}/submit` endpoint
   (submit-by-ID path) and updates the badge to the new status.
3. "Review" button fetches the full workflow from the engine and opens
   the existing WorkflowEngine dialog or Dojo service form.
4. "Check Status" button refreshes the status badge from the engine.
5. `persisted === false` renders an inline warning, no card, no Submit button.
6. Session Workflows panel loads statuses via the batch endpoint.
7. Session reload correctly finds workflow IDs from `msg.workflow` on
   persisted messages.
8. Old persisted messages with legacy flat fields still render correctly
   (via migration or bridge code).
9. No references to `isWorkflow`, `workflowData`, or flat `workflow_id`
   remain in the frontend source (except the temporary bridge if Option B).
10. `CopilotWorkflowCardStatusUpdated` topic correctly updates
    `message.workflow.status` (not `message.workflowData`).

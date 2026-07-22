/**
 * PlanCard — Interactive plan card widget for the Planning Agent.
 *
 * Three visual modes:
 *   - Display: Shows the plan with steps, agent badges, status icons.
 *     Buttons: Edit Plan, Approve & Execute, Regenerate
 *   - Edit: Steps are draggable, editable, deletable. Add Step button.
 *   - Execution: Steps update in-place with status. Auto-advance between steps.
 *
 * Subscribes to CopilotPlanStepUpdate topic for real-time step status updates.
 */
define([
  'dojo/_base/declare',
  'dojo/_base/lang',
  'dojo/_base/array',
  'dijit/_WidgetBase',
  'dojo/dom-construct',
  'dojo/dom-class',
  'dojo/dom-attr',
  'dojo/on',
  'dojo/topic',
  'dojo/query',
  'p3/widget/copilot/PlanResultSanitizer'
], function (
  declare, lang, array, _WidgetBase,
  domConstruct, domClass, domAttr, on, topic, dojoQuery, PlanResultSanitizer
) {

  // Agent badge colors
  var AGENT_COLORS = {
    data: '#3b82f6',
    service: '#22c55e',
    workspace: '#a855f7',
    helpdesk: '#f59e0b',
    analysis: '#ef4444',
    review: '#0ea5e9',
    direct: '#6b7280'
  };

  // Status icons
  var STATUS_ICONS = {
    pending: '\u25CB',     // ○
    running: '\u23F3',     // ⏳
    completed: '\u2705',   // ✅
    failed: '\u274C',      // ❌
    skipped: '\u2298'      // ⊘
  };

  return declare([_WidgetBase], {

    plan: null,              // Plan object
    copilotApi: null,        // CopilotApi instance
    sessionId: null,
    containerNode: null,

    // Internal state
    _mode: 'display',        // 'display' | 'edit' | 'executing'
    _paused: false,
    _completedResults: null,  // {step_id: result_data}
    _stepNodes: null,         // Map of step_id -> DOM node
    _topicHandles: null,
    _reviewData: null,        // Active review step data (from plan_review_ready)
    _reviewStepId: null,      // step_id of the active review step
    _waitingForWorkflow: null, // {submission_id, workflow_id, step_id, step_index} when paused for workflow
    _workflowPollInterval: null, // setInterval handle for polling workflow status

    constructor: function (params) {
      this.plan = params.plan || {};
      this.copilotApi = params.copilotApi || null;
      this.sessionId = params.sessionId || null;
      this._completedResults = PlanResultSanitizer.sanitizeCompletedResults(
        params.completedResults || {}
      );
      this._stepNodes = {};
      this._topicHandles = [];

      // Restore review state from plan data if it was attached by
      // CopilotInput's CopilotPlanReviewReady subscriber (survives
      // showMessages re-renders that destroy and recreate PlanCard).
      this._reviewData = this.plan._activeReviewData || null;
      this._reviewStepId = this.plan._activeReviewStepId || null;
      if (this._reviewData) {
        this._paused = true;
      }

      // Restore workflow waiting state from persisted plan data.
      // Polling will be started in postCreate after topics are subscribed.
      if (this.plan._waitingForWorkflow) {
        this._waitingForWorkflow = this.plan._waitingForWorkflow;
        this._paused = true;
      }
      this._workflowPollInterval = null;

      // Infer initial mode from persisted plan/step statuses.
      // On page reload, steps may already be completed/failed/skipped.
      var planStatus = this.plan.status || 'draft';
      if (planStatus === 'completed') {
        this._mode = 'display';
      } else if (planStatus === 'executing' || planStatus === 'approved') {
        // Plan was mid-execution when page was reloaded.
        // Check if any steps are still pending/running.
        var hasActive = (this.plan.steps || []).some(function (s) {
          return s.status === 'pending' || s.status === 'running';
        });
        // If a step was 'running' at persist time, it was interrupted by
        // the reload -- revert it to 'pending' so it can be re-executed.
        (this.plan.steps || []).forEach(function (s) {
          if (s.status === 'running') {
            s.status = 'pending';
          }
        });
        if (hasActive) {
          this._mode = 'executing';
        } else {
          // All steps finished but plan status wasn't updated -- fix it
          this.plan.status = 'completed';
          this._mode = 'display';
        }
      }
    },

    postCreate: function () {
      this.inherited(arguments);

      // Subscribe to step update events
      var handle = topic.subscribe('CopilotPlanStepUpdate', lang.hitch(this, '_onStepUpdate'));
      this._topicHandles.push(handle);

      // Subscribe to review-ready events
      var reviewHandle = topic.subscribe('CopilotPlanReviewReady', lang.hitch(this, '_onReviewReady'));
      this._topicHandles.push(reviewHandle);

      // Subscribe to plan exit events (from PlanTracker)
      var exitHandle = topic.subscribe('CopilotPlanExit', lang.hitch(this, '_onPlanExit'));
      this._topicHandles.push(exitHandle);

      // Subscribe to workflow submitted events (pauses plan for long-running workflows)
      var wfSubHandle = topic.subscribe('CopilotPlanWorkflowSubmitted', lang.hitch(this, '_onWorkflowSubmitted'));
      this._topicHandles.push(wfSubHandle);

      // Subscribe to workflow completion events (resumes paused plan)
      var wfCompleteHandle = topic.subscribe('CopilotWorkflowComplete', lang.hitch(this, '_onWorkflowComplete'));
      this._topicHandles.push(wfCompleteHandle);

      // If the plan was mid-execution when the page was reloaded,
      // re-activate the sticky tracker so the user can see progress
      // and resume execution.
      if (this._mode === 'executing') {
        var self = this;
        setTimeout(function () {
          topic.publish('CopilotPlanTrackerActivate', {
            plan: self.plan,
            sessionId: self.sessionId,
            planCardNode: self.domNode,
            completedResults: self._completedResultsForPublish()
          });
        }, 500);  // Small delay to let CopilotDisplay finish mounting
      }

      // If we restored a _waitingForWorkflow state from a page reload,
      // start polling for completion now that everything is set up.
      if (this._waitingForWorkflow) {
        this._startWorkflowPoll();
      }
    },

    buildRendering: function () {
      this.domNode = domConstruct.create('div', {
        'class': 'plan-card'
      });
      this._render();
    },

    _render: function () {
      this.domNode.innerHTML = '';
      this._stepNodes = {};

      if (this._mode === 'edit') {
        this._renderEditMode();
      } else {
        this._renderDisplayMode();
      }
    },

    // =========================================================================
    // Display Mode
    // =========================================================================

    _renderDisplayMode: function () {
      var self = this;
      var plan = this.plan;

      // Title bar
      var titleBar = domConstruct.create('div', {
        'class': 'plan-card-title-bar'
      }, this.domNode);

      domConstruct.create('span', {
        'class': 'plan-card-title',
        innerHTML: plan.title || 'Untitled Plan'
      }, titleBar);

      // Status badge
      var statusText = plan.status || 'draft';
      if (this._mode === 'executing') {
        var completedCount = 0;
        (plan.steps || []).forEach(function (s) {
          if (s.status === 'completed' || s.status === 'skipped') completedCount++;
        });
        if (this._waitingForWorkflow) {
          statusText = 'Waiting for workflow (' + completedCount + '/' + plan.steps.length + ')';
        } else if (this._workflowCompleteData) {
          statusText = 'Workflow done (' + completedCount + '/' + plan.steps.length + ')';
        } else {
          statusText = 'Executing (' + completedCount + '/' + plan.steps.length + ')';
        }
      }
      domConstruct.create('span', {
        'class': 'plan-card-status plan-card-status-' + (plan.status || 'draft'),
        innerHTML: statusText
      }, titleBar);

      // Steps list
      var stepsList = domConstruct.create('div', {
        'class': 'plan-card-steps'
      }, this.domNode);

      (plan.steps || []).forEach(function (step, idx) {
        self._renderStep(step, idx, stepsList);

        // Render review panel inline after the review step
        if (self._reviewData && step.step_id === self._reviewStepId) {
          self._renderReviewPanel(stepsList);
        }
      });

      // Action buttons
      var actions = domConstruct.create('div', {
        'class': 'plan-card-actions'
      }, this.domNode);

      if (this._mode === 'executing') {
        // Executing mode buttons
        if (this._waitingForWorkflow) {
          // Waiting for a long-running workflow to complete
          domConstruct.create('span', {
            'class': 'plan-card-workflow-waiting',
            innerHTML: 'Workflow running — waiting for completion...'
          }, actions);
        } else if (this._workflowCompleteData) {
          // Workflow finished — show Continue button
          var wfStatus = this._workflowCompleteData.status || 'completed';
          var wfLabel = (wfStatus === 'completed' || wfStatus === 'succeeded')
            ? 'Workflow completed'
            : wfStatus === 'failed' ? 'Workflow failed' : 'Workflow ' + wfStatus;

          domConstruct.create('span', {
            'class': 'plan-card-workflow-done plan-card-workflow-' + wfStatus,
            innerHTML: wfLabel + '.'
          }, actions);

          var continueBtn = domConstruct.create('button', {
            'class': 'plan-card-btn plan-card-btn-primary',
            innerHTML: 'Continue Plan'
          }, actions);
          on(continueBtn, 'click', function () {
            self._paused = false;
            self._workflowCompleteData = null;
            self._executeNextPendingStep();
          });
        } else if (!this._paused) {
          var pauseBtn = domConstruct.create('button', {
            'class': 'plan-card-btn plan-card-btn-secondary',
            innerHTML: 'Pause'
          }, actions);
          on(pauseBtn, 'click', function () {
            self._paused = true;
            self._render();
          });
        } else {
          var resumeBtn = domConstruct.create('button', {
            'class': 'plan-card-btn plan-card-btn-primary',
            innerHTML: 'Resume'
          }, actions);
          on(resumeBtn, 'click', function () {
            self._paused = false;
            self._executeNextPendingStep();
          });
        }

        var editRemBtn = domConstruct.create('button', {
          'class': 'plan-card-btn plan-card-btn-secondary',
          innerHTML: 'Edit Remaining Steps'
        }, actions);
        on(editRemBtn, 'click', function () {
          self._mode = 'edit';
          self._render();
        });

      } else {
        // Display mode buttons
        var editBtn = domConstruct.create('button', {
          'class': 'plan-card-btn plan-card-btn-secondary',
          innerHTML: 'Edit Plan'
        }, actions);
        on(editBtn, 'click', function () {
          self._mode = 'edit';
          self._render();
        });

        var approveBtn = domConstruct.create('button', {
          'class': 'plan-card-btn plan-card-btn-primary',
          innerHTML: 'Approve & Execute'
        }, actions);
        on(approveBtn, 'click', function () {
          self._approvePlan();
        });

        var regenBtn = domConstruct.create('button', {
          'class': 'plan-card-btn plan-card-btn-secondary',
          innerHTML: 'Regenerate'
        }, actions);
        on(regenBtn, 'click', function () {
          topic.publish('CopilotPlanRegenerate', {
            plan: self.plan,
            sessionId: self.sessionId
          });
        });
      }
    },

    _renderStep: function (step, idx, parentNode) {
      var stepNode = domConstruct.create('div', {
        'class': 'plan-step plan-step-' + (step.status || 'pending'),
        'data-step-id': step.step_id
      }, parentNode);

      this._stepNodes[step.step_id] = stepNode;

      // Status icon
      var icon = STATUS_ICONS[step.status] || STATUS_ICONS.pending;
      domConstruct.create('span', {
        'class': 'plan-step-status-icon',
        innerHTML: icon
      }, stepNode);

      // Step number + description
      var textNode = domConstruct.create('div', {
        'class': 'plan-step-text'
      }, stepNode);

      domConstruct.create('span', {
        'class': 'plan-step-number',
        innerHTML: (idx + 1) + '. '
      }, textNode);

      domConstruct.create('span', {
        'class': 'plan-step-description',
        innerHTML: step.description || ''
      }, textNode);

      // Agent badge
      var agentColor = AGENT_COLORS[step.agent] || AGENT_COLORS.direct;
      domConstruct.create('span', {
        'class': 'plan-step-badge',
        innerHTML: (step.agent || 'unknown').toUpperCase(),
        style: 'background-color: ' + agentColor
      }, stepNode);

      // Dependencies
      if (step.depends_on && step.depends_on.length > 0) {
        domConstruct.create('div', {
          'class': 'plan-step-deps',
          innerHTML: 'depends on: ' + step.depends_on.join(', ')
        }, stepNode);
      }

      // Result summary (for completed steps)
      if (step.status === 'completed' && step.result_summary) {
        var resultDiv = domConstruct.create('div', {
          'class': 'plan-step-result'
        }, stepNode);

        var summary = step.result_summary;
        if (summary.length > 200) {
          summary = summary.substring(0, 200) + '...';
        }
        domConstruct.create('span', {
          innerHTML: summary
        }, resultDiv);
      }

      // Error message (for failed steps)
      if (step.status === 'failed') {
        var errorDiv = domConstruct.create('div', {
          'class': 'plan-step-error'
        }, stepNode);

        domConstruct.create('span', {
          innerHTML: step.error_message || 'Step failed'
        }, errorDiv);

        // Retry/Skip buttons for failed steps
        var failActions = domConstruct.create('div', {
          'class': 'plan-step-fail-actions'
        }, stepNode);

        var self = this;
        var retryBtn = domConstruct.create('button', {
          'class': 'plan-card-btn plan-card-btn-small',
          innerHTML: 'Retry'
        }, failActions);
        on(retryBtn, 'click', function () {
          self._retryStep(step, idx);
        });

        var skipBtn = domConstruct.create('button', {
          'class': 'plan-card-btn plan-card-btn-small plan-card-btn-secondary',
          innerHTML: 'Skip'
        }, failActions);
        on(skipBtn, 'click', function () {
          self._skipStep(step);
        });
      }

      // "Edit & Resubmit" button for the last executed step
      if (this._isLastExecutedStep(idx) && this._mode === 'executing') {
        var editResubActions = domConstruct.create('div', {
          'class': 'plan-step-edit-resubmit-actions'
        }, stepNode);

        var self = this;
        var editResubBtn = domConstruct.create('button', {
          'class': 'plan-card-btn plan-card-btn-small plan-card-btn-edit-resubmit',
          innerHTML: '\u270E Edit & Resubmit'
        }, editResubActions);
        on(editResubBtn, 'click', function () {
          self._showEditResubmit(step, idx, stepNode);
        });
      }
    },

    // =========================================================================
    // Edit Mode
    // =========================================================================

    _renderEditMode: function () {
      var self = this;
      var plan = this.plan;

      // Title
      var titleBar = domConstruct.create('div', {
        'class': 'plan-card-title-bar'
      }, this.domNode);

      domConstruct.create('span', {
        'class': 'plan-card-title',
        innerHTML: 'Edit Plan: ' + (plan.title || 'Untitled')
      }, titleBar);

      // Editable steps
      var stepsList = domConstruct.create('div', {
        'class': 'plan-card-steps plan-card-steps-edit'
      }, this.domNode);

      (plan.steps || []).forEach(function (step, idx) {
        // Only allow editing pending steps
        if (step.status !== 'pending') {
          // Render completed/running steps as non-editable
          self._renderStep(step, idx, stepsList);
          return;
        }

        var stepNode = domConstruct.create('div', {
          'class': 'plan-step plan-step-editable',
          draggable: 'true',
          'data-step-index': idx
        }, stepsList);

        // Drag handle
        domConstruct.create('span', {
          'class': 'plan-step-drag-handle',
          innerHTML: '\u2261'  // ≡
        }, stepNode);

        // Step number
        domConstruct.create('span', {
          'class': 'plan-step-number',
          innerHTML: (idx + 1) + '. '
        }, stepNode);

        // Editable description
        var descInput = domConstruct.create('input', {
          'class': 'plan-step-edit-input',
          type: 'text',
          value: step.description || ''
        }, stepNode);

        on(descInput, 'change', function () {
          step.description = descInput.value;
        });

        // Agent dropdown
        var agentSelect = domConstruct.create('select', {
          'class': 'plan-step-agent-select'
        }, stepNode);

        ['data', 'service', 'workspace', 'helpdesk', 'analysis', 'review', 'direct'].forEach(function (agentKey) {
          var opt = domConstruct.create('option', {
            value: agentKey,
            innerHTML: agentKey.charAt(0).toUpperCase() + agentKey.slice(1)
          }, agentSelect);
          if (agentKey === step.agent) {
            domAttr.set(opt, 'selected', 'selected');
          }
        });

        on(agentSelect, 'change', function () {
          step.agent = agentSelect.value;
        });

        // Delete button
        var deleteBtn = domConstruct.create('button', {
          'class': 'plan-step-delete-btn',
          innerHTML: '\u2715',  // ✕
          title: 'Delete step'
        }, stepNode);

        on(deleteBtn, 'click', function () {
          plan.steps.splice(idx, 1);
          self._render();
        });
      });

      // Add step button
      var addRow = domConstruct.create('div', {
        'class': 'plan-card-add-step'
      }, this.domNode);

      var addBtn = domConstruct.create('button', {
        'class': 'plan-card-btn plan-card-btn-secondary',
        innerHTML: '+ Add Step'
      }, addRow);

      on(addBtn, 'click', function () {
        plan.steps.push({
          step_id: 'step_' + (plan.steps.length + 1),
          description: '',
          agent: 'data',
          reasoning: 'User-added step',
          depends_on: [],
          status: 'pending'
        });
        self._render();
      });

      // Save / Cancel buttons
      var actions = domConstruct.create('div', {
        'class': 'plan-card-actions'
      }, this.domNode);

      var saveBtn = domConstruct.create('button', {
        'class': 'plan-card-btn plan-card-btn-primary',
        innerHTML: 'Save Changes'
      }, actions);
      on(saveBtn, 'click', function () {
        self._mode = (plan.status === 'executing') ? 'executing' : 'display';
        self._render();
        // Publish edit event
        topic.publish('CopilotPlanEdited', {
          plan: self.plan,
          sessionId: self.sessionId
        });
      });

      var cancelBtn = domConstruct.create('button', {
        'class': 'plan-card-btn plan-card-btn-secondary',
        innerHTML: 'Cancel'
      }, actions);
      on(cancelBtn, 'click', function () {
        self._mode = (plan.status === 'executing') ? 'executing' : 'display';
        self._render();
      });
    },

    // =========================================================================
    // Step Update Handler (from SSE events via topic)
    // =========================================================================

    _onStepUpdate: function (data) {
      if (!data || data.plan_id !== this.plan.plan_id) return;

      var step = this._findStep(data.step_id);
      if (!step) return;

      switch (data.event) {
        case 'started':
          step.status = 'running';
          // Ensure the PlanTracker is activated on first step execution.
          // Covers cases where execution starts without _approvePlan
          // (e.g. backend auto-execution or session restoration).
          if (this._mode !== 'executing') {
            topic.publish('CopilotPlanTrackerActivate', {
              plan: this.plan,
              sessionId: this.sessionId,
              planCardNode: this.domNode,
              completedResults: this._completedResultsForPublish()
            });
          }
          this._mode = 'executing';
          this.plan.status = 'executing';
          break;

        case 'completed':
          step.status = 'completed';
          step.result_summary = data.result_summary || '';
          if (data.agent_result) {
            this._storeCompletedResult(
              data.step_id,
              data.agent_result,
              data.structured_data
            );
          }
          // Auto-advance to next step if not paused
          if (!this._paused) {
            var self = this;
            // Check if the next step is a review step -- don't auto-advance
            // into review steps (the plan_review_ready event will handle it)
            var nextPending = null;
            for (var j = 0; j < this.plan.steps.length; j++) {
              if (this.plan.steps[j].status === 'pending') {
                nextPending = this.plan.steps[j];
                break;
              }
            }
            if (nextPending && nextPending.agent === 'review') {
              // Still auto-advance -- the review step will trigger
              // plan_review_ready which will pause execution
            }
            setTimeout(function () {
              self._executeNextPendingStep();
            }, 1000);
          }
          break;

        case 'failed':
          step.status = 'failed';
          step.error_message = data.error || 'Step failed';
          break;
      }

      // Check if all steps are done
      var allDone = this.plan.steps.every(function (s) {
        return s.status === 'completed' || s.status === 'skipped' || s.status === 'failed';
      });
      if (allDone) {
        this.plan.status = 'completed';
        this._mode = 'display';
      }

      // Persist step status to MongoDB so progress survives page reload
      this._persistPlanState();

      this._render();
    },

    // =========================================================================
    // Plan Execution
    // =========================================================================

    _approvePlan: function () {
      this.plan.status = 'approved';
      this._mode = 'executing';
      this._render();

      // Activate the sticky plan tracker
      topic.publish('CopilotPlanTrackerActivate', {
        plan: this.plan,
        sessionId: this.sessionId,
        planCardNode: this.domNode,
        completedResults: this._completedResultsForPublish()
      });

      topic.publish('CopilotPlanApproved', {
        plan: this.plan,
        sessionId: this.sessionId
      });
    },

    _executeNextPendingStep: function () {
      // Don't submit if paused (waiting for review)
      if (this._paused) return;

      // Don't submit if a step is already running
      var hasRunning = this.plan.steps.some(function (s) { return s.status === 'running'; });
      if (hasRunning) return;

      var nextStep = null;
      var nextIndex = -1;

      for (var i = 0; i < this.plan.steps.length; i++) {
        if (this.plan.steps[i].status === 'pending') {
          nextStep = this.plan.steps[i];
          nextIndex = i;
          break;
        }
      }

      if (!nextStep) {
        // All steps done
        this.plan.status = 'completed';
        this._mode = 'display';
        this._render();
        return;
      }

      topic.publish('CopilotPlanExecuteNext', {
        plan: this.plan,
        currentStepIndex: nextIndex,
        completedResults: this._completedResultsForPublish(),
        sessionId: this.sessionId
      });
    },

    _retryStep: function (step, idx) {
      step.status = 'pending';
      step.error_message = null;

      topic.publish('CopilotPlanExecuteNext', {
        plan: this.plan,
        currentStepIndex: idx,
        completedResults: this._completedResultsForPublish(),
        sessionId: this.sessionId
      });
    },

    _skipStep: function (step) {
      topic.publish('CopilotPlanSkipStep', {
        plan: this.plan,
        stepId: step.step_id,
        completedResults: this._completedResultsForPublish(),
        sessionId: this.sessionId
      });
    },

    // =========================================================================
    // Review Step Handling
    // =========================================================================

    _onReviewReady: function (data) {
      if (!data || data.plan_id !== this.plan.plan_id) return;

      this._paused = true;
      this._reviewData = data;
      this._reviewStepId = data.step_id;

      // Store on the plan object so _persistPlanState saves it to MongoDB
      // and it survives page reloads / session switches.
      this.plan._activeReviewData = data;
      this.plan._activeReviewStepId = data.step_id;

      // Mark the review step as running
      var step = this._findStep(data.step_id);
      if (step) {
        step.status = 'running';
      }

      // Persist so review state survives leaving and returning to this chat
      this._persistPlanState();

      this._render();
    },

    _renderReviewPanel: function (parentNode) {
      var self = this;
      var data = this._reviewData;
      if (!data) return;

      var reviewConfig = data.review_config || {};
      var sourceData = data.source_data || {};
      var structuredData = sourceData.structured_data || {};

      var panel = domConstruct.create('div', {
        'class': 'plan-review-panel'
      }, parentNode);

      // Group management review type -- delegate to PlanGroupManager widget
      if (reviewConfig.review_type === 'group_management') {
        require(['p3/widget/copilot/PlanGroupManager'], function (PlanGroupManager) {
          var groupManager = new PlanGroupManager({
            reviewConfig: reviewConfig,
            sourceData: sourceData,
            structuredData: structuredData,
            onComplete: function (selections) {
              self._submitReviewSelections(selections);
            },
            onSkip: function () {
              self._skipReviewStep();
            }
          });
          groupManager.placeAt(panel);
          groupManager.startup();
        });
        return;
      }

      // Review prompt
      domConstruct.create('div', {
        'class': 'plan-review-prompt',
        innerHTML: data.prompt || 'Review the results before continuing.'
      }, panel);

      // Data summary
      if (sourceData.answer) {
        var summaryDiv = domConstruct.create('div', {
          'class': 'plan-review-summary'
        }, panel);

        var summaryText = sourceData.answer;
        if (summaryText.length > 500) {
          summaryText = summaryText.substring(0, 500) + '...';
        }
        domConstruct.create('p', {
          innerHTML: summaryText
        }, summaryDiv);
      }

      // Structured data display
      if (structuredData.record_count !== undefined && structuredData.record_count !== null) {
        domConstruct.create('div', {
          'class': 'plan-review-stat',
          innerHTML: '<strong>Records found:</strong> ' + structuredData.record_count
        }, panel);
      }

      if (structuredData.collection) {
        domConstruct.create('div', {
          'class': 'plan-review-stat',
          innerHTML: '<strong>Collection:</strong> ' + structuredData.collection
        }, panel);
      }

      // Facet distributions
      if (structuredData.facets && Object.keys(structuredData.facets).length > 0) {
        var facetSection = domConstruct.create('div', {
          'class': 'plan-review-facets'
        }, panel);

        domConstruct.create('div', {
          'class': 'plan-review-facet-title',
          innerHTML: 'Distribution'
        }, facetSection);

        Object.keys(structuredData.facets).forEach(function (field) {
          var facet = structuredData.facets[field];
          var facetDiv = domConstruct.create('div', {
            'class': 'plan-review-facet'
          }, facetSection);

          domConstruct.create('span', {
            'class': 'plan-review-facet-label',
            innerHTML: field + ': '
          }, facetDiv);

          if (typeof facet === 'object' && !Array.isArray(facet)) {
            var entries = Object.entries(facet).slice(0, 10);
            var facetText = entries.map(function (e) { return e[0] + ' (' + e[1] + ')'; }).join(', ');
            if (Object.keys(facet).length > 10) {
              facetText += ', ... (' + Object.keys(facet).length + ' total)';
            }
            domConstruct.create('span', {
              innerHTML: facetText
            }, facetDiv);
          }
        });
      }

      // Workflow selector (for workflow_choice review types)
      var suggestedWorkflows = reviewConfig.suggested_workflows || [];
      if (reviewConfig.review_type === 'workflow_choice' || suggestedWorkflows.length > 0) {
        var wfSection = domConstruct.create('div', {
          'class': 'plan-review-workflow-section'
        }, panel);

        domConstruct.create('label', {
          innerHTML: 'Select analysis workflow:',
          'class': 'plan-review-label'
        }, wfSection);

        var wfSelect = domConstruct.create('select', {
          'class': 'plan-review-workflow-select'
        }, wfSection);

        domConstruct.create('option', {
          value: '',
          innerHTML: '-- Choose a workflow --'
        }, wfSelect);

        suggestedWorkflows.forEach(function (wf) {
          domConstruct.create('option', {
            value: wf,
            innerHTML: wf
          }, wfSelect);
        });
      }

      // Action buttons
      var reviewActions = domConstruct.create('div', {
        'class': 'plan-review-actions'
      }, panel);

      var continueBtn = domConstruct.create('button', {
        'class': 'plan-card-btn plan-card-btn-primary',
        innerHTML: 'Continue with Results'
      }, reviewActions);

      on(continueBtn, 'click', function () {
        var selections = {
          selected_ids: structuredData.record_ids || [],
          record_count: structuredData.record_count
        };

        // Capture chosen workflow if selector exists
        var wfSelectNode = dojoQuery('.plan-review-workflow-select', panel)[0];
        if (wfSelectNode && wfSelectNode.value) {
          selections.chosen_workflow = wfSelectNode.value;
        }

        self._submitReviewSelections(selections);
      });

      var skipBtn = domConstruct.create('button', {
        'class': 'plan-card-btn plan-card-btn-secondary',
        innerHTML: 'Skip Review'
      }, reviewActions);

      on(skipBtn, 'click', function () {
        self._skipReviewStep();
      });
    },

    _submitReviewSelections: function (selections) {
      var step = this._findStep(this._reviewStepId);
      if (step) {
        step.status = 'completed';
        step.result_summary = 'Review completed';
      }

      // Store selections as this step's result
      this._storeCompletedResult(this._reviewStepId, {
        answer: 'Review completed',
        status: 'completed',
        structured_data: selections
      });

      // Clear review state
      var reviewData = this._reviewData;
      this._reviewData = null;
      this._reviewStepId = null;
      this._paused = false;

      // Clear persisted review data from plan object
      delete this.plan._activeReviewData;
      delete this.plan._activeReviewStepId;

      // Persist review completion to MongoDB
      this._persistPlanState();

      topic.publish('CopilotPlanContinueReview', {
        plan: this.plan,
        currentStepIndex: reviewData.step_index,
        completedResults: this._completedResultsForPublish(),
        reviewSelections: selections,
        sessionId: this.sessionId
      });
    },

    _skipReviewStep: function () {
      var step = this._findStep(this._reviewStepId);
      if (step) {
        step.status = 'skipped';
      }

      this._reviewData = null;
      this._reviewStepId = null;
      this._paused = false;

      // Clear persisted review data from plan object
      delete this.plan._activeReviewData;
      delete this.plan._activeReviewStepId;

      // Persist skip to MongoDB
      this._persistPlanState();

      this._render();
      this._executeNextPendingStep();
    },

    /**
     * Handle plan exit from the PlanTracker. The tracker has already
     * marked remaining steps as skipped and set status to completed.
     * We just need to sync our local state and re-render.
     */
    _onPlanExit: function (data) {
      if (!data || !data.plan) return;
      if (data.plan.plan_id !== this.plan.plan_id) return;

      // Sync step statuses from the tracker's copy
      var exitedSteps = data.plan.steps || [];
      for (var i = 0; i < exitedSteps.length; i++) {
        if (i < this.plan.steps.length) {
          this.plan.steps[i].status = exitedSteps[i].status;
        }
      }
      this.plan.status = 'completed';

      // Clear any active review/workflow state
      this._reviewData = null;
      this._reviewStepId = null;
      this._stopWorkflowPoll();
      this._waitingForWorkflow = null;
      this._workflowCompleteData = null;
      delete this.plan._waitingForWorkflow;
      this._paused = false;
      this._mode = 'display';

      // Persist final state to MongoDB
      this._persistPlanState();

      this._render();
    },

    // =========================================================================
    // Workflow waiting (pause / resume for long-running workflows)
    // =========================================================================

    /**
     * Called when a plan step submits a long-running workflow.
     * Pauses plan execution and shows a "waiting" indicator.
     */
    _onWorkflowSubmitted: function (data) {
      if (!data || !data.plan_id) return;
      if (data.plan_id !== (this.plan.plan_id || this.plan.plan_name)) return;

      console.log('[PlanCard] Workflow submitted, pausing plan', data);

      this._waitingForWorkflow = {
        submission_id: data.submission_id,
        workflow_id: data.workflow_id,
        step_id: data.step_id,
        step_index: data.step_index
      };
      this._paused = true;

      // Persist the waiting state so it survives page reload
      this.plan._waitingForWorkflow = this._waitingForWorkflow;
      this._persistPlanState();

      // Start polling for workflow completion
      this._startWorkflowPoll();

      this._render();
    },

    /**
     * Called when a watched workflow reaches a terminal state.
     * Unpauses the plan and shows a "Continue Plan" button.
     */
    _onWorkflowComplete: function (data) {
      if (!data) return;

      // Match by workflow_id or submission_id
      if (!this._waitingForWorkflow) return;
      var waiting = this._waitingForWorkflow;
      var isMatch = (data.workflow_id && data.workflow_id === waiting.workflow_id) ||
                    (data.submission_id && data.submission_id === waiting.submission_id);
      if (!isMatch) return;

      console.log('[PlanCard] Workflow completed, allowing plan to resume', data);

      // Stop polling
      this._stopWorkflowPoll();

      // Store the workflow result for the step
      if (waiting.step_id) {
        this._storeCompletedResult(waiting.step_id, data);
      }

      // Clear waiting state but keep paused — let the user click "Continue"
      this._waitingForWorkflow = null;
      this._workflowCompleteData = data;
      delete this.plan._waitingForWorkflow;

      this._persistPlanState();
      this._render();
    },

    /**
     * Start polling the gateway for workflow watch status.
     * Called when entering _waitingForWorkflow state.
     */
    _startWorkflowPoll: function () {
      this._stopWorkflowPoll();  // Clear any existing interval

      if (!this._waitingForWorkflow || !this._waitingForWorkflow.submission_id) {
        return;
      }
      if (!this.copilotApi) {
        console.warn('[PlanCard] No copilotApi — cannot poll for workflow status');
        return;
      }

      var self = this;
      var submissionId = this._waitingForWorkflow.submission_id;
      var pollIntervalMs = 30000;  // 30 seconds

      console.log('[PlanCard] Starting workflow status poll', { submissionId, pollIntervalMs });

      this._workflowPollInterval = setInterval(function () {
        if (!self._waitingForWorkflow) {
          self._stopWorkflowPoll();
          return;
        }

        self.copilotApi.checkWorkflowWatchStatus(submissionId).then(function (watch) {
          if (!watch || !watch.status) return;

          // Terminal states: watch.status is "completed" or "failed"
          if (watch.status === 'completed' || watch.status === 'failed') {
            console.log('[PlanCard] Workflow poll detected completion', watch);

            // Synthesize a workflow_complete event for _onWorkflowComplete
            self._onWorkflowComplete({
              workflow_id: watch.workflow_id || '',
              submission_id: watch.submission_id || submissionId,
              status: watch.gowe_state ? watch.gowe_state.toLowerCase() : watch.status,
              completed_at: watch.completed_at,
              plan_id: watch.plan_id || null,
              step_id: watch.step_id || null,
              step_index: watch.step_index
            });
          }
        }).catch(function (err) {
          // Don't stop polling on transient errors
          console.warn('[PlanCard] Workflow poll error (will retry)', err);
        });
      }, pollIntervalMs);
    },

    /**
     * Stop the workflow status polling interval.
     */
    _stopWorkflowPoll: function () {
      if (this._workflowPollInterval) {
        clearInterval(this._workflowPollInterval);
        this._workflowPollInterval = null;
      }
    },

    // =========================================================================
    // Edit & Resubmit
    // =========================================================================

    /**
     * Check if the step at `idx` is the last completed or failed step
     * (i.e., the most recently executed step).
     */
    _isLastExecutedStep: function (idx) {
      var steps = this.plan.steps || [];
      var lastExecutedIdx = -1;
      for (var i = 0; i < steps.length; i++) {
        if (steps[i].status === 'completed' || steps[i].status === 'failed') {
          lastExecutedIdx = i;
        }
      }
      return idx === lastExecutedIdx && lastExecutedIdx >= 0;
    },

    /**
     * Show an inline editor below the step for editing its description
     * and resubmitting.
     */
    _showEditResubmit: function (step, idx, stepNode) {
      // Prevent opening multiple editors
      if (this._editResubmitNode) {
        domConstruct.destroy(this._editResubmitNode);
        this._editResubmitNode = null;
      }

      var self = this;
      var editor = domConstruct.create('div', {
        'class': 'plan-step-edit-resubmit-editor'
      }, stepNode);
      this._editResubmitNode = editor;

      domConstruct.create('label', {
        'class': 'plan-step-edit-resubmit-label',
        innerHTML: 'Edit the prompt for this step:'
      }, editor);

      var textarea = domConstruct.create('textarea', {
        'class': 'plan-step-edit-resubmit-textarea',
        value: step.description || '',
        rows: 3
      }, editor);

      var btnRow = domConstruct.create('div', {
        'class': 'plan-step-edit-resubmit-btns'
      }, editor);

      var submitBtn = domConstruct.create('button', {
        'class': 'plan-card-btn plan-card-btn-small plan-card-btn-primary',
        innerHTML: 'Resubmit'
      }, btnRow);
      on(submitBtn, 'click', function () {
        var newDesc = textarea.value.trim();
        if (!newDesc) return;
        self._submitEditResubmit(step, idx, newDesc);
      });

      var cancelBtn = domConstruct.create('button', {
        'class': 'plan-card-btn plan-card-btn-small plan-card-btn-secondary',
        innerHTML: 'Cancel'
      }, btnRow);
      on(cancelBtn, 'click', function () {
        domConstruct.destroy(editor);
        self._editResubmitNode = null;
      });

      // Focus the textarea
      setTimeout(function () { textarea.focus(); }, 50);
    },

    /**
     * Submit the edited step: update description, reset status, and
     * publish a topic so CopilotInput re-executes this step.
     */
    _submitEditResubmit: function (step, idx, newDescription) {
      // Update the step in the plan
      step.description = newDescription;
      step.status = 'pending';
      step.error_message = null;
      step.result_summary = null;

      // Remove completed result for this step so the agent re-executes it
      delete this._completedResults[step.step_id];

      // Clean up the editor
      if (this._editResubmitNode) {
        domConstruct.destroy(this._editResubmitNode);
        this._editResubmitNode = null;
      }

      // Persist the updated plan to MongoDB
      this._persistPlanState();

      // Re-render to reflect the updated step
      this._render();

      // Publish topic to execute the step with the new description
      topic.publish('CopilotPlanEditResubmit', {
        plan: this.plan,
        currentStepIndex: idx,
        completedResults: this._completedResultsForPublish(),
        sessionId: this.sessionId,
        editedDescription: newDescription
      });
    },

    // =========================================================================
    // Helpers
    // =========================================================================

    _storeCompletedResult: function (stepId, result, structuredDataOverride) {
      if (!stepId) return;
      this._completedResults[stepId] = PlanResultSanitizer.sanitizeResult(
        result,
        structuredDataOverride
      );
    },

    _completedResultsForPublish: function () {
      return PlanResultSanitizer.sanitizeCompletedResults(this._completedResults);
    },

    _findStep: function (stepId) {
      for (var i = 0; i < this.plan.steps.length; i++) {
        if (this.plan.steps[i].step_id === stepId) {
          return this.plan.steps[i];
        }
      }
      return null;
    },

    /**
     * Persist current plan state (step statuses, plan status) to MongoDB
     * via the editPlan API. Called after step status changes so that
     * progress survives page reloads.
     *
     * Debounced: rapid successive calls (e.g. step started + completed
     * in quick succession) are collapsed into a single API call.
     */
    _persistPlanState: function () {
      if (!this.copilotApi || !this.plan || !this.plan.plan_id) {
        return;
      }

      // Debounce: wait 500ms for additional changes before persisting
      if (this._persistTimeout) {
        clearTimeout(this._persistTimeout);
      }

      var self = this;
      this._persistTimeout = setTimeout(function () {
        self._persistTimeout = null;
        if (!self.copilotApi || !self.plan) return;

        self.copilotApi.editPlan(
          self.plan.plan_id,
          self.plan,
          self.sessionId
        ).then(
          function () {
            // Silent success -- no need to notify user
          },
          function (err) {
            console.warn('[PlanCard] Failed to persist plan state:', err);
          }
        );
      }, 500);
    },

    destroy: function () {
      this._stopWorkflowPoll();
      if (this._persistTimeout) {
        clearTimeout(this._persistTimeout);
      }
      if (this._editResubmitNode) {
        domConstruct.destroy(this._editResubmitNode);
        this._editResubmitNode = null;
      }
      this._topicHandles.forEach(function (h) {
        h.remove();
      });
      this._topicHandles = [];
      this.inherited(arguments);
    }
  });
});

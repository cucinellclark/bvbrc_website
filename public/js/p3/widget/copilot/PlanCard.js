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
  'dojo/query'
], function (
  declare, lang, array, _WidgetBase,
  domConstruct, domClass, domAttr, on, topic, dojoQuery
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

    constructor: function (params) {
      this.plan = params.plan || {};
      this.copilotApi = params.copilotApi || null;
      this.sessionId = params.sessionId || null;
      this._completedResults = params.completedResults || {};
      this._stepNodes = {};
      this._topicHandles = [];
      this._reviewData = null;
      this._reviewStepId = null;
    },

    postCreate: function () {
      this.inherited(arguments);

      // Subscribe to step update events
      var handle = topic.subscribe('CopilotPlanStepUpdate', lang.hitch(this, '_onStepUpdate'));
      this._topicHandles.push(handle);

      // Subscribe to review-ready events
      var reviewHandle = topic.subscribe('CopilotPlanReviewReady', lang.hitch(this, '_onReviewReady'));
      this._topicHandles.push(reviewHandle);
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
        statusText = 'Executing (' + completedCount + '/' + plan.steps.length + ')';
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
        if (!this._paused) {
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
          this._mode = 'executing';
          this.plan.status = 'executing';
          break;

        case 'completed':
          step.status = 'completed';
          step.result_summary = data.result_summary || '';
          if (data.agent_result) {
            var resultData = data.agent_result;
            if (data.structured_data) {
              resultData.structured_data = data.structured_data;
            }
            this._completedResults[data.step_id] = resultData;
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

      this._render();
    },

    // =========================================================================
    // Plan Execution
    // =========================================================================

    _approvePlan: function () {
      this.plan.status = 'approved';
      this._mode = 'executing';
      this._render();

      topic.publish('CopilotPlanApproved', {
        plan: this.plan,
        sessionId: this.sessionId
      });
    },

    _executeNextPendingStep: function () {
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
        completedResults: this._completedResults,
        sessionId: this.sessionId
      });
    },

    _retryStep: function (step, idx) {
      step.status = 'pending';
      step.error_message = null;

      topic.publish('CopilotPlanExecuteNext', {
        plan: this.plan,
        currentStepIndex: idx,
        completedResults: this._completedResults,
        sessionId: this.sessionId
      });
    },

    _skipStep: function (step) {
      topic.publish('CopilotPlanSkipStep', {
        plan: this.plan,
        stepId: step.step_id,
        completedResults: this._completedResults,
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

      // Mark the review step as running
      var step = this._findStep(data.step_id);
      if (step) {
        step.status = 'running';
      }

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
      this._completedResults[this._reviewStepId] = {
        answer: 'Review completed',
        status: 'completed',
        structured_data: selections
      };

      // Clear review state
      var reviewData = this._reviewData;
      this._reviewData = null;
      this._reviewStepId = null;
      this._paused = false;

      topic.publish('CopilotPlanContinueReview', {
        plan: this.plan,
        currentStepIndex: reviewData.step_index,
        completedResults: this._completedResults,
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

      this._render();
      this._executeNextPendingStep();
    },

    // =========================================================================
    // Helpers
    // =========================================================================

    _findStep: function (stepId) {
      for (var i = 0; i < this.plan.steps.length; i++) {
        if (this.plan.steps[i].step_id === stepId) {
          return this.plan.steps[i];
        }
      }
      return null;
    },

    destroy: function () {
      this._topicHandles.forEach(function (h) {
        h.remove();
      });
      this._topicHandles = [];
      this.inherited(arguments);
    }
  });
});

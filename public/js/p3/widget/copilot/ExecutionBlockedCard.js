/**
 * ExecutionBlockedCard — Rendered under an assistant message when a gated
 * tool (submit_gowe_job / create_group) was refused because the chat
 * session is in Plan mode.
 *
 * Lists what the agent prepared but did not run, and offers a single
 * "Switch to Execute mode and run" button.  Clicking it publishes
 * `CopilotExecutionModeRun`; CopilotInput persists execute mode and sends
 * a canned follow-up pinned to the agent that was blocked.
 *
 * The card payload is persisted on the assistant message (card_type
 * 'execution_blocked'), so it re-renders after a reload.
 */
define([
  'dojo/_base/declare',
  'dojo/_base/lang',
  'dijit/_WidgetBase',
  'dojo/dom-construct',
  'dojo/on',
  'dojo/topic'
], function (
  declare, lang, _WidgetBase,
  domConstruct, on, topic
) {
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return declare([_WidgetBase], {

    agent: null,            // Agent key that was blocked (e.g. 'service')
    blockedActions: null,   // Array of {tool, summary, arguments}
    originalQuery: null,
    sessionId: null,

    _runButton: null,
    _clicked: false,

    constructor: function (params) {
      this.agent = params.agent || null;
      this.blockedActions = Array.isArray(params.blockedActions) ? params.blockedActions : [];
      this.originalQuery = params.originalQuery || '';
      this.sessionId = params.sessionId || null;
    },

    buildRendering: function () {
      this.domNode = domConstruct.create('div', {
        'class': 'execution-blocked-card'
      });
      this._render();
    },

    _toolLabel: function (tool) {
      if (tool === 'submit_gowe_job') { return 'Job submission'; }
      if (tool === 'create_group') { return 'Group creation'; }
      return tool || 'Action';
    },

    _render: function () {
      var self = this;

      domConstruct.create('div', {
        'class': 'execution-blocked-header',
        innerHTML: '<i class="fa icon-pause"></i> Plan mode — nothing was submitted'
      }, this.domNode);

      var count = this.blockedActions.length;
      domConstruct.create('div', {
        'class': 'execution-blocked-body',
        innerHTML: count === 1
          ? 'The assistant prepared this action but did not run it:'
          : 'The assistant prepared these ' + count + ' actions but did not run them:'
      }, this.domNode);

      var list = domConstruct.create('ul', {
        'class': 'execution-blocked-list'
      }, this.domNode);
      this.blockedActions.forEach(function (action) {
        domConstruct.create('li', {
          innerHTML: '<span class="execution-blocked-tool">' + escapeHtml(self._toolLabel(action.tool)) + '</span> '
            + escapeHtml(action.summary || action.tool || '')
        }, list);
      });

      var actions = domConstruct.create('div', {
        'class': 'execution-blocked-actions'
      }, this.domNode);

      this._runButton = domConstruct.create('button', {
        type: 'button',
        'class': 'plan-card-btn plan-card-btn-primary execution-blocked-run',
        innerHTML: '<i class="fa icon-play"></i> Switch to Execute mode and run',
        title: 'Turns on Execute mode for this chat and asks the assistant to run what it prepared'
      }, actions);

      on(this._runButton, 'click', lang.hitch(this, this._onRunClick));
    },

    _onRunClick: function () {
      if (this._clicked) { return; }
      this._clicked = true;
      this._runButton.disabled = true;
      this._runButton.innerHTML = '✅ Switched to Execute mode';

      topic.publish('CopilotExecutionModeRun', {
        sessionId: this.sessionId,
        agent: this.agent,
        blocked_actions: this.blockedActions,
        original_query: this.originalQuery
      });
    }
  });
});

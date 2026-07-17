/**
 * @module p3/widget/CopilotInput
 * @description A widget that provides a text input interface for the PATRIC Copilot chat system.
 * Includes an auto-expanding textarea and submit button for sending queries to the Copilot API.
 *
 * Implementation:
 * - Extends ContentPane to provide base widget functionality
 * - Creates a textarea and submit button interface
 * - Handles auto-expansion of textarea based on content
 * - Manages submission of both regular and RAG-enhanced queries
 * - Maintains chat session state and history
 * - Provides model and RAG database selection UI
 */
define([
    'dojo/_base/declare', 'dojo/dom-construct', 'dojo/on', 'dijit/layout/ContentPane', 'dijit/form/Textarea', 'dijit/form/Button', 'dojo/topic', 'dojo/_base/lang', 'html2canvas/dist/html2canvas.min', './WorkspacePathUtils', './CopilotWorkspacePathPicker'
  ], function (
    declare, domConstruct, on, ContentPane, Textarea, Button, topic, lang, html2canvas, WorkspacePathUtils, CopilotWorkspacePathPicker
  ) {
    /**
     * @class CopilotInput
     * @extends {dijit/layout/ContentPane}
     */
    return declare([ContentPane], {
      /** Reference to the CopilotAPI instance for making backend requests */
      copilotApi: null,

      /** Flag indicating if this is a new chat session that needs initialization */
      new_chat: true,
      /** Tracks whether the current new-chat session has already been registered in backend */
      session_registered: false,

      /** Flag to prevent multiple simultaneous submissions */
      isSubmitting: false,

      /** True only when query pagination progress is active; controls abort button visibility */
      isQueryProgressActive: false,

      /** Custom system prompt to prepend to queries */
      systemPrompt: null,

      /** Selected language model for chat completion */
      model: null,

      /** Selected RAG database for enhanced responses */
      ragDb: null,

      statePrompt: null,

      /** Number of documents to use for RAG queries */
      numDocs: 10,

      // Widget styling
      style: 'padding: 0 5px 5px 5px; border: 0; height: 20%;',

      // Size constraints for the widget
      minSize: 40,
      maxSize: 200,

      // Flag to track page content toggle state
      pageContentEnabled: false,

      enhancedPrompt: null,
      selectedWorkspaceItems: [],
      selectedJobs: [],
      selectedWorkflows: [],
      attachedImages: [],
      attachedFiles: [],    // text file attachments [{id, name, content, size, mimeType}]
      imageUploadInput: null,
      imageActionNode: null,
      imageActionMenuNode: null,
      imageActionOutsideClickHandle: null,
      onImageAttachmentsChanged: null,
      _nextImageAttachmentId: 0,

      /**
       * Constructor that initializes the widget with provided options
       * Uses safeMixin to safely merge configuration arguments
       */
      constructor: function(args) {
        declare.safeMixin(this, args);
        this._nextImageAttachmentId = 0;
        this._topicHandles = [];
      },

      _toContextImageItems: function(entries) {
        if (!Array.isArray(entries)) {
          return [];
        }
        return entries.map(function(entry, index) {
          var attachment = entry && entry.attachment ? entry.attachment : {};
          var id = entry && entry.id ? entry.id : ('img-' + index);
          return {
            id: id,
            name: attachment.name || 'Uploaded image',
            source: attachment.source || 'upload',
            thumbnail: entry && typeof entry.image === 'string' ? entry.image : null
          };
        });
      },

      _emitImageAttachmentsChanged: function() {
        if (typeof this.onImageAttachmentsChanged !== 'function') {
          return;
        }
        var entries = Array.isArray(this.attachedImages) ? this.attachedImages.slice() : [];
        this.onImageAttachmentsChanged({
          sessionId: this.sessionId,
          entries: entries,
          items: this._toContextImageItems(entries)
        });
      },

      _escapeHtml: function(text) {
        if (typeof text !== 'string') {
          return text;
        }
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      },

      _getInputValue: function() {
        if (!this.textArea) {
          return '';
        }
        return this.textArea.get('value') || '';
      },

      _setInputTextValue: function(value) {
        if (!this.textArea) {
          return;
        }
        this.textArea.set('value', value || '');
        this._renderWorkspacePathTokenEditor();
      },

      _focusWorkspacePathInTextarea: function(match) {
        if (!match || !this.textArea || !this.textArea.textbox) {
          return;
        }
        var textbox = this.textArea.textbox;
        textbox.focus();
        if (typeof textbox.setSelectionRange === 'function') {
          textbox.setSelectionRange(match.start, match.end);
        }
      },

      _removeWorkspacePathFromInput: function(match) {
        if (!match) {
          return;
        }
        var currentValue = this._getInputValue();
        if (!currentValue) {
          return;
        }
        var nextValue = currentValue.slice(0, match.start) + currentValue.slice(match.end);
        nextValue = nextValue.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
        this._setInputTextValue(nextValue);
      },

      _renderWorkspacePathTokenEditor: function() {
        if (!this.workspacePathTokenEditorNode) {
          return;
        }
        domConstruct.empty(this.workspacePathTokenEditorNode);
        var value = this._getInputValue();
        var matches = WorkspacePathUtils.findPathMatches(value);
        if (!matches.length) {
          this.workspacePathTokenEditorNode.style.display = 'none';
          return;
        }

        this.workspacePathTokenEditorNode.style.display = 'flex';

        var tokenListNode = domConstruct.create('div', {
          className: 'workspacePathTokenEditorList'
        }, this.workspacePathTokenEditorNode);

        matches.forEach(lang.hitch(this, function(match) {
          var tokenNode = domConstruct.create('div', {
            className: 'workspacePathEditorToken'
          }, tokenListNode);

          var focusButton = domConstruct.create('button', {
            type: 'button',
            className: 'workspacePathEditorTokenFocus',
            title: 'Click to select this path in the text area'
          }, tokenNode);
          domConstruct.create('i', {
            className: 'fa icon-folder-open-o',
            style: 'margin-right: 4px; color: #5b7aa7;'
          }, focusButton);
          var segments = match.path.split('/').filter(function(s) { return s; });
          var displayName = segments.length > 1
            ? '\u2026/' + segments[segments.length - 1]
            : match.path;
          domConstruct.create('span', { textContent: displayName }, focusButton);
          focusButton.title = match.path;
          on(focusButton, 'click', lang.hitch(this, function(evt) {
            evt.preventDefault();
            this._focusWorkspacePathInTextarea(match);
          }));

          var removeButton = domConstruct.create('button', {
            type: 'button',
            className: 'workspacePathEditorTokenRemove',
            textContent: '\u00d7',
            title: 'Remove this path from the prompt'
          }, tokenNode);
          on(removeButton, 'click', lang.hitch(this, function(evt) {
            evt.preventDefault();
            this._removeWorkspacePathFromInput(match);
          }));
        }));
      },

      _openWorkspaceChooser: function() {
        var _self = this;
        var userPath = (window.App && window.App.user && window.App.user.id)
          ? '/' + window.App.user.id
          : '/';

        if (!this._workspacePicker) {
          this._workspacePicker = new CopilotWorkspacePathPicker({
            title: 'Select Workspace Path',
            path: userPath,
            onSelect: function(selectedPath) {
              if (!selectedPath || typeof selectedPath !== 'string') {
                return;
              }
              var pathOnly = selectedPath.trim();
              var current = _self._getInputValue();
              var separator = '';
              if (current.length > 0 && !/\s$/.test(current)) {
                separator = '\n';
              }
              _self._setInputTextValue(current + separator + pathOnly);
              if (_self.textArea) {
                _self.textArea.focus();
              }
            }
          });
        }
        this._workspacePicker.path = userPath;
        this._workspacePicker.show();
      },

      _getSelectedWorkspaceItemsForRequest: function() {
        if (!Array.isArray(this.selectedWorkspaceItems) || this.selectedWorkspaceItems.length === 0) {
          return [];
        }
        // Extract only path and type from items
        return this.selectedWorkspaceItems.map(function(item) {
          if (!item || item.selected === false || !item.path) {
            return null;
          }
          return {
            path: item.path,
            type: item.type || null
          };
        }).filter(function(item) {
          return item !== null && typeof item.path === 'string' && item.path.length > 0;
        });
      },

      _appendWorkspaceSelectionToStreamParams: function(params) {
        var selectedItems = this._getSelectedWorkspaceItemsForRequest();
        if (selectedItems.length > 0) {
          params.selected_workspace_items = selectedItems;
        }
        var selectedJobs = this._getSelectedJobsForRequest();
        if (selectedJobs.length > 0) {
          params.selected_jobs = selectedJobs;
        }
        var selectedWorkflows = this._getSelectedWorkflowsForRequest();
        if (selectedWorkflows.length > 0) {
          params.selected_workflows = selectedWorkflows;
        }
      },

      _applyToolMetadataToAssistantMessage: function(assistantMessage, toolMetadata) {
        if (!assistantMessage || !toolMetadata) {
          return;
        }

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

        // Planning agent
        if (toolMetadata.isPlan) {
          assistantMessage.isPlan = true;
          assistantMessage.planData = toolMetadata.planData;
        }
        if (toolMetadata.isPlanClarification) {
          assistantMessage.isPlanClarification = true;
          assistantMessage.clarificationData = toolMetadata.clarificationData;
        }
        if (toolMetadata.originalQuery) {
          assistantMessage.originalQuery = toolMetadata.originalQuery;
        }

        // UI action/payload
        assistantMessage.chatSummary = toolMetadata.chatSummary;
        assistantMessage.uiPayload = toolMetadata.uiPayload;
        assistantMessage.uiAction = toolMetadata.uiAction;
      },

      setSelectedWorkspaceItems: function(items) {
        this.selectedWorkspaceItems = Array.isArray(items) ? items.slice() : [];
        this._renderWorkspaceSelectionIndicator();
      },

      _getSelectedJobsForRequest: function() {
        if (!Array.isArray(this.selectedJobs) || this.selectedJobs.length === 0) {
          return [];
        }
        return this.selectedJobs.map(function(job) {
          if (!job || job.selected === false || job.id === null || job.id === undefined || job.id === '') {
            return null;
          }
          return {
            id: String(job.id),
            status: job.status || null,
            application_name: job.application_name || job.app || null
          };
        }).filter(function(job) {
          return job !== null;
        });
      },

      setSelectedJobs: function(items) {
        this.selectedJobs = Array.isArray(items) ? items.slice() : [];
        this._renderJobsSelectionIndicator();
      },

      _getSelectedWorkflowsForRequest: function() {
        if (!Array.isArray(this.selectedWorkflows) || this.selectedWorkflows.length === 0) {
          return [];
        }
        return this.selectedWorkflows.map(function(workflow) {
          if (!workflow || workflow.selected === false) {
            return null;
          }
          var workflowId = workflow.workflow_id || workflow.id;
          if (!workflowId) {
            return null;
          }
          return {
            workflow_id: String(workflowId),
            workflow_name: workflow.workflow_name || null,
            status: workflow.status || null,
            submitted_at: workflow.submitted_at || null,
            completed_at: workflow.completed_at || null
          };
        }).filter(function(workflow) {
          return workflow !== null;
        });
      },

      setSelectedWorkflows: function(items) {
        this.selectedWorkflows = Array.isArray(items) ? items.slice() : [];
      },

      _registerSessionIfNeeded: function() {
        if (!this.new_chat || this.session_registered || !this.copilotApi || !this.sessionId) {
          return Promise.resolve(false);
        }

        return this.copilotApi.registerSession(this.sessionId, 'New Chat').then(lang.hitch(this, function() {
          this.session_registered = true;

          if (window && window.App && window.App.chatSessionsStore) {
            window.App.chatSessionsStore.addSession({
              session_id: this.sessionId,
              title: 'New Chat',
              created_at: Date.now()
            });
          }

          topic.publish('reloadUserSessions', { highlightSessionId: this.sessionId });
          return true;
        }));
      },

      _submitCopilotQueryWithRegistration: function() {
        var args = arguments;
        return this._registerSessionIfNeeded().then(lang.hitch(this, function() {
          return this.copilotApi.submitCopilotQuery.apply(this.copilotApi, args);
        }));
      },

      _submitCopilotQueryStreamWithRegistration: function(params, onData, onEnd, onError, onProgress, onStatusMessage) {
        this._registerSessionIfNeeded().then(lang.hitch(this, function() {
          this.copilotApi.submitCopilotQueryStream(params, onData, onEnd, onError, onProgress, onStatusMessage);
        })).catch(function(error) {
          if (onError) {
            onError(error);
          }
        });
      },

      /**
       * Submits a planning agent action via the standard SSE streaming path.
       * Reuses _submitCopilotQueryStreamWithRegistration with target_agent='planning'
       * so all SSE events (plan_created, plan_step_*, ask_questions) flow through
       * the normal onData/onEnd/onError/onStatusMessage callbacks.
       *
       * @param {string} queryText - Human-readable description of the action
       * @param {string} sessionId - Chat session ID
       * @param {Object} workflowContext - Planning workflow context (plan_action, plan, etc.)
       */
      _submitPlanAction: function(queryText, sessionId, workflowContext) {
        var _self = this;

        // Prevent concurrent submissions
        if (this.isSubmitting) {
          console.warn('[CopilotInput] _submitPlanAction: already submitting, ignoring');
          return;
        }

        // Switch to Messages tab
        topic.publish('ChatMessageSubmitted');

        this.isSubmitting = true;
        this.isQueryProgressActive = false;
        this.submitButton.set('disabled', true);
        this._updateAbortButtonState();

        this.displayWidget.showLoadingIndicator(this.chatStore.query());

        var assistantMessage = null;
        var statusMessageId = null;
        var assistantMessageCreated = false;

        this.displayWidget.hideLoadingIndicator();

        var params = {
          inputText: queryText,
          sessionId: sessionId || this.sessionId,
          systemPrompt: '',
          model: this.model,
          save_chat: true,
          target_agent: 'planning',
          workflow_context: workflowContext
        };

        this._submitCopilotQueryStreamWithRegistration(params,
          function(chunk, toolMetadata) {
            // onData — same pattern as _handleRegularSubmitStream
            if (!assistantMessageCreated) {
              if (statusMessageId) {
                _self.chatStore.removeMessage(statusMessageId);
                statusMessageId = null;
              }
              assistantMessage = {
                role: 'assistant',
                content: '',
                message_id: 'assistant_' + Date.now(),
                timestamp: new Date().toISOString()
              };
              if (toolMetadata) {
                _self._applyToolMetadataToAssistantMessage(assistantMessage, toolMetadata);
              }
              _self.chatStore.addMessage(assistantMessage);
              assistantMessageCreated = true;
            }
            if (toolMetadata) {
              _self._applyToolMetadataToAssistantMessage(assistantMessage, toolMetadata);
            }
            assistantMessage.content += chunk;
            _self.displayWidget.showMessages(_self.chatStore.query());
          },
          function() {
            // onEnd
            _self.isSubmitting = false;
            _self.isQueryProgressActive = false;
            _self.submitButton.set('disabled', false);
            _self._updateAbortButtonState();
          },
          function(error) {
            // onError
            topic.publish('CopilotApiError', { error: error });
            _self.displayWidget.hideLoadingIndicator();
            _self.isSubmitting = false;
            _self.isQueryProgressActive = false;
            _self.submitButton.set('disabled', false);
            _self._updateAbortButtonState();
          },
          function(progressInfo) {
            // onProgress — silent for plan actions
          },
          function(statusMessage) {
            // onStatusMessage — same pattern as _handleRegularSubmitStream
            _self._handleAbortStatusMessageEvent(statusMessage);

            if (statusMessage.should_remove) {
              _self.chatStore.removeMessage(statusMessage.message_id);
              if (statusMessageId === statusMessage.message_id) {
                statusMessageId = null;
              }
            } else {
              statusMessageId = statusMessage.message_id;
              var existingMessage = _self.chatStore.getMessageById(statusMessage.message_id);
              if (existingMessage) {
                _self.chatStore.updateMessage(statusMessage);
              } else {
                _self.chatStore.addMessage(statusMessage);
              }
            }
            _self.displayWidget.showMessages(_self.chatStore.query());
          }
        );
      },

      /**
       * Sets up the widget UI after DOM creation
       * Implementation:
       * - Creates flex container layout
       * - Adds auto-expanding textarea
       * - Adds submit button
       * - Creates model/RAG selection UI
       * - Sets up event handlers
       */
      postCreate: function() {
        // Create main wrapper with flex layout
        var wrapperDiv = domConstruct.create('div', {
            style: 'display: flex; flex-direction: column; justify-content: center; align-items: center; width: 100%; height: 100%; padding-top: 2px; border: 0;'
        }, this.containerNode);

        // Container for input elements with flex layout
        var inputContainer = domConstruct.create('div', {
            style: 'display: flex; justify-content: center; align-items: flex-start; width: 100%;'
        }, wrapperDiv);

        // Add container for the split image button on the left side
        var toggleContainer = domConstruct.create('div', {
            style: 'width: auto; height: 60px; display: flex; flex-direction: row; align-items: center; margin-right: 15px; position: relative; gap: 8px;'
        }, inputContainer);

        // Image attachment counter (similar to workspace selection indicator) - positioned to the left
        this.imageAttachmentCounter = domConstruct.create('div', {
            className: 'imageAttachmentCounter',
            title: 'Attached images'
        }, toggleContainer);
        this.imageAttachmentCountNode = domConstruct.create('span', {
            className: 'imageAttachmentCount'
        }, this.imageAttachmentCounter);

        // Create split button container
        var splitButtonContainer = domConstruct.create('div', {
            className: 'imageSplitButtonContainer'
        }, toggleContainer);

        // Top half - Screenshot
        var screenshotHalf = domConstruct.create('button', {
            type: 'button',
            className: 'imageSplitButtonTop pageContentToggleInactive',
            innerHTML: 'Screenshot'
        }, splitButtonContainer);
        this.screenshotToggleNode = screenshotHalf;

        // Bottom half - Upload
        var uploadHalf = domConstruct.create('button', {
            type: 'button',
            className: 'imageSplitButtonBottom',
            innerHTML: 'Upload'
        }, splitButtonContainer);
        this.uploadImageNode = uploadHalf;

        this.imageUploadInput = domConstruct.create('input', {
            type: 'file',
            multiple: true,
            style: 'display: none;'
        }, wrapperDiv);

        this.pageContentToggle = {
            domNode: screenshotHalf
        };

        screenshotHalf.title = 'Include a screenshot of the current page with your next message.';
        uploadHalf.title = 'Attach images or text files from your computer.';

        on(screenshotHalf, 'click', lang.hitch(this, function(evt) {
            evt.preventDefault();
            evt.stopPropagation();
            if (!this._modelSupportsImage(this.model)) {
                return;
            }
            topic.publish('pageContentToggleChanged', !this.pageContentEnabled);
        }));

        on(uploadHalf, 'click', lang.hitch(this, function(evt) {
            evt.preventDefault();
            evt.stopPropagation();
            if (!this.imageUploadInput) {
                return;
            }
            this.imageUploadInput.click();
        }));

        on(this.imageUploadInput, 'change', lang.hitch(this, this._handleImageUploadChange));

        // Initialize button style
        this._updateToggleButtonStyle();

        // Textarea wrapper with workspace icon inside
        var textAreaWrapper = domConstruct.create('div', {
            className: 'copilotTextAreaWrapper',
            style: 'width: 60%; position: relative; margin-right: 10px;'
        }, inputContainer);

        // Configure textarea with auto-expansion and styling
        this.textArea = new Textarea({
            style: 'width: 100%; min-height: 50px; max-height: 100%; resize: none; overflow-y: hidden; border-radius: 5px; padding-bottom: 24px;',
            rows: 3,
            maxLength: 10000,
            placeholder: 'Enter your text here...'
        });

        // Add textarea to wrapper
        this.textArea.placeAt(textAreaWrapper);

        // Workspace path icon inside textarea border (bottom-left)
        var wsIconButton = domConstruct.create('button', {
            type: 'button',
            className: 'copilotWsPathInlineButton',
            title: 'Browse workspace to add a path to your message',
            innerHTML: '<i class="fa icon-folder-open-o"></i>'
        }, textAreaWrapper);
        on(wsIconButton, 'click', lang.hitch(this, function(evt) {
            evt.preventDefault();
            evt.stopPropagation();
            this._openWorkspaceChooser();
        }));

        // Path token chips row beneath textarea
        this.workspacePathTokenEditorNode = domConstruct.create('div', {
            className: 'workspacePathTokenEditor',
            style: 'display: none;'
        }, textAreaWrapper);

        // Configure submit button with click handler
        this.submitButton = new Button({
            label: 'Submit',
            style: 'height: 30px; margin-right: 10px;',
            onClick: lang.hitch(this, function() {
            // Prevent multiple simultaneous submissions
            if (this.isSubmitting) return;
            // Handle different submission types based on configuration
            if (this.pageContentEnabled) {
                this._handlePageSubmitStream();
            } else if (this.copilotApi && this.ragDb) {
                this._handleRagSubmitStream();
            } else if (this.copilotApi) {
                this._handleRegularSubmitStream();
            } else {
                console.error('CopilotApi widget not initialized');
            }
            })
        });

        // Add button to container
        this.submitButton.placeAt(inputContainer);

        this.abortButton = new Button({
            label: 'Abort',
            style: 'height: 30px; margin-right: 10px;',
            disabled: true,
            onClick: lang.hitch(this, function() {
                this._handleAbortClick();
            })
        });
        this.abortButton.placeAt(inputContainer);

        // Subscribe to page content toggle changes from ChatSessionOptionsBar
        this._topicHandles.push(topic.subscribe('pageContentToggleChanged', lang.hitch(this, function(checked) {
            if (!this._modelSupportsImage(this.model)) {
                this.pageContentEnabled = false;
                this._updateToggleButtonStyle();
                return;
            }
            this.pageContentEnabled = checked;
            this._updateToggleButtonStyle();
            console.log('Page content toggle changed to:', checked);
        })));

        // Subscribe to session changes to reset state
        this._topicHandles.push(topic.subscribe('ChatSession:Selected', lang.hitch(this, function(data) {
            // Reset screenshot toggle state
            this.pageContentEnabled = false;
            this._updateToggleButtonStyle();
            topic.publish('pageContentToggleChanged', false);

            // Clear attached images
            this._clearAttachedImage();

            // Clear selected workspace items
            this.selectedWorkspaceItems = [];
            this._renderWorkspaceSelectionIndicator();
            this.selectedJobs = [];
            this._renderJobsSelectionIndicator();
            this.selectedWorkflows = [];
        })));

        // Maximum height for textarea before scrolling
        const maxHeight = 200; // ~9 rows

        // Handle textarea auto-expansion on input
        on(this.textArea, 'input', function() {
            this.textArea.style.height = 'auto'; // Reset height
            this.textArea.style.height = (this.textArea.scrollHeight) + 'px'; // Expand to content

            // Enable scrolling if content exceeds max height
            if (this.textArea.scrollHeight > maxHeight) {
            this.textArea.style.height = maxHeight + 'px';
            this.textArea.style.overflowY = 'auto';
            } else {
            this.textArea.style.overflowY = 'hidden';
            }
            this._renderWorkspacePathTokenEditor();
        }.bind(this));

        // Update path tokens after paste (Dojo Textarea may not fire 'input' on paste)
        on(this.textArea, 'paste', lang.hitch(this, function() {
            setTimeout(lang.hitch(this, this._renderWorkspacePathTokenEditor), 0);
        }));

        // Also sync tokens on keyup to catch deletions, cut, and other edits
        on(this.textArea, 'keyup', lang.hitch(this, this._renderWorkspacePathTokenEditor));

        // Handle Enter key for submission (except with Shift)
        on(this.textArea, 'keypress', lang.hitch(this, function(evt) {
            if (evt.keyCode === 13 && !evt.shiftKey && !this.isSubmitting) {
            evt.preventDefault();
            this.submitButton.onClick();
            }
        }));

        this._topicHandles.push(topic.subscribe('enhancePromptChange', lang.hitch(this, function(enhancedPrompt) {
          this.enhancedPrompt = enhancedPrompt;
        })));

        // Subscribe to main chat suggestion selection to populate input text area
        this._topicHandles.push(topic.subscribe('populateInputSuggestion', lang.hitch(this, function(suggestion) {
          if (this.textArea) {
            this._setInputTextValue(suggestion);
            // Focus on the text area and place cursor at the end
            this.textArea.focus();
            if (this.textArea.textbox) {
              var textbox = this.textArea.textbox;
              textbox.selectionStart = textbox.selectionEnd = suggestion.length;
            }
          }
        })));

        // ==================== Planning Agent Topic Subscribers ====================

        // 1. CopilotPlanAnswerQuestions — user answered clarification questions
        this._topicHandles.push(topic.subscribe('CopilotPlanAnswerQuestions', lang.hitch(this, function(data) {
          if (!data || !data.answers) { return; }
          console.log('[CopilotInput] CopilotPlanAnswerQuestions received:', data);

          // Build a human-readable summary of answers as the query text
          var answerSummary = data.answers.map(function(a) {
            return a.question + ': ' + a.answer;
          }).join('\n');

          this._submitPlanAction(
            answerSummary || data.originalQuery || 'Answering clarification questions',
            data.sessionId,
            {
              plan_action: 'answer_questions',
              clarification_answers: data.answers,
              original_query: data.originalQuery || ''
            }
          );
        })));

        // 2. CopilotPlanApproved — user approved the plan, start step 0
        this._topicHandles.push(topic.subscribe('CopilotPlanApproved', lang.hitch(this, function(data) {
          if (!data || !data.plan) { return; }
          console.log('[CopilotInput] CopilotPlanApproved received:', data);

          this._submitPlanAction(
            'Execute approved plan: ' + (data.plan.plan_name || data.plan.plan_id || 'plan'),
            data.sessionId,
            {
              plan: data.plan,
              plan_action: 'execute_next',
              current_step_index: 0,
              completed_step_results: {}
            }
          );
        })));

        // 3. CopilotPlanExecuteNext — execute the next step in plan
        this._topicHandles.push(topic.subscribe('CopilotPlanExecuteNext', lang.hitch(this, function(data) {
          if (!data || !data.plan) { return; }
          console.log('[CopilotInput] CopilotPlanExecuteNext received:', data);

          var stepIndex = data.currentStepIndex || 0;
          var stepLabel = data.plan.steps && data.plan.steps[stepIndex]
            ? data.plan.steps[stepIndex].description || ('step ' + (stepIndex + 1))
            : 'step ' + (stepIndex + 1);

          this._submitPlanAction(
            'Execute plan step: ' + stepLabel,
            data.sessionId,
            {
              plan: data.plan,
              plan_action: 'execute_next',
              current_step_index: stepIndex,
              completed_step_results: data.completedResults || {}
            }
          );
        })));

        // 4. CopilotPlanSkipStep — skip a step during plan execution
        this._topicHandles.push(topic.subscribe('CopilotPlanSkipStep', lang.hitch(this, function(data) {
          if (!data || !data.plan || !data.stepId) { return; }
          console.log('[CopilotInput] CopilotPlanSkipStep received:', data);

          // Mark the step as skipped in the plan and advance to next
          var plan = data.plan;
          var nextIndex = 0;
          if (plan.steps) {
            for (var i = 0; i < plan.steps.length; i++) {
              if (plan.steps[i].step_id === data.stepId) {
                plan.steps[i].status = 'skipped';
                nextIndex = i + 1;
                break;
              }
            }
          }

          this._submitPlanAction(
            'Skip step and continue plan execution',
            data.sessionId,
            {
              plan: plan,
              plan_action: 'execute_next',
              current_step_index: nextIndex,
              completed_step_results: data.completedResults || {}
            }
          );
        })));

        // 5. CopilotPlanContinueReview — user completed a review step
        this._topicHandles.push(topic.subscribe('CopilotPlanContinueReview', lang.hitch(this, function(data) {
          if (!data || !data.plan) { return; }
          console.log('[CopilotInput] CopilotPlanContinueReview received:', data);

          this._submitPlanAction(
            'Continue after review',
            data.sessionId,
            {
              plan: data.plan,
              plan_action: 'continue_review',
              current_step_index: data.currentStepIndex,
              completed_step_results: data.completedResults || {},
              review_selections: data.reviewSelections || {}
            }
          );
        })));

        // 6. CopilotPlanEdited — user edited plan steps (non-streaming)
        this._topicHandles.push(topic.subscribe('CopilotPlanEdited', lang.hitch(this, function(data) {
          if (!data || !data.plan) { return; }
          console.log('[CopilotInput] CopilotPlanEdited received:', data);

          var planId = data.plan.plan_id;
          if (!planId) {
            console.warn('[CopilotInput] CopilotPlanEdited: no plan_id, ignoring');
            return;
          }
          this.copilotApi.editPlan(planId, data.plan, data.sessionId).then(
            function(result) {
              console.log('[CopilotInput] Plan edit saved:', result);
            },
            function(error) {
              console.error('[CopilotInput] Plan edit failed:', error);
              topic.publish('CopilotApiError', { error: error });
            }
          );
        })));

        // 6. CopilotPlanRegenerate — re-submit original query through normal chat flow
        this._topicHandles.push(topic.subscribe('CopilotPlanRegenerate', lang.hitch(this, function(data) {
          if (!data || !data.plan) { return; }
          console.log('[CopilotInput] CopilotPlanRegenerate received:', data);

          // Use the plan's original query if available, otherwise fallback
          var originalQuery = data.plan.original_query || data.plan.plan_name || 'Regenerate plan';
          this._setInputTextValue(originalQuery);
          // Trigger a fresh submit through the normal chat path
          this.submitButton.onClick();
        })));

        this._renderWorkspaceSelectionIndicator();
        this._renderJobsSelectionIndicator();
        this._updateImageCapabilityUI();
        this._updateAbortButtonState();
        this._renderWorkspacePathTokenEditor();
      },

      _isAbortableQueryTool: function(toolId) {
        if (!toolId || typeof toolId !== 'string') return false;
        var normalized = toolId.split('.').pop();
        return normalized === 'bvbrc_query_collection' ||
          normalized === 'query_collection' ||
          normalized === 'bvbrc_global_data_search' ||
          normalized === 'bvbrc_search_data';
      },

      _updateAbortButtonState: function() {
        if (!this.abortButton) return;
        var streamState = this.copilotApi && this.copilotApi.getCurrentStreamState
          ? this.copilotApi.getCurrentStreamState()
          : null;
        var activeToolId = streamState ? streamState.tool_id : null;
        var hasAbortableTool = !activeToolId || this._isAbortableQueryTool(activeToolId);
        var hasJobId = !!(streamState && streamState.job_id);
        var shouldShow = !!this.isQueryProgressActive;
        var shouldEnable = !!this.isSubmitting && shouldShow && hasJobId && hasAbortableTool;

        if (this.abortButton.domNode) {
          this.abortButton.domNode.style.display = shouldShow ? '' : 'none';
        }
        this.abortButton.set('disabled', !shouldEnable);
      },

      _handleAbortStatusMessageEvent: function(statusMessage) {
        if (!statusMessage || !statusMessage.event_type) return;
        if (statusMessage.event_type === 'query_progress') {
          this.isQueryProgressActive = true;
          this._updateAbortButtonState();
          return;
        }

        if (statusMessage.event_type === 'query_aborted' ||
            statusMessage.event_type === 'done' ||
            statusMessage.event_type === 'error') {
          this.isQueryProgressActive = false;
          this._updateAbortButtonState();
        }
      },

      _handleAbortClick: function() {
        if (!this.copilotApi || !this.isSubmitting) return;

        var streamState = this.copilotApi.getCurrentStreamState ? this.copilotApi.getCurrentStreamState() : null;
        var activeToolId = streamState ? streamState.tool_id : null;
        if (activeToolId && !this._isAbortableQueryTool(activeToolId)) {
          topic.publish('CopilotApiError', {
            error: new Error('Abort currently supports active data query tools only.')
          });
          return;
        }

        this.abortButton.set('disabled', true);
        this.abortButton.set('label', 'Aborting...');

        this.copilotApi.abortActiveQueryJob({
          user_id: this.copilotApi.user_id,
          scopes: ['query_tools'],
          reason: 'Aborted from copilot input button'
        }).then(lang.hitch(this, function() {
          // Keep disabled while backend finishes processing abort request.
          this.abortButton.set('label', 'Abort');
          // Keep disabled while backend finishes processing abort request.
          this.abortButton.set('disabled', true);
        })).catch(lang.hitch(this, function(error) {
          this.abortButton.set('label', 'Abort');
          this._updateAbortButtonState();
          topic.publish('CopilotApiError', { error: error });
        }));
      },

      _renderWorkspaceSelectionIndicator: function() {
        if (!this.workspaceSelectionIndicator || !this.workspaceSelectionCountNode) {
          return;
        }

        var selectedItems = Array.isArray(this.selectedWorkspaceItems) ? this.selectedWorkspaceItems : [];
        var count = selectedItems.length;
        var label = count === 1 ? '1 selected' : count + ' selected';
        var selectedItemLabels = selectedItems.map(function(item) {
          return item && item.path ? item.path : (item && item.name ? item.name : 'Unknown item');
        });

        this.workspaceSelectionCountNode.textContent = label;
        this.workspaceSelectionIndicator.title = count > 0
          ? ('Selected workspace files (' + count + ')' +
            (selectedItemLabels.length > 0 ? '\n' + selectedItemLabels.join('\n') : ''))
          : 'No workspace files selected';
        this.workspaceSelectionIndicator.classList.toggle('hasSelection', count > 0);
        this.workspaceSelectionIndicator.style.display = count > 0 ? 'inline-flex' : 'none';
      },

      _renderJobsSelectionIndicator: function() {
        if (!this.jobsSelectionIndicator || !this.jobsSelectionCountNode) {
          return;
        }
        var selectedItems = Array.isArray(this.selectedJobs) ? this.selectedJobs : [];
        var count = selectedItems.length;
        var label = count === 1 ? '1 job' : count + ' jobs';
        var selectedJobLabels = selectedItems.map(function(item) {
          var id = item && item.id ? item.id : 'Unknown job';
          var app = item && (item.application_name || item.app) ? (' (' + (item.application_name || item.app) + ')') : '';
          return id + app;
        });
        this.jobsSelectionCountNode.textContent = label;
        this.jobsSelectionIndicator.title = count > 0
          ? ('Selected jobs (' + count + ')' +
            (selectedJobLabels.length > 0 ? '\n' + selectedJobLabels.join('\n') : ''))
          : 'No jobs selected';
        this.jobsSelectionIndicator.classList.toggle('hasSelection', count > 0);
        this.jobsSelectionIndicator.style.display = count > 0 ? 'inline-flex' : 'none';
      },

      /**
       * Handles submission of RAG queries with document retrieval
       * Implementation:
       * - Immediately shows user message and clears text area
       * - Disables input during submission
       * - Shows loading indicator
       * - Retrieves documents via RAG API
       * - Builds system prompt with document context
       * - Makes follow-up LLM query with enhanced context
       * - Updates chat store with assistant/system messages only
       */
      _handleRagSubmit: function() {
        console.log('this.ragDb=', this.ragDb);
        var inputText = this.textArea.get('value');
        var _self = this;
        var uploadedImagePayload = this._getUploadedImagePayload();
        var hasUploadedImage = !!(uploadedImagePayload && Array.isArray(uploadedImagePayload.images) && uploadedImagePayload.images.length > 0 && this._modelSupportsImage(this.model));
        var submitModel = hasUploadedImage ? this._resolveImageModel() : this.model;

        if (this.state) {
          console.log('state', this.state);
        }

        // Immediately show user message and clear text area
        var userMessage = this._buildUserMessageForSubmit(
          inputText,
          hasUploadedImage ? uploadedImagePayload.attachments : null
        );

        this.chatStore.addMessage(userMessage);
        this.displayWidget.showMessages(this.chatStore.query());
        this._setInputTextValue('');

        this.isSubmitting = true;
        this.submitButton.set('disabled', true);

        this.displayWidget.showLoadingIndicator(this.chatStore.query());

        var systemPrompt = 'You are a helpful scientist website assistant for the website BV-BRC, the Bacterial and Viral Bioinformatics Resource Center.\n\n';
        if (this.systemPrompt) {
            systemPrompt += this.systemPrompt;
        }
        if (this.statePrompt) {
            systemPrompt += this.statePrompt;
        }
        if (hasUploadedImage) {
            systemPrompt += '\n\nThe user attached an image. Use it as additional context.';
        }

        this._submitCopilotQueryWithRegistration(inputText, this.sessionId, systemPrompt, submitModel, true, this.ragDb, this.numDocs, null, this.enhancedPrompt, lang.mixin({
          images: hasUploadedImage ? uploadedImagePayload.images : null
        }, {
          selected_workspace_items: this._getSelectedWorkspaceItemsForRequest(),
          selected_jobs: this._getSelectedJobsForRequest(),
          selected_workflows: this._getSelectedWorkflowsForRequest()
        })).then(lang.hitch(this, function(response) {
          // Only add assistant message and system message (if present) - user message was already added
          var messagesToAdd = [];
          if (response.systemMessage) {
            messagesToAdd.push(response.systemMessage);
          }
          if (response.assistantMessage) {
            messagesToAdd.push(response.assistantMessage);
          }

          if (messagesToAdd.length > 0) {
            this.chatStore.addMessages(messagesToAdd);
          }

          this.displayWidget.showMessages(this.chatStore.query());

          if (_self.new_chat) {
            _self._finishNewChat();
          }
        })).catch(function(error) {
          topic.publish('CopilotApiError', { error: error });
        }).finally(lang.hitch(this, function() {
          this.displayWidget.hideLoadingIndicator();
          this.isSubmitting = false;
          this.submitButton.set('disabled', false);
        }));
      },

      /**
       * Handles submission of regular (non-RAG) queries
       * Implementation:
       * - Immediately shows user message and clears text area
       * - Disables input during submission
       * - Shows loading indicator
       * - Makes LLM query with basic system prompt
       * - Updates chat store with assistant/system messages only
       * - Handles new chat initialization
       */
      _handleRegularSubmit: function() {
        var inputText = this.textArea.get('value');
        var _self = this;
        var uploadedImagePayload = this._getUploadedImagePayload();
        var hasUploadedImage = !!(uploadedImagePayload && Array.isArray(uploadedImagePayload.images) && uploadedImagePayload.images.length > 0 && this._modelSupportsImage(this.model));
        var submitModel = hasUploadedImage ? this._resolveImageModel() : this.model;
        if (this.state) {
          console.log('state', this.state);
        }

        // Immediately show user message and clear text area
        var userMessage = this._buildUserMessageForSubmit(
          inputText,
          hasUploadedImage ? uploadedImagePayload.attachments : null
        );

        this.chatStore.addMessage(userMessage);
        this.displayWidget.showMessages(this.chatStore.query());
        this._setInputTextValue('');

        this.isSubmitting = true;
        this.submitButton.set('disabled', true);

        this.displayWidget.showLoadingIndicator(this.chatStore.query());

        var systemPrompt = 'You are a helpful scientist website assistant for the website BV-BRC, the Bacterial and Viral Bioinformatics Resource Center.\n\n';
        if (this.systemPrompt) {
            systemPrompt += this.systemPrompt;
        }
        if (this.statePrompt) {
            systemPrompt += this.statePrompt;
        }
        if (hasUploadedImage) {
            systemPrompt += '\n\nThe user attached an image. Use it as additional context.';
        }

        this._submitCopilotQueryWithRegistration(inputText, this.sessionId, systemPrompt, submitModel, true, null, null, null, null, lang.mixin({
          images: hasUploadedImage ? uploadedImagePayload.images : null
        }, {
          selected_workspace_items: this._getSelectedWorkspaceItemsForRequest(),
          selected_jobs: this._getSelectedJobsForRequest(),
          selected_workflows: this._getSelectedWorkflowsForRequest()
        })).then(lang.hitch(this, function(response) {
          // Only add assistant message and system message (if present) - user message was already added
          var messagesToAdd = [];
          if (response.systemMessage) {
            messagesToAdd.push(response.systemMessage);
          }
          if (response.assistantMessage) {
            messagesToAdd.push(response.assistantMessage);
          }

          if (messagesToAdd.length > 0) {
            this.chatStore.addMessages(messagesToAdd);
          }

          this.displayWidget.showMessages(this.chatStore.query());

          if (_self.new_chat) {
            _self._finishNewChat();
          }
        })).catch(function(error) {
          topic.publish('CopilotApiError', { error: error });
        }).finally(lang.hitch(this, function() {
          this.displayWidget.hideLoadingIndicator();
          this.isSubmitting = false;
          this.submitButton.set('disabled', false);
        }));
      },

      /**
       * Resets widget state for new chat session
       * Clears textarea and sets new chat flag
       */
      startNewChat: function() {
        this.new_chat = true;
        this.session_registered = false;
        this._setInputTextValue('');

        // If an SSE stream was in progress, reset the submit state so the
        // input is re-enabled for the new session.
        if (this.isSubmitting) {
            this.isSubmitting = false;
            this.isQueryProgressActive = false;
            this.submitButton.set('disabled', false);
            this._updateAbortButtonState();
        }

        // Reset screenshot toggle state
        this.pageContentEnabled = false;
        this._updateToggleButtonStyle();
        topic.publish('pageContentToggleChanged', false);

        // Clear attached images
        this._clearAttachedImage();

        // Clear selected workspace items
        this.selectedWorkspaceItems = [];
        this._renderWorkspaceSelectionIndicator();
        this.selectedJobs = [];
        this._renderJobsSelectionIndicator();
        this.selectedWorkflows = [];
      },

      /**
       * Updates the current session identifier
       * @param {string} sessionId - New session ID
       */
      setSessionId: function(sessionId) {
        this.sessionId = sessionId;
        this.session_registered = false;

        // If an SSE stream was in progress for a different session, reset the
        // submit state so the input is re-enabled for the new session.
        if (this.isSubmitting) {
            this.isSubmitting = false;
            this.isQueryProgressActive = false;
            this.submitButton.set('disabled', false);
            this._updateAbortButtonState();
        }

        // Reset screenshot toggle state
        this.pageContentEnabled = false;
        this._updateToggleButtonStyle();
        topic.publish('pageContentToggleChanged', false);

        // Clear attached images
        this._clearAttachedImage();

        // Clear selected workspace items
        this.selectedWorkspaceItems = [];
        this._renderWorkspaceSelectionIndicator();
        this.selectedJobs = [];
        this._renderJobsSelectionIndicator();
        this.selectedWorkflows = [];
      },

      /**
       * Sets system prompt from structured data
       * Implementation:
       * - Takes array of data objects
       * - Builds prompt string with JSON stringified data
       * - Sets as system prompt
       */
      setSystemPromptWithData: function(data) {
        if (!data || !data.length) {
          this.systemPrompt = '';
          return;
        }

        let promptStr = "Use the following information to answer the user's question:\n";
        data.forEach(function(item) {
          promptStr += JSON.stringify(item) + '\n';
        });

        this.systemPrompt = promptStr;
      },

      /**
       * Sets raw system prompt string
       */
      setSystemPrompt: function(systemPrompt) {
        this.systemPrompt = systemPrompt;
      },

      /**
       * Returns currently selected model
       */
      getModel: function() {
        return this.model;
      },

      /**
       * Updates selected model and UI
       */
      setModel: function(model) {
        this.model = model;
        if (window && window.App) {
          window.App.copilotSelectedModel = model;
        }
        this._updateImageCapabilityUI();
      },

      _getAvailableModels: function() {
        if (window && window.App && Array.isArray(window.App.copilotModelList)) {
          return window.App.copilotModelList;
        }
        return [];
      },

      _supportsImageFlag: function(value) {
        return value === true || value === 1 || value === '1' || value === 'true';
      },

      _modelSupportsImage: function(modelId) {
        var models = this._getAvailableModels();
        if (!modelId || models.length === 0) {
          return true;
        }
        var match = models.find(function(entry) {
          return entry && entry.model === modelId;
        });
        if (!match) {
          return true;
        }
        return !!(match && this._supportsImageFlag(match.supports_image));
      },

      _resolveImageModel: function() {
        if (this.model && this._modelSupportsImage(this.model)) {
          return this.model;
        }
        var models = this._getAvailableModels();
        if (models.length === 0) {
          return this.model;
        }
        var defaultImage = models.find(function(entry) {
          return entry && entry.active !== false && this._supportsImageFlag(entry.supports_image) && entry.is_default === true;
        }, this);
        if (defaultImage && defaultImage.model) {
          return defaultImage.model;
        }
        var firstImage = models.find(function(entry) {
          return entry && entry.active !== false && this._supportsImageFlag(entry.supports_image) && entry.model;
        });
        return firstImage && firstImage.model ? firstImage.model : this.model;
      },

      _updateImageCapabilityUI: function() {
        var enabled = this._modelSupportsImage(this.model);

        if (this.screenshotToggleNode) {
          this.screenshotToggleNode.style.display = enabled ? 'block' : 'none';
        }
        // Upload button is always visible — it handles both images and text files
        if (this.uploadImageNode) {
          this.uploadImageNode.style.display = 'block';
        }

        if (!enabled) {
          this.pageContentEnabled = false;
          // Only clear image attachments, not file attachments
          this._clearAttachedImage();
          topic.publish('pageContentToggleChanged', false);
        }
        this._renderAttachedImageIndicator();
      },

      _handleImageUploadChange: function(evt) {
        var files = evt && evt.target && evt.target.files ? Array.prototype.slice.call(evt.target.files) : [];
        if (!files || files.length === 0) {
          return;
        }

        var maxAttachments = 3;
        var maxImageBytes = 6 * 1024 * 1024;    // 6 MB for images
        var maxFileBytes = 100 * 1024;           // 100 KB for text files
        var currentCount = this.attachedImages.length + this.attachedFiles.length;
        var remainingSlots = Math.max(0, maxAttachments - currentCount);

        if (remainingSlots <= 0) {
          topic.publish('CopilotApiError', { error: new Error('You can attach up to 3 files per message.') });
          this.imageUploadInput.value = '';
          return;
        }

        var acceptedFiles = files.slice(0, remainingSlots);
        if (files.length > remainingSlots) {
          topic.publish('CopilotApiError', {
            error: new Error('Only the first ' + remainingSlots + ' file(s) were attached. Maximum is 3 total.')
          });
        }

        var imageFiles = [];
        var textFiles = [];
        var modelSupportsImage = this._modelSupportsImage(this.model);

        acceptedFiles.forEach(function(file) {
          if (/^image\/(png|jpeg|jpg)$/i.test(file.type || '')) {
            imageFiles.push(file);
          } else {
            textFiles.push(file);
          }
        });

        // Reject image files if model doesn't support images
        if (imageFiles.length > 0 && !modelSupportsImage) {
          topic.publish('CopilotApiError', {
            error: new Error('The current model does not support image attachments. Only text files can be uploaded.')
          });
          imageFiles = [];
        }

        var readPromises = [];

        // Process image files (existing logic)
        imageFiles.forEach(lang.hitch(this, function(file) {
          readPromises.push(new Promise(lang.hitch(this, function(resolve, reject) {
            if (file.size > maxImageBytes) {
              reject(new Error('Image "' + (file.name || 'image') + '" is larger than 6 MB.'));
              return;
            }
            var reader = new FileReader();
            reader.onload = function(loadEvt) {
              resolve({
                fileType: 'image',
                id: 'img-' + Date.now() + '-' + Math.floor(Math.random() * 1000000),
                image: loadEvt && loadEvt.target ? loadEvt.target.result : null,
                attachment: {
                  type: 'image',
                  source: 'upload',
                  name: file.name || 'Uploaded image'
                }
              });
            };
            reader.onerror = function() {
              reject(new Error('Unable to read image "' + (file.name || 'image') + '".'));
            };
            reader.readAsDataURL(file);
          })));
        }));

        // Process text files (NEW)
        textFiles.forEach(lang.hitch(this, function(file) {
          readPromises.push(new Promise(lang.hitch(this, function(resolve, reject) {
            if (file.size > maxFileBytes) {
              reject(new Error('File "' + (file.name || 'file') + '" is larger than 100 KB.'));
              return;
            }
            var reader = new FileReader();
            reader.onload = function(loadEvt) {
              var content = loadEvt && loadEvt.target ? loadEvt.target.result : '';
              // Validate it's valid text (check for null bytes as binary indicator)
              if (content && content.indexOf('\u0000') !== -1) {
                reject(new Error('File "' + (file.name || 'file') + '" appears to be a binary file. Only text files are supported.'));
                return;
              }
              resolve({
                fileType: 'text',
                id: 'file-' + Date.now() + '-' + Math.floor(Math.random() * 1000000),
                name: file.name || 'Uploaded file',
                content: content,
                size: file.size,
                mimeType: file.type || 'text/plain',
                attachment: {
                  type: 'file',
                  source: 'upload',
                  name: file.name || 'Uploaded file',
                  size: file.size
                }
              });
            };
            reader.onerror = function() {
              reject(new Error('Unable to read file "' + (file.name || 'file') + '".'));
            };
            reader.readAsText(file);
          })));
        }));

        Promise.all(readPromises).then(lang.hitch(this, function(results) {
          results.forEach(lang.hitch(this, function(entry) {
            var total = this.attachedImages.length + this.attachedFiles.length;
            if (total >= maxAttachments) return;
            if (entry.fileType === 'image' && entry.image) {
              this.attachedImages.push(entry);
            } else if (entry.fileType === 'text' && entry.content !== undefined) {
              this.attachedFiles.push(entry);
            }
          }));
          this._renderAttachedImageIndicator();
          this._emitImageAttachmentsChanged();
        })).catch(function(error) {
          topic.publish('CopilotApiError', { error: error });
        }).finally(lang.hitch(this, function() {
          this.imageUploadInput.value = '';
        }));
      },

      _clearAttachedImage: function() {
        this.attachedImages = [];
        this.attachedFiles = [];
        if (this.imageUploadInput) {
          this.imageUploadInput.value = '';
        }
        this._renderAttachedImageIndicator();
        this._emitImageAttachmentsChanged();
      },

      setAttachedImages: function(entries) {
        this.attachedImages = Array.isArray(entries) ? entries.slice() : [];
        this._renderAttachedImageIndicator();
        this._emitImageAttachmentsChanged();
      },

      _renderAttachedImageIndicator: function() {
        if (!this.imageAttachmentCounter || !this.imageAttachmentCountNode) {
          return;
        }
        var imageCount = this.attachedImages.length;
        var fileCount = this.attachedFiles ? this.attachedFiles.length : 0;
        var totalCount = imageCount + fileCount;
        if (totalCount > 0) {
          var parts = [];
          if (imageCount > 0) parts.push(imageCount + (imageCount === 1 ? ' image' : ' images'));
          if (fileCount > 0) parts.push(fileCount + (fileCount === 1 ? ' file' : ' files'));
          this.imageAttachmentCountNode.textContent = parts.join(', ');
          this.imageAttachmentCounter.style.display = 'inline-flex';
          this.imageAttachmentCounter.classList.toggle('hasImages', totalCount > 0);
        } else {
          this.imageAttachmentCounter.style.display = 'none';
          this.imageAttachmentCountNode.textContent = '';
        }
      },

      _buildUserMessageForSubmit: function(inputText, attachmentMeta) {
        var userMessage = {
          role: 'user',
          content: inputText,
          message_id: 'user_' + Date.now(),
          timestamp: new Date().toISOString()
        };
        if (attachmentMeta) {
          if (Array.isArray(attachmentMeta) && attachmentMeta.length > 0) {
            userMessage.attachments = attachmentMeta;
          } else if (!Array.isArray(attachmentMeta)) {
            userMessage.attachments = [attachmentMeta];
          }
        }
        return userMessage;
      },

      _getUploadedImagePayload: function() {
        if (!Array.isArray(this.attachedImages) || this.attachedImages.length === 0) {
          return null;
        }
        var maxImages = 3;
        var normalized = this.attachedImages
          .filter(function(entry) {
            return entry && typeof entry.image === 'string' && entry.image.length > 0;
          })
          .slice(0, maxImages);
        if (normalized.length === 0) {
          return null;
        }
        return {
          images: normalized.map(function(entry) { return entry.image; }),
          attachments: normalized.map(function(entry) {
            var attachment = entry.attachment || {};
            return {
              type: 'image',
              source: attachment.source || 'upload',
              name: attachment.name || 'Uploaded image'
            };
          })
        };
      },


      _getUploadedFilesPayload: function() {
        if (!Array.isArray(this.attachedFiles) || this.attachedFiles.length === 0) {
          return null;
        }
        return {
          files: this.attachedFiles.map(function(entry) {
            return {
              name: entry.name,
              content: entry.content,
              mime_type: entry.mimeType || 'text/plain',
              size: entry.size || 0
            };
          }),
          attachments: this.attachedFiles.map(function(entry) {
            return {
              type: 'file',
              source: 'upload',
              name: entry.name || 'Uploaded file',
              size: entry.size || 0
            };
          })
        };
      },

      /**
       * Updates selected RAG database and UI
       */
      setRagDb: function(ragDb) {
        if (ragDb == 'null') {
          this.ragDb = null;
        } else {
          this.ragDb = ragDb;
        }
      },

      /**
       * Updates RAG selection UI text
       */
      setRagButtonLabel: function(ragDb) {
        if (!this.ragText) {
          return;
        }
        if (ragDb && ragDb !== 'null') {
          this.ragText.innerHTML = 'RAG: ' + ragDb;
        } else {
          this.ragText.innerHTML = 'RAG: None';
        }
      },

      /**
       * Updates model selection UI text
       */
      setModelText: function(model) {
        if (!this.modelText) {
          return;
        }
        if (model) {
          model = model.split('/').reverse()[0];
          if (model.length > 30) {
            model = model.substring(0, 30) + '...';
          }
          this.modelText.innerHTML = 'Model: ' + model;
        } else {
          this.modelText.innerHTML = 'Model: None';
        }
      },

      /**
       * Updates the number of documents to use for RAG queries
       */
      setNumDocs: function(numDocs) {
        this.numDocs = numDocs;
      },

      setStatePrompt: function(statePrompt) {
        this.statePrompt = statePrompt;
      },

      /**
       * Finalizes creation of a brand-new chat after the first successful response.
       * Session registration/list updates are handled earlier; this now marks the
       * chat as initialized and triggers title generation.
       * @param {boolean} generateTitleImmediately – if false, skip title generation (default true)
       */
      _finishNewChat: function(generateTitleImmediately = true) {
        this.new_chat = false;
        this.session_registered = true;

        if (generateTitleImmediately) {
          setTimeout(function() {
            topic.publish('generateSessionTitle');
          }, 100);
        }
      },

      /**
       * @method _handlePageSubmit
       * @description Handles submission about the current page (screenshot first, HTML fallback)
       * Implementation:
       * - Immediately shows user message and clears text area
       * - Takes screenshot and makes API call
       * - Updates chat store with assistant/system messages only
       **/
      _handlePageSubmit: function() {
        var inputText = this.textArea.get('value');
        var _self = this;

        if (this.state) {
            console.log('state', this.state);
        }

        // Immediately show user message and clear text area
        var userMessage = this._buildUserMessageForSubmit(inputText, {
          type: 'image',
          source: 'screenshot',
          name: 'Page screenshot'
        });

        this.chatStore.addMessage(userMessage);
        this.displayWidget.showMessages(this.chatStore.query());
        this._setInputTextValue('');

        this.isSubmitting = true;
        this.submitButton.set('disabled', true);

        topic.publish('hideChatPanel'); // Hide panel before taking screenshot

        html2canvas(document.body).then(lang.hitch(this, function(canvas) {
          var base64Image = canvas.toDataURL('image/png');

          topic.publish('showChatPanel'); // Show panel again

          this.displayWidget.showLoadingIndicator(this.chatStore.query());
          var imageSystemPrompt = 'You are a helpful scientist website assistant for the website BV-BRC, the Bacterial and Viral Bioinformatics Resource Center. You can also answer questions about the attached screenshot.\n' +
          'Analyze the screenshot and respond to the user\'s query.';

          if (this.systemPrompt) {
              imageSystemPrompt += '\n\n' + this.systemPrompt;
          }
          if (this.statePrompt) {
              imageSystemPrompt = imageSystemPrompt + '\n\n' + this.statePrompt;
          }

          var imgtxt_model = this._resolveImageModel();

          this._submitCopilotQueryWithRegistration(inputText, this.sessionId, imageSystemPrompt, imgtxt_model, true, this.ragDb, this.numDocs, null, this.enhancedPrompt, {
              images: [base64Image],
              selected_workspace_items: this._getSelectedWorkspaceItemsForRequest(),
              selected_jobs: this._getSelectedJobsForRequest(),
              selected_workflows: this._getSelectedWorkflowsForRequest()
          })
              .then(lang.hitch(this, function(response) {
                  // Only add assistant message and system message (if present) - user message was already added
                  var messagesToAdd = [];
                  if (response.systemMessage) {
                      messagesToAdd.push(response.systemMessage);
                  }
                  if (response.assistantMessage) {
                      messagesToAdd.push(response.assistantMessage);
                  }

                  if (messagesToAdd.length > 0) {
                      this.chatStore.addMessages(messagesToAdd);
                  }

                  this.displayWidget.showMessages(this.chatStore.query());

                  if (_self.new_chat) {
                      _self._finishNewChat();
                  }
              })).catch(function(error) {
                  topic.publish('CopilotApiError', { error: error });
              }).finally(lang.hitch(this, function() {
                  this.displayWidget.hideLoadingIndicator();
                  this.isSubmitting = false;
                  this.submitButton.set('disabled', false);

                  // Deselect the pageContentToggle after submission
                  this.pageContentEnabled = false;
                  this._updateToggleButtonStyle();
                  topic.publish('pageContentToggleChanged', false);
              }));
      })).catch(lang.hitch(this, function(error) {
          console.error('Error capturing or processing screenshot:', error);
          topic.publish('showChatPanel'); // Ensure panel is shown even on error

          // Fall back to HTML content if screenshot fails
          console.log('Falling back to HTML content');
          this._handlePageContentSubmit();
      }));
    },

    /**
     * @method _handlePageContentSubmit
     * @description Handles submission of page content (HTML)
     * Used as a fallback when screenshot fails
     * Implementation:
     * - Immediately shows user message and clears text area
     * - Makes API call with page content
     * - Updates chat store with assistant/system messages only
     **/
    _handlePageContentSubmit: function() {
      var inputText = this.textArea.get('value');
      var _self = this;

      // Immediately show user message and clear text area
      var userMessage = {
        role: 'user',
        content: inputText,
        message_id: 'user_' + Date.now(),
        timestamp: new Date().toISOString()
      };

      this.chatStore.addMessage(userMessage);
      this.displayWidget.showMessages(this.chatStore.query());
      this._setInputTextValue('');

      const pageHtml = document.documentElement.innerHTML;

      var systemPrompt = 'You are a helpful assistant that can answer questions about the page content.\\n' +
          'Answer questions as if you were a user viewing the page.\\n' +
          'The page content is:\\n' +
          pageHtml;
      if (this.systemPrompt) {
          systemPrompt += '\\n' + this.systemPrompt;
      }
      if (this.statePrompt) {
        systemPrompt = this.statePrompt + '\\n\\n' + systemPrompt;
      }

      this.displayWidget.showLoadingIndicator(this.chatStore.query());

      let assistantMessage = {
          role: 'assistant',
          content: '',
          message_id: 'assistant_' + Date.now(),
          timestamp: new Date().toISOString()
      };
      this.chatStore.addMessage(assistantMessage);
      this.displayWidget.hideLoadingIndicator();

      const params = {
          inputText: inputText,
          sessionId: this.sessionId,
          systemPrompt: systemPrompt,
          model: this.model,
          save_chat: true,
          ragDb: this.ragDb,
          numDocs: this.numDocs,
          enhancedPrompt: this.enhancedPrompt
      };
      this._appendWorkspaceSelectionToStreamParams(params);

      this.isSubmitting = true;
      this.isQueryProgressActive = false;
      this._updateAbortButtonState();
      this._submitCopilotQueryStreamWithRegistration(params,
          (chunk, toolMetadata) => {
              // onData
              console.log('chunk', chunk);

              // Add tool metadata if available (for workflow handling)
              if (toolMetadata) {
                  this._applyToolMetadataToAssistantMessage(assistantMessage, toolMetadata);
              }

              assistantMessage.content += chunk;
              this.displayWidget.showMessages(this.chatStore.query());
          },
          () => {
              // onEnd
              if (_self.new_chat) {
                  _self._finishNewChat();
              }
              this.isSubmitting = false;
              this.isQueryProgressActive = false;
              this.submitButton.set('disabled', false);
              this._updateAbortButtonState();
              // Deselect the pageContentToggle after submission
              this.pageContentEnabled = false;
              this._updateToggleButtonStyle();
              topic.publish('pageContentToggleChanged', false);
          },
          (error) => {
              // onError
              topic.publish('CopilotApiError', {
                  error: error
              });
              this.displayWidget.hideLoadingIndicator();
              this.isSubmitting = false;
              this.isQueryProgressActive = false;
              this.submitButton.set('disabled', false);
              this._updateAbortButtonState();
          },
          (progressInfo) => {
              // onProgress - handle queue status updates
              console.log('progressInfo', progressInfo);
              switch(progressInfo.type) {
                  case 'queued':
                      // Silent - no logging for queued event
                      break;
                  case 'started':
                      // Silent - no logging for started event
                      break;
                  case 'progress':
                      console.log(`Processing: ${progressInfo.percentage}% (Iteration ${progressInfo.iteration}/${progressInfo.max_iterations})`);
                      if (progressInfo.tool) {
                          console.log(`Using tool: ${progressInfo.tool}`);
                      }
                      break;
              }
          },
          (statusMessage) => {
              // onStatusMessage - handle status message updates
              this._handleAbortStatusMessageEvent(statusMessage);
              if (statusMessage.should_remove) {
                  this.chatStore.removeMessage(statusMessage.message_id);
              } else {
                  var existingMessage = this.chatStore.getMessageById(statusMessage.message_id);
                  if (existingMessage) {
                      this.chatStore.updateMessage(statusMessage);
                  } else {
                      this.chatStore.addMessage(statusMessage);
                  }
              }
              this.displayWidget.showMessages(this.chatStore.query());
          }
      );
    },

    _handleRagSubmitStream: function() {
      console.log('this.ragDb=', this.ragDb);
      var inputText = this.textArea.get('value');
      var _self = this;
      var uploadedImagePayload = this._getUploadedImagePayload();
      var hasUploadedImage = !!(uploadedImagePayload && Array.isArray(uploadedImagePayload.images) && uploadedImagePayload.images.length > 0 && this._modelSupportsImage(this.model));
      var uploadedFilesPayload = this._getUploadedFilesPayload();
      var hasUploadedFiles = !!(uploadedFilesPayload && Array.isArray(uploadedFilesPayload.files) && uploadedFilesPayload.files.length > 0);
      var submitModel = hasUploadedImage ? this._resolveImageModel() : this.model;

      if (this.state) {
        console.log('state', this.state);
      }

      // Switch to Messages tab when message is sent
      topic.publish('ChatMessageSubmitted');

      // Immediately show user message and clear text area
      var allAttachments = [];
      if (hasUploadedImage) {
        allAttachments = allAttachments.concat(uploadedImagePayload.attachments);
      }
      if (hasUploadedFiles) {
        allAttachments = allAttachments.concat(uploadedFilesPayload.attachments);
      }
      var userMessage = this._buildUserMessageForSubmit(
        inputText,
        allAttachments.length > 0 ? allAttachments : null
      );

      this.chatStore.addMessage(userMessage);
      this.displayWidget.showMessages(this.chatStore.query());
      this._setInputTextValue('');
      if (hasUploadedImage || hasUploadedFiles) {
        this._clearAttachedImage();
      }

      this.isSubmitting = true;
      this.isQueryProgressActive = false;
      this.submitButton.set('disabled', true);
      this._updateAbortButtonState();

      this.displayWidget.showLoadingIndicator(this.chatStore.query());

      var systemPrompt = 'You are a helpful scientist website assistant for the website BV-BRC, the Bacterial and Viral Bioinformatics Resource Center.\\n\\n';
      if (this.systemPrompt) {
          systemPrompt += this.systemPrompt;
      }
      if (this.statePrompt) {
          systemPrompt += this.statePrompt;
      }
      if (hasUploadedImage) {
          systemPrompt += '\\n\\nThe user attached an image. Use it as additional context.';
      }

      // Track assistant message and status message ID
      let assistantMessage = null;
      let statusMessageId = null;
      let assistantMessageCreated = false;

      this.displayWidget.hideLoadingIndicator();

      const params = {
        inputText: inputText,
        sessionId: this.sessionId,
        systemPrompt: systemPrompt,
        model: submitModel,
        save_chat: true,
        ragDb: this.ragDb,
        numDocs: this.numDocs,
        enhancedPrompt: this.enhancedPrompt
      };
      if (hasUploadedImage) {
        params.images = uploadedImagePayload.images;
      }
      if (hasUploadedFiles) {
        params.files = uploadedFilesPayload.files;
      }
      this._appendWorkspaceSelectionToStreamParams(params);

      this._submitCopilotQueryStreamWithRegistration(params,
          (chunk, toolMetadata) => {
              // onData - create assistant message on first chunk if not exists
              if (!assistantMessageCreated) {
                  // Remove status message if it exists
                  if (statusMessageId) {
                      this.chatStore.removeMessage(statusMessageId);
                      statusMessageId = null;
                  }
                  // Create assistant message
                  assistantMessage = {
                      role: 'assistant',
                      content: '',
                      message_id: 'assistant_' + Date.now(),
                      timestamp: new Date().toISOString(),
                      // Restrict RAG chunk card rendering to rag/stream submissions only.
                      isRagStreamQuery: true,
                      ragChunkSearchFilters: {
                          session_id: this.sessionId || null,
                          user_id: this.copilotApi && this.copilotApi.user_id ? this.copilotApi.user_id : null,
                          rag_db: this.ragDb || null
                      }
                  };

                  // Add tool metadata if available (for workflow handling)
                  if (toolMetadata) {
                      this._applyToolMetadataToAssistantMessage(assistantMessage, toolMetadata);
                  }

                  this.chatStore.addMessage(assistantMessage);
                  assistantMessageCreated = true;
              }
              if (toolMetadata) {
                  this._applyToolMetadataToAssistantMessage(assistantMessage, toolMetadata);
              }
              // Append content to assistant message
              assistantMessage.content += chunk;
              this.displayWidget.showMessages(this.chatStore.query());
          },
          () => {
              // onEnd
              if (_self.new_chat) {
                  _self._finishNewChat();
              }
              this.isSubmitting = false;
              this.isQueryProgressActive = false;
              this.submitButton.set('disabled', false);
              this._updateAbortButtonState();
          },
          (error) => {
              // onError
              topic.publish('CopilotApiError', {
                  error: error
              });
              this.displayWidget.hideLoadingIndicator();
              this.isSubmitting = false;
              this.isQueryProgressActive = false;
              this.submitButton.set('disabled', false);
              this._updateAbortButtonState();
          },
          (progressInfo) => {
              // onProgress - handle queue status updates
              switch(progressInfo.type) {
                  case 'queued':
                      // Silent - no logging for queued event
                      break;
                  case 'started':
                      // Silent - no logging for started event
                      break;
                  case 'progress':
                      console.log(`Processing: ${progressInfo.percentage}% (Iteration ${progressInfo.iteration}/${progressInfo.max_iterations})`);
                      if (progressInfo.tool) {
                          console.log(`Using tool: ${progressInfo.tool}`);
                      }
                      break;
              }
          },
          (statusMessage) => {
              // onStatusMessage - handle status message updates
              this._handleAbortStatusMessageEvent(statusMessage);
              // Only log non-temporary status messages for debugging
              if (statusMessage && !statusMessage.is_temporary) {
                  console.log('[HANDLER] Status message received:', statusMessage);
              }

              if (statusMessage.should_remove) {
                  // Remove the status message from chat store
                  this.chatStore.removeMessage(statusMessage.message_id);
                  if (statusMessageId === statusMessage.message_id) {
                      statusMessageId = null;
                  }
              } else {
                  // Track status message ID
                  statusMessageId = statusMessage.message_id;
                  // Add or update the status message
                  var existingMessage = this.chatStore.getMessageById(statusMessage.message_id);
                  if (existingMessage) {
                      // Update existing message
                      this.chatStore.updateMessage(statusMessage);
                  } else {
                      // Add new message
                      this.chatStore.addMessage(statusMessage);
                  }
              }

              // Refresh display
              this.displayWidget.showMessages(this.chatStore.query());
          }
      );
    },

    _handleRegularSubmitStream: function() {
      console.log('[HANDLER] _handleRegularSubmitStream START');
      var inputText = this.textArea.get('value');
      var _self = this;
      var uploadedImagePayload = this._getUploadedImagePayload();
      var hasUploadedImage = !!(uploadedImagePayload && Array.isArray(uploadedImagePayload.images) && uploadedImagePayload.images.length > 0 && this._modelSupportsImage(this.model));
      var uploadedFilesPayload = this._getUploadedFilesPayload();
      var hasUploadedFiles = !!(uploadedFilesPayload && Array.isArray(uploadedFilesPayload.files) && uploadedFilesPayload.files.length > 0);
      var submitModel = hasUploadedImage ? this._resolveImageModel() : this.model;
      if (this.state) {
        console.log('state', this.state);
      }

      // Switch to Messages tab when message is sent
      topic.publish('ChatMessageSubmitted');

      // Immediately show user message and clear text area
      var allAttachments = [];
      if (hasUploadedImage) {
        allAttachments = allAttachments.concat(uploadedImagePayload.attachments);
      }
      if (hasUploadedFiles) {
        allAttachments = allAttachments.concat(uploadedFilesPayload.attachments);
      }
      var userMessage = this._buildUserMessageForSubmit(
          inputText,
          allAttachments.length > 0 ? allAttachments : null
      );

      this.chatStore.addMessage(userMessage);
      this.displayWidget.showMessages(this.chatStore.query());
      this._setInputTextValue('');
      if (hasUploadedImage || hasUploadedFiles) {
        this._clearAttachedImage();
      }

      this.isSubmitting = true;
      this.isQueryProgressActive = false;
      this.submitButton.set('disabled', true);
      this._updateAbortButtonState();
      this._updateAbortButtonState();

      this.displayWidget.showLoadingIndicator(this.chatStore.query());

      var systemPrompt = 'You are a helpful scientist website assistant for the website BV-BRC, the Bacterial and Viral Bioinformatics Resource Center.\\n\\n';
      if (this.systemPrompt) {
          systemPrompt += this.systemPrompt;
      }
      if (this.statePrompt) {
          systemPrompt += this.statePrompt;
      }
      if (hasUploadedImage) {
          systemPrompt += '\\n\\nThe user attached an image. Use it as additional context.';
      }

      // Track assistant message and status message ID
      let assistantMessage = null;
      let statusMessageId = null;
      let assistantMessageCreated = false;

      this.displayWidget.hideLoadingIndicator();

      const params = {
          inputText: inputText,
          sessionId: this.sessionId,
          systemPrompt: systemPrompt,
          model: submitModel,
          save_chat: true
      };
      if (hasUploadedImage) {
        params.images = uploadedImagePayload.images;
      }
      if (hasUploadedFiles) {
        params.files = uploadedFilesPayload.files;
      }
      this._appendWorkspaceSelectionToStreamParams(params);
      console.log('[HANDLER] About to call submitCopilotQueryStream with params:', params);
      this._submitCopilotQueryStreamWithRegistration(params,
          (chunk, toolMetadata) => {
              // onData - create assistant message on first chunk if not exists
              console.log('[HANDLER] onData callback received chunk:', chunk);
              console.log('[HANDLER] toolMetadata in onData:', toolMetadata);
              if (!assistantMessageCreated) {
                  // Remove status message if it exists
                  if (statusMessageId) {
                      this.chatStore.removeMessage(statusMessageId);
                      statusMessageId = null;
                  }
                  // Create assistant message
                  assistantMessage = {
                      role: 'assistant',
                      content: '',
                      message_id: 'assistant_' + Date.now(),
                      timestamp: new Date().toISOString()
                  };

                  // Add tool metadata if available (for workflow handling)
                  if (toolMetadata) {
                      console.log('[HANDLER] Adding toolMetadata to assistant message');
                      console.log('[HANDLER] toolMetadata:', toolMetadata);
                      console.log('[HANDLER] toolMetadata.workflowData:', toolMetadata.workflowData);
                      console.log('[HANDLER] toolMetadata.workflowData type:', typeof toolMetadata.workflowData);
                      if (toolMetadata.workflowData) {
                          console.log('[HANDLER] toolMetadata.workflowData keys:', Object.keys(toolMetadata.workflowData));
                          console.log('[HANDLER] toolMetadata.workflowData.workflow_name:', toolMetadata.workflowData.workflow_name);
                      }
                      this._applyToolMetadataToAssistantMessage(assistantMessage, toolMetadata);
                      console.log('[HANDLER] ✓ Assistant message updated with toolMetadata');
                      console.log('[HANDLER] assistantMessage.workflowData:', assistantMessage.workflowData);
                  } else {
                      console.log('[HANDLER] No toolMetadata provided');
                  }

                  this.chatStore.addMessage(assistantMessage);
                  assistantMessageCreated = true;
              }
              if (toolMetadata) {
                  this._applyToolMetadataToAssistantMessage(assistantMessage, toolMetadata);
              }
              // Append content to assistant message
              assistantMessage.content += chunk;
              console.log('[HANDLER] Assistant message content now:', assistantMessage.content);
              this.displayWidget.showMessages(this.chatStore.query());
          },
          () => {
              // onEnd
              console.log('[HANDLER] onEnd callback called');
              if (_self.new_chat) {
                  _self._finishNewChat();
              }
              this.isSubmitting = false;
              this.isQueryProgressActive = false;
              this.submitButton.set('disabled', false);
              this._updateAbortButtonState();
          },
          (error) => {
              // onError
              topic.publish('CopilotApiError', {
                  error: error
              });
              this.displayWidget.hideLoadingIndicator();
              this.isSubmitting = false;
              this.isQueryProgressActive = false;
              this.submitButton.set('disabled', false);
              this._updateAbortButtonState();
          },
          (progressInfo) => {
              // onProgress - handle queue status updates
              switch(progressInfo.type) {
                  case 'queued':
                      // Silent - no logging for queued event
                      break;
                  case 'started':
                      // Silent - no logging for started event
                      break;
                  case 'progress':
                      console.log(`Processing: ${progressInfo.percentage}% (Iteration ${progressInfo.iteration}/${progressInfo.max_iterations})`);
                      if (progressInfo.tool) {
                          console.log(`Using tool: ${progressInfo.tool}`);
                      }
                      break;
              }
          },
          (statusMessage) => {
              // onStatusMessage - handle status message updates
              this._handleAbortStatusMessageEvent(statusMessage);
              // Only log non-temporary status messages for debugging
              if (statusMessage && !statusMessage.is_temporary) {
                  console.log('[HANDLER] Status message received:', statusMessage);
              }

              if (statusMessage.should_remove) {
                  // Remove the status message from chat store
                  this.chatStore.removeMessage(statusMessage.message_id);
                  if (statusMessageId === statusMessage.message_id) {
                      statusMessageId = null;
                  }
              } else {
                  // Track status message ID
                  statusMessageId = statusMessage.message_id;
                  // Add or update the status message
                  var existingMessage = this.chatStore.getMessageById(statusMessage.message_id);
                  if (existingMessage) {
                      // Update existing message
                      this.chatStore.updateMessage(statusMessage);
                  } else {
                      // Add new message
                      this.chatStore.addMessage(statusMessage);
                  }
              }

              // Refresh display
              this.displayWidget.showMessages(this.chatStore.query());
          }
      );
    },

    _handlePageSubmitStream: function() {
      var inputText = this.textArea.get('value');
      var _self = this;

      if (this.state) {
          console.log('state', this.state);
      }

      // Switch to Messages tab when message is sent
      topic.publish('ChatMessageSubmitted');

      // Immediately show user message and clear text area
      var userMessage = this._buildUserMessageForSubmit(inputText, {
        type: 'image',
        source: 'screenshot',
        name: 'Page screenshot'
      });

      this.chatStore.addMessage(userMessage);
      this.displayWidget.showMessages(this.chatStore.query());
      this._setInputTextValue('');

      this.isSubmitting = true;
      this.submitButton.set('disabled', true);

      topic.publish('hideChatPanel'); // Hide panel before taking screenshot

      html2canvas(document.body).then(lang.hitch(this, function(canvas) {
        var base64Image = canvas.toDataURL('image/png');

        topic.publish('showChatPanel'); // Show panel again

        this.displayWidget.showLoadingIndicator(this.chatStore.query());
        var imageSystemPrompt = 'You are a helpful scientist website assistant for the website BV-BRC, the Bacterial and Viral Bioinformatics Resource Center. You can also answer questions about the attached screenshot.\\n' +
        'Analyze the screenshot and respond to the user\'s query.';

        if (this.systemPrompt) {
            imageSystemPrompt += '\\n\\n' + this.systemPrompt;
        }
        if (this.statePrompt) {
            imageSystemPrompt = imageSystemPrompt + '\\n\\n' + this.statePrompt;
        }

        var imgtxt_model = this._resolveImageModel();

        // Track assistant message and status message ID
        let assistantMessage = null;
        let statusMessageId = null;
        let assistantMessageCreated = false;

        this.displayWidget.hideLoadingIndicator();

        var uploadedFilesPayloadPage = this._getUploadedFilesPayload();
        var hasUploadedFilesPage = !!(uploadedFilesPayloadPage && Array.isArray(uploadedFilesPayloadPage.files) && uploadedFilesPayloadPage.files.length > 0);

        const params = {
            inputText: inputText,
            sessionId: this.sessionId,
            systemPrompt: imageSystemPrompt,
            model: imgtxt_model,
            save_chat: true,
            ragDb: this.ragDb,
            numDocs: this.numDocs,
            images: [base64Image],
            enhancedPrompt: this.enhancedPrompt
        };
        if (hasUploadedFilesPage) {
          params.files = uploadedFilesPayloadPage.files;
        }
        this._appendWorkspaceSelectionToStreamParams(params);

        if (hasUploadedFilesPage) {
          this._clearAttachedImage();
        }

        this._submitCopilotQueryStreamWithRegistration(params,
            (chunk, toolMetadata) => {
                // onData - create assistant message on first chunk if not exists
                if (!assistantMessageCreated) {
                    // Remove status message if it exists
                    if (statusMessageId) {
                        this.chatStore.removeMessage(statusMessageId);
                        statusMessageId = null;
                    }
                    // Create assistant message
                    assistantMessage = {
                        role: 'assistant',
                        content: '',
                        message_id: 'assistant_' + Date.now(),
                        timestamp: new Date().toISOString()
                    };

                    // Add tool metadata if available (for workflow handling)
                    if (toolMetadata) {
                        this._applyToolMetadataToAssistantMessage(assistantMessage, toolMetadata);
                    }

                    this.chatStore.addMessage(assistantMessage);
                    assistantMessageCreated = true;
                }
                if (toolMetadata) {
                    this._applyToolMetadataToAssistantMessage(assistantMessage, toolMetadata);
                }
                // Append content to assistant message
                assistantMessage.content += chunk;
                this.displayWidget.showMessages(this.chatStore.query());
            },
            () => {
                // onEnd
                if (_self.new_chat) {
                    _self._finishNewChat();
                }
                this.isSubmitting = false;
                this.submitButton.set('disabled', false);
                // Deselect the pageContentToggle after submission
                this.pageContentEnabled = false;
                this._updateToggleButtonStyle();
                topic.publish('pageContentToggleChanged', false);
            },
            (error) => {
                // onError
                topic.publish('CopilotApiError', {
                    error: error
                });
                this.displayWidget.hideLoadingIndicator();
                this.isSubmitting = false;
                this.submitButton.set('disabled', false);
            },
            (progressInfo) => {
                // onProgress - handle queue status updates
                switch(progressInfo.type) {
                    case 'queued':
                        // Silent - no logging for queued event
                        break;
                    case 'started':
                        // Silent - no logging for started event
                        break;
                    case 'progress':
                        console.log(`Processing: ${progressInfo.percentage}% (Iteration ${progressInfo.iteration}/${progressInfo.max_iterations})`);
                        if (progressInfo.tool) {
                            console.log(`Using tool: ${progressInfo.tool}`);
                        }
                        break;
                }
            },
            (statusMessage) => {
                // onStatusMessage - handle status message updates
                if (statusMessage.should_remove) {
                    this.chatStore.removeMessage(statusMessage.message_id);
                    if (statusMessageId === statusMessage.message_id) {
                        statusMessageId = null;
                    }
                } else {
                    // Track status message ID
                    statusMessageId = statusMessage.message_id;
                    var existingMessage = this.chatStore.getMessageById(statusMessage.message_id);
                    if (existingMessage) {
                        this.chatStore.updateMessage(statusMessage);
                    } else {
                        this.chatStore.addMessage(statusMessage);
                    }
                }
                this.displayWidget.showMessages(this.chatStore.query());
            }
        );
      })).catch(lang.hitch(this, function(error) {
        console.error('Error capturing or processing screenshot:', error);
        topic.publish('showChatPanel'); // Ensure panel is shown even on error

        // Fall back to HTML content if screenshot fails
        console.log('Falling back to HTML content');
        this._handlePageContentSubmitStream();
      }));
    },

    _handlePageContentSubmitStream: function() {
      var inputText = this.textArea.get('value');
      var _self = this;

      // Immediately show user message and clear text area
      var userMessage = {
        role: 'user',
        content: inputText,
        message_id: 'user_' + Date.now(),
        timestamp: new Date().toISOString()
      };

      this.chatStore.addMessage(userMessage);
      this.displayWidget.showMessages(this.chatStore.query());
      this._setInputTextValue('');

      const pageHtml = document.documentElement.innerHTML;

      var systemPrompt = 'You are a helpful assistant that can answer questions about the page content.\\n' +
          'Answer questions as if you were a user viewing the page.\\n' +
          'The page content is:\\n' +
          pageHtml;
      if (this.systemPrompt) {
          systemPrompt += '\\n' + this.systemPrompt;
      }
      if (this.statePrompt) {
        systemPrompt = this.statePrompt + '\\n\\n' + systemPrompt;
      }

      this.displayWidget.showLoadingIndicator(this.chatStore.query());

      // Track assistant message and status message ID
      let assistantMessage = null;
      let statusMessageId = null;
      let assistantMessageCreated = false;

      this.displayWidget.hideLoadingIndicator();

      const params = {
          inputText: inputText,
          sessionId: this.sessionId,
          systemPrompt: systemPrompt,
          model: this.model,
          save_chat: true,
          ragDb: this.ragDb,
          numDocs: this.numDocs,
          enhancedPrompt: this.enhancedPrompt
      };
      this._appendWorkspaceSelectionToStreamParams(params);

      this._submitCopilotQueryStreamWithRegistration(params,
          (chunk, toolMetadata) => {
              // onData - create assistant message on first chunk if not exists
              if (!assistantMessageCreated) {
                  // Remove status message if it exists
                  if (statusMessageId) {
                      this.chatStore.removeMessage(statusMessageId);
                      statusMessageId = null;
                  }
                  // Create assistant message
                  assistantMessage = {
                      role: 'assistant',
                      content: '',
                      message_id: 'assistant_' + Date.now(),
                      timestamp: new Date().toISOString()
                  };

                  // Add tool metadata if available (for workflow handling)
                  if (toolMetadata) {
                      this._applyToolMetadataToAssistantMessage(assistantMessage, toolMetadata);
                  }
                  this.chatStore.addMessage(assistantMessage);
                  assistantMessageCreated = true;
              }
              if (toolMetadata) {
                  this._applyToolMetadataToAssistantMessage(assistantMessage, toolMetadata);
              }
              // Append content to assistant message
              assistantMessage.content += chunk;
              this.displayWidget.showMessages(this.chatStore.query());
          },
          () => {
              // onEnd
              if (_self.new_chat) {
                  _self._finishNewChat();
              }
              this.isSubmitting = false;
              this.submitButton.set('disabled', false);
              // Deselect the pageContentToggle after submission
              this.pageContentEnabled = false;
              this._updateToggleButtonStyle();
              topic.publish('pageContentToggleChanged', false);
          },
          (error) => {
              // onError
              topic.publish('CopilotApiError', {
                  error: error
              });
              this.displayWidget.hideLoadingIndicator();
              this.isSubmitting = false;
              this.submitButton.set('disabled', false);
          },
          (progressInfo) => {
              // onProgress - handle queue status updates
              switch(progressInfo.type) {
                  case 'queued':
                      // Silent - no logging for queued event
                      break;
                  case 'started':
                      // Silent - no logging for started event
                      break;
                  case 'progress':
                      console.log(`Processing: ${progressInfo.percentage}% (Iteration ${progressInfo.iteration}/${progressInfo.max_iterations})`);
                      if (progressInfo.tool) {
                          console.log(`Using tool: ${progressInfo.tool}`);
                      }
                      break;
              }
          },
          (statusMessage) => {
              // onStatusMessage - handle status message updates
              if (statusMessage.should_remove) {
                  this.chatStore.removeMessage(statusMessage.message_id);
                  if (statusMessageId === statusMessage.message_id) {
                      statusMessageId = null;
                  }
              } else {
                  // Track status message ID
                  statusMessageId = statusMessage.message_id;
                  var existingMessage = this.chatStore.getMessageById(statusMessage.message_id);
                  if (existingMessage) {
                      this.chatStore.updateMessage(statusMessage);
                  } else {
                      this.chatStore.addMessage(statusMessage);
                  }
              }
              this.displayWidget.showMessages(this.chatStore.query());
          }
      );
    },

    /**
       * @method _updateToggleButtonStyle
       * @description Updates the toggle button's visual state based on pageContentEnabled
       */
    _updateToggleButtonStyle: function() {
      if (!this.pageContentToggle || !this.pageContentToggle.domNode) {
          return;
      }
      var buttonNode = this.pageContentToggle.domNode;
      if (this.pageContentEnabled) {
          buttonNode.classList.remove('pageContentToggleInactive');
          buttonNode.classList.add('pageContentToggleActive');
      } else {
          buttonNode.classList.remove('pageContentToggleActive');
          buttonNode.classList.add('pageContentToggleInactive');
      }
    },

    destroy: function() {
      this._topicHandles.forEach(function(h) { h.remove(); });
      this._topicHandles = [];
      this.inherited(arguments);
    }
  });
});

/**
 * @module p3/widget/CopilotInput
 * @description A widget that provides a text input interface for the PATRIC Copilot chat system.
 * Includes an auto-expanding textarea and submit button for sending queries to the Copilot API.
 * All submissions route through the /copilot-agent streaming endpoint.
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

      statePrompt: null,

      // Widget styling
      style: 'padding: 0 5px 5px 5px; border: 0; height: 20%; overflow: visible;',

      // Size constraints for the widget
      minSize: 40,
      maxSize: 200,

      selectedWorkspaceItems: [],
      selectedJobs: [],
      selectedWorkflows: [],
      attachedImages: [],
      attachedFiles: [],    // text file attachments [{id, name, content, size, mimeType}]
      imageUploadInput: null,
      imageActionNode: null,
      imageActionMenuNode: null,
      imageActionOutsideClickHandle: null,
      screenshotMenuItemNode: null,
      onImageAttachmentsChanged: null,
      _nextImageAttachmentId: 0,
      _isCapturingScreenshot: false,
      _attachMenuKeyHandle: null,

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
        this._renderAttachmentChips();
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

      _getAttachmentSlotCount: function() {
        return (this.attachedImages ? this.attachedImages.length : 0) +
          (this.attachedFiles ? this.attachedFiles.length : 0);
      },

      _createAttachMenuItem: function(menuNode, iconClass, label, onClick) {
        var item = domConstruct.create('button', {
          type: 'button',
          className: 'copilotAttachMenuItem',
          role: 'menuitem'
        }, menuNode);
        domConstruct.create('i', {
          className: 'fa ' + iconClass
        }, item);
        domConstruct.create('span', {
          textContent: label
        }, item);
        on(item, 'click', lang.hitch(this, function(evt) {
          evt.preventDefault();
          evt.stopPropagation();
          onClick.call(this);
        }));
        return item;
      },

      _isAttachMenuOpen: function() {
        return !!(this.imageActionMenuNode && this.imageActionMenuNode.style.display !== 'none');
      },

      _toggleAttachMenu: function(evt) {
        if (evt) {
          evt.preventDefault();
          evt.stopPropagation();
        }
        if (this._isCapturingScreenshot) {
          return;
        }
        if (this._isAttachMenuOpen()) {
          this._closeAttachMenu();
        } else {
          this._openAttachMenu();
        }
      },

      _openAttachMenu: function() {
        if (!this.imageActionMenuNode) {
          return;
        }
        this._updateImageCapabilityUI();
        this.imageActionMenuNode.style.display = 'block';
        if (this.imageActionNode) {
          this.imageActionNode.setAttribute('aria-expanded', 'true');
        }
        this._bindAttachMenuDismiss();
      },

      _closeAttachMenu: function() {
        if (this.imageActionMenuNode) {
          this.imageActionMenuNode.style.display = 'none';
        }
        if (this.imageActionNode) {
          this.imageActionNode.setAttribute('aria-expanded', 'false');
        }
        this._unbindAttachMenuDismiss();
      },

      _bindAttachMenuDismiss: function() {
        this._unbindAttachMenuDismiss();
        this.imageActionOutsideClickHandle = on(document, 'mousedown', lang.hitch(this, function(evt) {
          var target = evt.target;
          if (this.imageActionMenuNode && this.imageActionMenuNode.contains(target)) {
            return;
          }
          if (this.imageActionNode && this.imageActionNode.contains(target)) {
            return;
          }
          this._closeAttachMenu();
        }));
        this._attachMenuKeyHandle = on(document, 'keydown', lang.hitch(this, function(evt) {
          if (evt.key === 'Escape' || evt.keyCode === 27) {
            this._closeAttachMenu();
          }
        }));
      },

      _unbindAttachMenuDismiss: function() {
        if (this.imageActionOutsideClickHandle) {
          this.imageActionOutsideClickHandle.remove();
          this.imageActionOutsideClickHandle = null;
        }
        if (this._attachMenuKeyHandle) {
          this._attachMenuKeyHandle.remove();
          this._attachMenuKeyHandle = null;
        }
      },

      _setAttachButtonCapturing: function(isCapturing) {
        if (!this.imageActionNode) {
          return;
        }
        this.imageActionNode.disabled = !!isCapturing;
        this.imageActionNode.title = isCapturing ? 'Capturing screenshot...' : 'Attach';
        this.imageActionNode.classList.toggle('isCapturing', !!isCapturing);
      },

      _captureScreenshotNow: function() {
        if (this._isCapturingScreenshot) {
          return;
        }
        if (!this._modelSupportsImage(this.model)) {
          return;
        }
        var maxAttachments = 3;
        if (this._getAttachmentSlotCount() >= maxAttachments) {
          topic.publish('CopilotApiError', { error: new Error('You can attach up to 3 files per message.') });
          return;
        }

        this._isCapturingScreenshot = true;
        this._setAttachButtonCapturing(true);

        var capturePromise = html2canvas(document.body, {
          onclone: function(clonedDoc) {
            var chatPanels = clonedDoc.querySelectorAll('.ChatContainerFloatingWindow, .CopilotFloatingWindow');
            for (var i = 0; i < chatPanels.length; i++) {
              chatPanels[i].style.display = 'none';
            }
          }
        });
        var timeoutPromise = new Promise(function(_, reject) {
          setTimeout(function() { reject(new Error('Screenshot capture timed out')); }, 10000);
        });

        Promise.race([capturePromise, timeoutPromise]).then(lang.hitch(this, function(canvas) {
          if (this._getAttachmentSlotCount() >= maxAttachments) {
            return;
          }
          this.attachedImages.push({
            id: 'img-' + Date.now() + '-' + Math.floor(Math.random() * 1000000),
            image: canvas.toDataURL('image/png'),
            attachment: {
              type: 'image',
              source: 'screenshot',
              name: 'Page screenshot'
            }
          });
          this._renderAttachmentChips();
          this._emitImageAttachmentsChanged();
        })).catch(lang.hitch(this, function(error) {
          console.error('Screenshot capture failed:', error);
          topic.publish('CopilotApiError', {
            error: error instanceof Error ? error : new Error('Screenshot capture failed.')
          });
        })).finally(lang.hitch(this, function() {
          this._isCapturingScreenshot = false;
          this._setAttachButtonCapturing(false);
        }));
      },

      _removeAttachedImageById: function(id) {
        this.attachedImages = (this.attachedImages || []).filter(function(entry) {
          return entry && entry.id !== id;
        });
        this._renderAttachmentChips();
        this._emitImageAttachmentsChanged();
      },

      _removeAttachedFileById: function(id) {
        this.attachedFiles = (this.attachedFiles || []).filter(function(entry) {
          return entry && entry.id !== id;
        });
        this._renderAttachmentChips();
      },

      _appendAttachmentChip: function(parentNode, options) {
        var chip = domConstruct.create('div', {
          className: 'copilotAttachmentChip'
        }, parentNode);

        if (options.thumbnail) {
          domConstruct.create('img', {
            className: 'copilotAttachmentChipThumb',
            src: options.thumbnail,
            alt: ''
          }, chip);
        } else if (options.iconClass) {
          domConstruct.create('i', {
            className: 'fa ' + options.iconClass + ' copilotAttachmentChipIcon'
          }, chip);
        }

        domConstruct.create('span', {
          className: 'copilotAttachmentChipName',
          textContent: options.label || '',
          title: options.title || options.label || ''
        }, chip);

        var removeButton = domConstruct.create('button', {
          type: 'button',
          className: 'workspacePathEditorTokenRemove',
          textContent: '\u00d7',
          title: options.removeTitle || 'Remove attachment'
        }, chip);
        on(removeButton, 'click', lang.hitch(this, function(evt) {
          evt.preventDefault();
          evt.stopPropagation();
          if (typeof options.onRemove === 'function') {
            options.onRemove();
          }
        }));
        return chip;
      },

      _renderAttachmentChips: function() {
        if (!this.workspacePathTokenEditorNode) {
          return;
        }
        domConstruct.empty(this.workspacePathTokenEditorNode);

        var images = Array.isArray(this.attachedImages) ? this.attachedImages : [];
        var files = Array.isArray(this.attachedFiles) ? this.attachedFiles : [];
        var matches = WorkspacePathUtils.findPathMatches(this._getInputValue());
        var hasChips = images.length > 0 || files.length > 0 || matches.length > 0;

        if (!hasChips) {
          this.workspacePathTokenEditorNode.style.display = 'none';
          return;
        }

        this.workspacePathTokenEditorNode.style.display = 'flex';

        var tokenListNode = domConstruct.create('div', {
          className: 'workspacePathTokenEditorList'
        }, this.workspacePathTokenEditorNode);

        images.forEach(lang.hitch(this, function(entry) {
          if (!entry) {
            return;
          }
          var attachment = entry.attachment || {};
          var label = attachment.name || (attachment.source === 'screenshot' ? 'Page screenshot' : 'Attached image');
          this._appendAttachmentChip(tokenListNode, {
            thumbnail: typeof entry.image === 'string' ? entry.image : null,
            iconClass: 'icon-image',
            label: label,
            title: label,
            removeTitle: 'Remove this image',
            onRemove: lang.hitch(this, function() {
              this._removeAttachedImageById(entry.id);
            })
          });
        }));

        files.forEach(lang.hitch(this, function(entry) {
          if (!entry) {
            return;
          }
          var label = entry.name || 'Attached file';
          this._appendAttachmentChip(tokenListNode, {
            iconClass: 'icon-file-text-o',
            label: label,
            title: label,
            removeTitle: 'Remove this file',
            onRemove: lang.hitch(this, function() {
              this._removeAttachedFileById(entry.id);
            })
          });
        }));

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

      _renderWorkspacePathTokenEditor: function() {
        this._renderAttachmentChips();
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

        // Gateway-classified card
        if (toolMetadata.card && toolMetadata.card.card_type) {
          assistantMessage.card = toolMetadata.card;
          // Bridge card payloads to the properties that ChatMessage renderers expect.
          if (toolMetadata.card.card_type === 'clarification' && toolMetadata.card.card_payload) {
            assistantMessage.clarificationData = toolMetadata.card.card_payload;
            assistantMessage.isPlanClarification = true;
          }
          if (toolMetadata.card.card_type === 'plan' && toolMetadata.card.card_payload) {
            assistantMessage.planData = toolMetadata.card.card_payload;
            assistantMessage.isPlan = true;
          }
        }

        // Pass through original query for clarification flows
        if (toolMetadata.originalQuery) {
          assistantMessage.originalQuery = toolMetadata.originalQuery;
        }

        // Source tool for reference
        if (toolMetadata.source_tool) {
          assistantMessage.source_tool = toolMetadata.source_tool;
        }
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

        this.displayWidget.showLoadingIndicator();

        var assistantMessage = null;
        var statusMessageId = null;
        var assistantMessageCreated = false;

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
            // onData — same pattern as _handleSubmitStream
            // Only create an assistant message when we actually have something
            // to render (text chunk or a UI widget such as plan/clarification).
            var hasTextChunk = !!(chunk && String(chunk).length > 0);
            var hasWidget = !!(toolMetadata && toolMetadata.card);

            if (!assistantMessageCreated && (hasTextChunk || hasWidget)) {
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

            if (assistantMessageCreated && toolMetadata) {
              _self._applyToolMetadataToAssistantMessage(assistantMessage, toolMetadata);
            }

            if (assistantMessageCreated && hasTextChunk) {
              if (!(chunk.length > 1 && assistantMessage.content.length >= chunk.length && assistantMessage.content.endsWith(chunk))) {
                assistantMessage.content += chunk;
              }
            }

            if (assistantMessageCreated) {
              _self.displayWidget.showMessages(_self.chatStore.query());
            }
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
            // onStatusMessage — same pattern as _handleSubmitStream
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
       * - Creates a unified composer bar (attach + textarea + send)
       * - Adds auto-expanding textarea
       * - Sets up event handlers
       */
      postCreate: function() {
        // Create main wrapper with flex layout
        var wrapperDiv = domConstruct.create('div', {
            className: 'copilotInputWrapper'
        }, this.containerNode);

        var composer = domConstruct.create('div', {
            className: 'copilotComposer'
        }, wrapperDiv);

        this.workspacePathTokenEditorNode = domConstruct.create('div', {
            className: 'workspacePathTokenEditor',
            style: 'display: none;'
        }, composer);

        var composerRow = domConstruct.create('div', {
            className: 'copilotComposerRow'
        }, composer);

        var toggleContainer = domConstruct.create('div', {
            className: 'copilotAttachButtonContainer'
        }, composerRow);

        this.imageActionNode = domConstruct.create('button', {
            type: 'button',
            className: 'copilotAttachButton',
            title: 'Attach',
            'aria-haspopup': 'true',
            'aria-expanded': 'false',
            innerHTML: '<i class="fa icon-paperclip"></i>'
        }, toggleContainer);
        on(this.imageActionNode, 'click', lang.hitch(this, this._toggleAttachMenu));

        this.imageActionMenuNode = domConstruct.create('div', {
            className: 'copilotAttachMenu',
            role: 'menu',
            style: 'display: none;'
        }, toggleContainer);

        this.screenshotMenuItemNode = this._createAttachMenuItem(
            this.imageActionMenuNode,
            'icon-image',
            'Screenshot',
            function() {
                this._closeAttachMenu();
                this._captureScreenshotNow();
            }
        );

        this._createAttachMenuItem(
            this.imageActionMenuNode,
            'icon-file-text-o',
            'Upload File',
            function() {
                this._closeAttachMenu();
                if (this.imageUploadInput) {
                    this.imageUploadInput.click();
                }
            }
        );

        this._createAttachMenuItem(
            this.imageActionMenuNode,
            'icon-folder-open-o',
            'Add Workspace Path',
            function() {
                this._closeAttachMenu();
                this._openWorkspaceChooser();
            }
        );

        this.imageUploadInput = domConstruct.create('input', {
            type: 'file',
            multiple: true,
            style: 'display: none;'
        }, wrapperDiv);
        on(this.imageUploadInput, 'change', lang.hitch(this, this._handleImageUploadChange));

        var textAreaWrapper = domConstruct.create('div', {
            className: 'copilotTextAreaWrapper'
        }, composerRow);

        this.textArea = new Textarea({
            'class': 'copilotComposerTextarea',
            rows: 1,
            maxLength: 10000,
            placeholder: 'Ask anything...'
        });
        this.textArea.placeAt(textAreaWrapper);

        this.submitButton = new Button({
            label: '<i class="fa icon-arrow-up"></i>',
            title: 'Send',
            'class': 'copilotSendButton',
            onClick: lang.hitch(this, function() {
            if (this.isSubmitting) return;
            if (!this.copilotApi) {
                console.error('CopilotApi widget not initialized');
                return;
            }
            this._handleSubmitStream();
            })
        });

        this.submitButton.placeAt(composerRow);

        this.abortButton = new Button({
            label: 'Abort',
            'class': 'copilotAbortButton',
            disabled: true,
            onClick: lang.hitch(this, function() {
                this._handleAbortClick();
            })
        });
        this.abortButton.placeAt(composerRow);

        this._topicHandles.push(topic.subscribe('ChatSession:Selected', lang.hitch(this, function(data) {
            this._closeAttachMenu();
            this._clearAttachedImage();

            this.selectedWorkspaceItems = [];
            this._renderWorkspaceSelectionIndicator();
            this.selectedJobs = [];
            this._renderJobsSelectionIndicator();
            this.selectedWorkflows = [];
        })));

        // Maximum height for textarea before scrolling
        const maxHeight = 160;

        // Handle textarea auto-expansion on input
        on(this.textArea, 'input', function() {
            var node = this.textArea.domNode || this.textArea.textbox;
            if (!node) {
              return;
            }
            node.style.height = 'auto';
            node.style.height = node.scrollHeight + 'px';

            if (node.scrollHeight > maxHeight) {
              node.style.height = maxHeight + 'px';
              node.style.overflowY = 'auto';
            } else {
              node.style.overflowY = 'hidden';
            }
            this._renderAttachmentChips();
        }.bind(this));

        on(this.textArea, 'paste', lang.hitch(this, function() {
            setTimeout(lang.hitch(this, this._renderAttachmentChips), 0);
        }));

        on(this.textArea, 'keyup', lang.hitch(this, this._renderAttachmentChips));

        // Handle Enter key for submission (except with Shift)
        on(this.textArea, 'keypress', lang.hitch(this, function(evt) {
            if (evt.keyCode === 13 && !evt.shiftKey && !this.isSubmitting) {
            evt.preventDefault();
            this.submitButton.onClick();
            }
        }));

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

        // Retry a user message — sets the textarea and immediately submits
        this._topicHandles.push(topic.subscribe('RetryUserMessage', lang.hitch(this, function(messageContent) {
          if (this.isSubmitting) { return; }
          if (!messageContent || typeof messageContent !== 'string') { return; }
          this._setInputTextValue(messageContent);
          this._handleSubmitStream();
        })));

        // ==================== Planning Agent Topic Subscribers ====================

        // 0. CopilotPlanClarificationAnswered — remove the ask_questions chip UI message
        this._topicHandles.push(topic.subscribe('CopilotPlanClarificationAnswered', lang.hitch(this, function(data) {
          try {
            var msgs = this.chatStore && this.chatStore.query ? this.chatStore.query() : [];
            (msgs || []).forEach(lang.hitch(this, function(m) {
              if (m && m.isPlanClarification === true) {
                this.chatStore.removeMessage(m.message_id);
              }
            }));
            this.displayWidget.showMessages(this.chatStore.query());
          } catch (e) {
            console.warn('[CopilotInput] Failed to remove clarification prompt message:', e);
          }
        })));

        // 1. CopilotPlanAnswerQuestions — user answered clarification questions
        this._topicHandles.push(topic.subscribe('CopilotPlanAnswerQuestions', lang.hitch(this, function(data) {
          if (!data || !data.answers) { return; }
          console.log('[CopilotInput] CopilotPlanAnswerQuestions received:', data);

          var clarificationMessage = this._buildClarificationResponseMessage(data.answers);
          this.chatStore.addMessage(clarificationMessage);
          this.displayWidget.showMessages(this.chatStore.query());

          // Keep this compact for backend logs/history. Structured answers are in workflow_context.
          var answerSummary = data.answers.map(function(a) {
            return a.question + ': ' + a.answer;
          }).join('\n');

          this._submitPlanAction(
            data.originalQuery || 'Submitted clarification responses.',
            data.sessionId,
            {
              plan_action: 'answer_questions',
              clarification_answers: data.answers,
              clarification_summary: answerSummary,
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

        // 4b. CopilotPlanEditResubmit — user edited a step description and wants to re-execute it
        this._topicHandles.push(topic.subscribe('CopilotPlanEditResubmit', lang.hitch(this, function(data) {
          if (!data || !data.plan) { return; }
          console.log('[CopilotInput] CopilotPlanEditResubmit received:', data);

          var stepIndex = data.currentStepIndex || 0;
          var editedDesc = data.editedDescription || '';
          var stepLabel = editedDesc
            ? editedDesc.substring(0, 80) + (editedDesc.length > 80 ? '...' : '')
            : 'step ' + (stepIndex + 1);

          this._submitPlanAction(
            'Re-execute edited step: ' + stepLabel,
            data.sessionId,
            {
              plan: data.plan,
              plan_action: 'execute_next',
              current_step_index: stepIndex,
              completed_step_results: data.completedResults || {}
            }
          );
        })));

        // 5. CopilotPlanStepUpdate — sync step statuses on the plan message
        // in the chat store so they survive showMessages() re-renders.
        this._topicHandles.push(topic.subscribe('CopilotPlanStepUpdate', lang.hitch(this, function(data) {
          if (!data || !data.plan_id) { return; }
          var messages = this.chatStore.query();
          for (var i = 0; i < messages.length; i++) {
            var msg = messages[i];
            var planData = msg.planData || msg.plan;
            if (planData && planData.plan_id === data.plan_id && planData.steps) {
              for (var j = 0; j < planData.steps.length; j++) {
                if (planData.steps[j].step_id === data.step_id) {
                  if (data.event === 'started') {
                    planData.steps[j].status = 'running';
                    planData.status = 'executing';
                  } else if (data.event === 'completed') {
                    planData.steps[j].status = 'completed';
                    planData.steps[j].result_summary = data.result_summary || '';
                  } else if (data.event === 'failed') {
                    planData.steps[j].status = 'failed';
                  }
                  break;
                }
              }
              break;
            }
          }
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
        this._renderAttachmentChips();
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

        this._closeAttachMenu();
        this._clearAttachedImage();

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

        this._closeAttachMenu();
        this._clearAttachedImage();

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

        if (this.screenshotMenuItemNode) {
          this.screenshotMenuItemNode.style.display = enabled ? 'flex' : 'none';
        }

        if (!enabled && this.attachedImages && this.attachedImages.length > 0) {
          this.attachedImages = [];
          this._renderAttachmentChips();
          this._emitImageAttachmentsChanged();
        }
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
          this._renderAttachmentChips();
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
        this._renderAttachmentChips();
        this._emitImageAttachmentsChanged();
      },

      setAttachedImages: function(entries) {
        this.attachedImages = Array.isArray(entries) ? entries.slice() : [];
        this._renderAttachmentChips();
        this._emitImageAttachmentsChanged();
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

      _buildClarificationResponseMessage: function(answers) {
        var formattedLines = ['**Clarification Responses**'];
        (answers || []).forEach(function(a, idx) {
          var question = (a && a.question) ? String(a.question) : ('Question ' + (idx + 1));
          var answer = (a && a.answer) ? String(a.answer) : '(no answer)';
          formattedLines.push((idx + 1) + '. **' + question + '**');
          formattedLines.push('   - ' + answer);
        });

          return {
            role: 'user_clarification',
            content: formattedLines.join('\n'),
            message_id: 'user_clarification_' + Date.now(),
            timestamp: new Date().toISOString(),
            clarificationAnswers: answers || []
          };
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

    _handleSubmitStream: function() {
      var inputText = this.textArea.get('value');
      var _self = this;
      var uploadedImagePayload = this._getUploadedImagePayload();
      var hasUploadedImage = !!(uploadedImagePayload && Array.isArray(uploadedImagePayload.images) && uploadedImagePayload.images.length > 0 && this._modelSupportsImage(this.model));
      var uploadedFilesPayload = this._getUploadedFilesPayload();
      var hasUploadedFiles = !!(uploadedFilesPayload && Array.isArray(uploadedFilesPayload.files) && uploadedFilesPayload.files.length > 0);
      var hasScreenshot = hasUploadedImage && (uploadedImagePayload.attachments || []).some(function(att) {
        return att && att.source === 'screenshot';
      });
      var hasAnyImage = hasUploadedImage;
      var submitModel = hasAnyImage ? this._resolveImageModel() : this.model;

      topic.publish('ChatMessageSubmitted');

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

      this.displayWidget.showLoadingIndicator();

      var systemPrompt = 'You are a helpful scientist website assistant for the website BV-BRC, the Bacterial and Viral Bioinformatics Resource Center.\\n\\n';
      if (this.systemPrompt) {
          systemPrompt += this.systemPrompt;
      }
      if (this.statePrompt) {
          systemPrompt += this.statePrompt;
      }
      if (hasAnyImage) {
          systemPrompt += '\\n\\nThe user attached an image. Use it as additional context.';
      }
      if (hasScreenshot) {
          systemPrompt += ' Analyze the screenshot and respond to the user\'s query.';
      }

      let assistantMessage = null;
      let statusMessageId = null;
      let assistantMessageCreated = false;

      const params = {
          inputText: inputText,
          sessionId: this.sessionId,
          systemPrompt: systemPrompt,
          model: submitModel,
          save_chat: true
      };

      if (hasUploadedImage) {
        params.images = uploadedImagePayload.images;
        params.image_attachments = uploadedImagePayload.attachments || [];
      }
      if (hasUploadedFiles) {
        params.files = uploadedFilesPayload.files;
      }
      this._appendWorkspaceSelectionToStreamParams(params);

      this._submitCopilotQueryStreamWithRegistration(params,
          (chunk, toolMetadata) => {
              var hasTextChunk = !!(chunk && String(chunk).length > 0);
              var hasWidget = !!(toolMetadata && toolMetadata.card);

              if (!assistantMessageCreated && (hasTextChunk || hasWidget)) {
                  this.displayWidget.hideLoadingIndicator();
                  if (statusMessageId) {
                      this.chatStore.removeMessage(statusMessageId);
                      statusMessageId = null;
                  }
                  assistantMessage = {
                      role: 'assistant',
                      content: '',
                      message_id: 'assistant_' + Date.now(),
                      timestamp: new Date().toISOString()
                  };
                  if (toolMetadata) {
                      this._applyToolMetadataToAssistantMessage(assistantMessage, toolMetadata);
                  }
                  this.chatStore.addMessage(assistantMessage);
                  assistantMessageCreated = true;
              }
              if (assistantMessageCreated && toolMetadata) {
                  this._applyToolMetadataToAssistantMessage(assistantMessage, toolMetadata);
              }
              if (assistantMessageCreated && hasTextChunk) {
                  if (!(chunk.length > 1 && assistantMessage.content.length >= chunk.length && assistantMessage.content.endsWith(chunk))) {
                      assistantMessage.content += chunk;
                  }
              }
              if (assistantMessageCreated) {
                  this.displayWidget.showMessages(this.chatStore.query());
              }
          },
          () => {
              this.displayWidget.hideLoadingIndicator();
              if (_self.new_chat) {
                  _self._finishNewChat();
              }
              this.isSubmitting = false;
              this.isQueryProgressActive = false;
              this.submitButton.set('disabled', false);
              this._updateAbortButtonState();
          },
          (error) => {
              topic.publish('CopilotApiError', { error: error });
              this.displayWidget.hideLoadingIndicator();
              this.isSubmitting = false;
              this.isQueryProgressActive = false;
              this.submitButton.set('disabled', false);
              this._updateAbortButtonState();
          },
          (progressInfo) => {
              switch(progressInfo.type) {
                  case 'queued':
                      break;
                  case 'started':
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
              this._handleAbortStatusMessageEvent(statusMessage);

              if (statusMessage.should_remove) {
                  this.chatStore.removeMessage(statusMessage.message_id);
                  if (statusMessageId === statusMessage.message_id) {
                      statusMessageId = null;
                  }
              } else {
                  this.displayWidget.hideLoadingIndicator();
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

    destroy: function() {
      this._closeAttachMenu();
      this._topicHandles.forEach(function(h) { h.remove(); });
      this._topicHandles = [];
      this.inherited(arguments);
    }
  });
});

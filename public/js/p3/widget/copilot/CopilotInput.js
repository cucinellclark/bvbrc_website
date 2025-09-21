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
    'dojo/_base/declare', 'dojo/dom-construct', 'dojo/on', 'dijit/layout/ContentPane', 'dijit/form/Textarea', 'dijit/form/Button', 'dojo/topic', 'dojo/_base/lang', 'dojo/dom-style', 'html2canvas/dist/html2canvas.min', './ChatAttachment'
  ], function (
    declare, domConstruct, on, ContentPane, Textarea, Button, topic, lang, domStyle, html2canvas, ChatAttachment
  ) {
    /**
     * @class CopilotInput
     * @extends {dijit/layout/ContentPane}
     */
    return declare([ContentPane], {
      //================================================================
      // WIDGET CONFIGURATION & STATE PROPERTIES
      //================================================================

      /** Widget styling */
      style: 'padding: 0 5px 5px 5px; border: 0; height: 20%;',

      /** Size constraints for the widget */
      minSize: 40,
      maxSize: 200,

      //================================================================
      // COPILOT API & SESSION PROPERTIES
      //================================================================

      /** Reference to the CopilotAPI instance for making backend requests */
      copilotApi: null,

      /** Flag indicating if this is a new chat session that needs initialization */
      new_chat: true,

      /** Flag to prevent multiple simultaneous submissions */
      isSubmitting: false,

      //================================================================
      // PROMPT & MODEL CONFIGURATION
      //================================================================

      /** Custom system prompt to prepend to queries */
      systemPrompt: null,

      /** State-specific prompt context */
      statePrompt: null,

      /** Enhanced prompt for advanced query processing */
      enhancedPrompt: null,

      /** Selected language model for chat completion */
      model: null,

      /** Selected RAG database for enhanced responses */
      ragDb: 'bvbrc_helpdesk',

      /** Number of documents to use for RAG queries */
      numDocs: 3,

      //================================================================
      // UI STATE PROPERTIES
      //================================================================

      /** Flag to track page content toggle state */
      pageContentEnabled: false,

      /** Array to store attachment widgets */
      attachments: [],

      //================================================================
      // LIFECYCLE METHODS
      //================================================================

      /**
       * Constructor that initializes the widget with provided options
       * Uses safeMixin to safely merge configuration arguments
       */
      constructor: function(args) {
        declare.safeMixin(this, args);
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

        // Container for attachments above the input
        this.attachmentContainer = domConstruct.create('div', {
            style: 'display: flex; flex-wrap: wrap; justify-content: flex-start; align-items: center; width: 60%; margin-bottom: 6px; min-height: 30px;'
        }, wrapperDiv);

        // Add Context button
        this.addContextButton = new Button({
            label: '+ Attach',
            style: 'height: 30px; margin-right: 10px;',
            onClick: lang.hitch(this, function() {
                this._addBlankAttachment();
            })
        });

        // Add button to attachment container
        this.addContextButton.placeAt(this.attachmentContainer);

        // Add container for the toggle switch and label on the left side
        var toggleContainer = domConstruct.create('div', {
            style: 'width: auto; height: 35px; display: flex; flex-direction: column; align-items: center; margin-right: 15px;'
        }, inputContainer);

        // Create screenshot div above the toggle button
        var screenshotDiv = domConstruct.create('div', {
            'class': 'screenshotDivAboveToggle',
            innerHTML: 'Include<br>Screenshot'
        });

        // Create the page content toggle using the screenshot div
        this.pageContentToggle = {
            domNode: screenshotDiv,
            placeAt: function(container) {
                container.appendChild(screenshotDiv);
            }
        };

        // Add click handler and properties to screenshot div
        screenshotDiv.title = 'Sends a screenshot of the current BV-BRC page to help answer your question.';
        screenshotDiv.style.cursor = 'pointer';
        on(screenshotDiv, 'click', lang.hitch(this, function() {
            topic.publish('pageContentToggleChanged', !this.pageContentEnabled);
        }));

        this.pageContentToggle.placeAt(toggleContainer);

        // Initialize button style
        this._updateToggleButtonStyle();

        // Configure textarea with auto-expansion and styling
        this.textArea = new Textarea({
            style: 'width: 60%; min-height: 50px; max-height: 100%; resize: none; overflow-y: hidden; border-radius: 5px; margin-right: 10px;',
            rows: 3, // Default visible rows
            maxLength: 10000,
            placeholder: 'Enter your text here...'
        });

        // Add textarea to container
        this.textArea.placeAt(inputContainer);

        // Configure submit button with click handler
        this.submitButton = new Button({
            label: 'Submit',
            style: 'height: 30px; margin-right: 10px;',
            onClick: lang.hitch(this, function() {
                // If currently streaming, stop the stream
                if (this.isSubmitting) {
                    this._stopStream();
                    return;
                }

                // Prevent multiple simultaneous submissions
                if (this.isSubmitting) return;

                // Handle different submission types based on configuration
                if (this.pageContentEnabled) {
                    this._handlePageSubmitStream();
                } else if (this.copilotApi && this.ragDb) {
                    this._handleRagSubmitStream();
                    // this._handleRagSubmit();
                } else if (this.copilotApi) {
                    this._handleRegularSubmitStream();
                } else {
                    console.error('CopilotApi widget not initialized');
                }
            })
        });

        // Add button to container
        this.submitButton.placeAt(inputContainer);

        // Subscribe to page content toggle changes from ChatSessionOptionsBar
        topic.subscribe('pageContentToggleChanged', lang.hitch(this, function(checked) {
            this.pageContentEnabled = checked;
            this._updateToggleButtonStyle();
            console.log('Page content toggle changed to:', checked);
        }));

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
        }.bind(this));

        // Handle Enter key for submission (except with Shift)
        on(this.textArea, 'keypress', lang.hitch(this, function(evt) {
            if (evt.keyCode === 13 && !evt.shiftKey && !this.isSubmitting) {
            evt.preventDefault();
            this.submitButton.onClick();
            }
        }));

        topic.subscribe('enhancePromptChange', lang.hitch(this, function(enhancedPrompt) {
          this.enhancedPrompt = enhancedPrompt;
        }));

        // Subscribe to main chat suggestion selection to populate input text area
        topic.subscribe('populateInputSuggestion', lang.hitch(this, function(suggestion) {
          if (this.textArea) {
            this.textArea.set('value', suggestion);
            // Focus on the text area and place cursor at the end
            this.textArea.focus();
            if (this.textArea.textbox) {
              var textbox = this.textArea.textbox;
              textbox.selectionStart = textbox.selectionEnd = suggestion.length;
            }
          }
        }));
      },

      //================================================================
      // SUBMISSION HANDLER METHODS
      //================================================================

      /**
       * Stops the current streaming request and resets the UI
       */
      _stopStream: function() {
          if (this.copilotApi && this.copilotApi.stopCurrentStream()) {
              console.log('Stream stopped by user');
          }

          // Reset UI state
          this.isSubmitting = false;
          this.submitButton.set('label', 'Submit');
          this.submitButton.set('disabled', false);
          this.displayWidget.hideLoadingIndicator();
      },

      /**
       * Updates the submit button to show "Stop" during streaming
       */
      _setButtonToStop: function() {
          this.submitButton.set('label', 'Stop');
          this.submitButton.set('disabled', false); // Keep enabled so user can stop
      },

      /**
       * Updates the submit button to show "Submit" when not streaming
       */
      _setButtonToSubmit: function() {
          this.submitButton.set('label', 'Submit');
          this.submitButton.set('disabled', false);
      },

      /**
       * Handles streaming submission of RAG queries with document retrieval
       */
      _handleRagSubmitStream: function() {
        console.log('this.ragDb=', this.ragDb);
        var inputText = this.textArea.get('value');
        var _self = this;

        if (this.state) {
          console.log('state', this.state);
        }

        // Immediately show user message and clear text area
        var userMessage = {
          role: 'user',
          content: inputText,
          message_id: null,
          timestamp: new Date().toISOString()
        };

        this.chatStore.addMessage(userMessage);
        this.displayWidget.showMessages(this.chatStore.query());
        this.textArea.set('value', '');

        this.isSubmitting = true;
        this._setButtonToStop();
        this.displayWidget.showLoadingIndicator(this.chatStore.query());

        var systemPrompt = 'You are a helpful scientist website assistant for the website BV-BRC, the Bacterial and Viral Bioinformatics Resource Center.\\n\\n';
        if (this.systemPrompt) {
            systemPrompt += this.systemPrompt;
        }
        if (this.statePrompt) {
            systemPrompt += this.statePrompt;
        }

        // Add attachments prompt
        var attachmentsPrompt = this._getAttachmentsPrompt();
        if (attachmentsPrompt) {
            systemPrompt += attachmentsPrompt;
        }

        // Create messages for streaming
        let systemMessage = {
            role: 'system',
            message_id: null,
            content: '',
            copilotDetails: null,
            ragDocs: null,
            timestamp: new Date().toISOString()
        };
        this.chatStore.addMessage(systemMessage);

        let assistantMessage = {
            role: 'assistant',
            content: '',
            message_id: null,
            timestamp: new Date().toISOString()
        };
        this.chatStore.addMessage(assistantMessage);

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

        this.copilotApi.submitCopilotQueryStream(params,
            (chunk) => {
                assistantMessage.content += chunk;
                this.displayWidget.hideLoadingIndicator();
                this.displayWidget.showMessages(this.chatStore.query());
            },
            () => {
                if (_self.new_chat) {
                    _self._finishNewChat();
                }
                this.isSubmitting = false;
                this._setButtonToSubmit();
            },
            (error) => {
                topic.publish('CopilotApiError', { error: error });
                this.displayWidget.hideLoadingIndicator();
                this.isSubmitting = false;
                this._setButtonToSubmit();
            },
            (setupMetadata) => {
              if (setupMetadata) {
                if (setupMetadata.assistantMessage && setupMetadata.assistantMessage.message_id) {
                  assistantMessage.message_id = setupMetadata.assistantMessage.message_id;
                }
                if (setupMetadata.userMessage && setupMetadata.userMessage.message_id) {
                  userMessage.message_id = setupMetadata.userMessage.message_id;
                }
                if (setupMetadata.systemMessage) {
                  systemMessage.message_id = setupMetadata.systemMessage.message_id;
                  systemMessage.content = setupMetadata.systemMessage.content || '';
                  systemMessage.copilotDetails = setupMetadata.copilot_details;
                  systemMessage.documents = setupMetadata.rag_docs;
                  systemMessage.timestamp = setupMetadata.systemMessage.timestamp || new Date().toISOString();
                } else if (setupMetadata.copilot_details) {
                  assistantMessage.copilotDetails = setupMetadata.copilot_details;
                }
                this.displayWidget.showMessages(this.chatStore.query());
              }
            }
        );
      },

      /**
       * Handles streaming submission of regular (non-RAG) queries
       */
      _handleRegularSubmitStream: function() {
        var inputText = this.textArea.get('value');
        var _self = this;

        // Immediately show user message and clear text area
        var userMessage = {
          role: 'user',
          content: inputText,
          message_id: null,
          timestamp: new Date().toISOString()
        };

        this.chatStore.addMessage(userMessage);
        this.displayWidget.showMessages(this.chatStore.query());
        this.textArea.set('value', '');

        this.isSubmitting = true;
        this._setButtonToStop();
        this.displayWidget.showLoadingIndicator(this.chatStore.query());

        var systemPrompt = 'You are a helpful scientist website assistant for the website BV-BRC, the Bacterial and Viral Bioinformatics Resource Center.\\n\\n';
        if (this.systemPrompt) {
            systemPrompt += this.systemPrompt;
        }
        if (this.statePrompt) {
            systemPrompt += this.statePrompt;
        }

        // Add attachments prompt
        var attachmentsPrompt = this._getAttachmentsPrompt();
        if (attachmentsPrompt) {
            systemPrompt += attachmentsPrompt;
        }

        // Create messages for streaming
        let systemMessage = {
            role: 'system',
            message_id: null,
            content: '',
            copilotDetails: null,
            ragDocs: null,
            timestamp: new Date().toISOString()
        };
        this.chatStore.addMessage(systemMessage);

        let assistantMessage = {
            role: 'assistant',
            content: '',
            message_id: null,
            timestamp: new Date().toISOString()
        };
        this.chatStore.addMessage(assistantMessage);

        const params = {
            inputText: inputText,
            sessionId: this.sessionId,
            systemPrompt: systemPrompt,
            model: this.model,
            save_chat: true
        };

        this.copilotApi.submitCopilotQueryStream(params,
            (chunk) => {
                assistantMessage.content += chunk;
                this.displayWidget.hideLoadingIndicator();
                this.displayWidget.showMessages(this.chatStore.query());
            },
            () => {
                if (_self.new_chat) {
                    _self._finishNewChat();
                }
                this.isSubmitting = false;
                this._setButtonToSubmit();
            },
            (error) => {
                topic.publish('CopilotApiError', { error: error });
                this.displayWidget.hideLoadingIndicator();
                this.isSubmitting = false;
                this._setButtonToSubmit();
            },
            (setupMetadata) => {
              if (setupMetadata) {
                if (setupMetadata.assistantMessage && setupMetadata.assistantMessage.message_id) {
                  assistantMessage.message_id = setupMetadata.assistantMessage.message_id;
                }
                if (setupMetadata.userMessage && setupMetadata.userMessage.message_id) {
                  userMessage.message_id = setupMetadata.userMessage.message_id;
                }
                if (setupMetadata.systemMessage) {
                  systemMessage.message_id = setupMetadata.systemMessage.message_id;
                  systemMessage.content = setupMetadata.systemMessage.content || '';
                  systemMessage.copilotDetails = setupMetadata.copilot_details;
                  systemMessage.documents = setupMetadata.rag_docs;
                  systemMessage.timestamp = setupMetadata.systemMessage.timestamp || new Date().toISOString();
                } else if (setupMetadata.copilot_details) {
                  assistantMessage.copilotDetails = setupMetadata.copilot_details;
                }
                this.displayWidget.showMessages(this.chatStore.query());
              }
            }
        );
      },

      /**
       * Handles submission of page content with screenshot capture
       */
      _handlePageSubmitStream: function() {
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
        this.textArea.set('value', '');

        this.isSubmitting = true;
        this._setButtonToStop();

        topic.publish('hideChatPanel');

        html2canvas(document.body).then(lang.hitch(this, function(canvas) {
          var base64Image = canvas.toDataURL('image/png');
          topic.publish('showChatPanel');

          this.displayWidget.showLoadingIndicator(this.chatStore.query());
          var imageSystemPrompt = 'You are a helpful scientist website assistant for the website BV-BRC, the Bacterial and Viral Bioinformatics Resource Center. You can also answer questions about the attached screenshot.\\n' +
          'Analyze the screenshot and respond to the user\'s query.';

          if (this.systemPrompt) {
              imageSystemPrompt += '\\n\\n' + this.systemPrompt;
          }
          if (this.statePrompt) {
              imageSystemPrompt = imageSystemPrompt + '\\n\\n' + this.statePrompt;
          }

          // Add attachments prompt
          var attachmentsPrompt = this._getAttachmentsPrompt();
          if (attachmentsPrompt) {
              imageSystemPrompt += attachmentsPrompt;
          }

          var imgtxt_model = 'RedHatAI/Llama-4-Scout-17B-16E-Instruct-quantized.w4a16';

          // Create messages for streaming
          let systemMessage = {
              role: 'system',
              message_id: null,
              content: '',
              copilotDetails: null,
              ragDocs: null,
              timestamp: new Date().toISOString()
          };
          this.chatStore.addMessage(systemMessage);

          let assistantMessage = {
              role: 'assistant',
              content: '',
              message_id: null,
              timestamp: new Date().toISOString()
          };
          this.chatStore.addMessage(assistantMessage);

          const params = {
              stream: true,
              inputText: inputText,
              sessionId: this.sessionId,
              systemPrompt: imageSystemPrompt,
              model: imgtxt_model,
              save_chat: true,
              ragDb: this.ragDb,
              numDocs: this.numDocs,
              image: base64Image,
              enhancedPrompt: this.enhancedPrompt
          };

          this.copilotApi.submitCopilotQueryStream(params,
              (chunk) => {
                  assistantMessage.content += chunk;
                  console.log('chunk=', chunk);
                  this.displayWidget.hideLoadingIndicator();
                  this.displayWidget.showMessages(this.chatStore.query());
              },
              () => {
                  if (_self.new_chat) {
                      _self._finishNewChat();
                  }
                  this.isSubmitting = false;
                  this._setButtonToSubmit();
                  this.pageContentEnabled = false;
                  this._updateToggleButtonStyle();
                  topic.publish('pageContentToggleChanged', false);
              },
              (error) => {
                  topic.publish('CopilotApiError', { error: error });
                  this.displayWidget.hideLoadingIndicator();
                  this.isSubmitting = false;
                  this._setButtonToSubmit();
              },
              (setupMetadata) => {
                  if (setupMetadata) {
                      if (setupMetadata.assistantMessage && setupMetadata.assistantMessage.message_id) {
                          assistantMessage.message_id = setupMetadata.assistantMessage.message_id;
                      }
                      if (setupMetadata.userMessage && setupMetadata.userMessage.message_id) {
                          userMessage.message_id = setupMetadata.userMessage.message_id;
                      }
                      if (setupMetadata.systemMessage) {
                          systemMessage.message_id = setupMetadata.systemMessage.message_id;
                          systemMessage.content = setupMetadata.systemMessage.content || '';
                          systemMessage.copilotDetails = setupMetadata.copilot_details;
                          systemMessage.documents = setupMetadata.rag_docs;
                          systemMessage.timestamp = setupMetadata.systemMessage.timestamp || new Date().toISOString();
                      } else if (setupMetadata.copilot_details) {
                          assistantMessage.copilotDetails = setupMetadata.copilot_details;
                      }
                      this.displayWidget.showMessages(this.chatStore.query());
                  }
              }
            );
        })).catch(lang.hitch(this, function(error) {
            console.error('Error capturing or processing screenshot:', error);
            topic.publish('showChatPanel');
            console.log('Falling back to HTML content');
            this._handlePageContentSubmitStream();
        }));
      },

      /**
       * Handles streaming submission of page content (HTML) as fallback
       */
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
        this.textArea.set('value', '');

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

        // Add attachments prompt
        var attachmentsPrompt = this._getAttachmentsPrompt();
        if (attachmentsPrompt) {
            systemPrompt += attachmentsPrompt;
        }

        this.displayWidget.showLoadingIndicator(this.chatStore.query());

        // Create messages for streaming
        let systemMessage = {
            role: 'system',
            message_id: null,
            content: '',
            copilotDetails: null,
            ragDocs: null,
            timestamp: new Date().toISOString()
        };
        this.chatStore.addMessage(systemMessage);

        let assistantMessage = {
            role: 'assistant',
            content: '',
            message_id: null,
            timestamp: new Date().toISOString()
        };
        this.chatStore.addMessage(assistantMessage);

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

        this.copilotApi.submitCopilotQueryStream(params,
            (chunk) => {
                assistantMessage.content += chunk;
                this.displayWidget.hideLoadingIndicator();
                this.displayWidget.showMessages(this.chatStore.query());
            },
            () => {
                if (_self.new_chat) {
                    _self._finishNewChat();
                }
                this.isSubmitting = false;
                this._setButtonToSubmit();
                this.pageContentEnabled = false;
                this._updateToggleButtonStyle();
                topic.publish('pageContentToggleChanged', false);
            },
            (error) => {
                topic.publish('CopilotApiError', { error: error });
                this.displayWidget.hideLoadingIndicator();
                this.isSubmitting = false;
                this._setButtonToSubmit();
            },
            (setupMetadata) => {
                if (setupMetadata) {
                    if (setupMetadata.assistantMessage && setupMetadata.assistantMessage.message_id) {
                        assistantMessage.message_id = setupMetadata.assistantMessage.message_id;
                    }
                    if (setupMetadata.userMessage && setupMetadata.userMessage.message_id) {
                        userMessage.message_id = setupMetadata.userMessage.message_id;
                    }
                    if (setupMetadata.systemMessage) {
                        systemMessage.message_id = setupMetadata.systemMessage.message_id;
                        systemMessage.content = setupMetadata.systemMessage.content || '';
                        systemMessage.copilotDetails = setupMetadata.copilot_details;
                        systemMessage.documents = setupMetadata.rag_docs;
                        systemMessage.timestamp = setupMetadata.systemMessage.timestamp || new Date().toISOString();
                    } else if (setupMetadata.copilot_details) {
                        assistantMessage.copilotDetails = setupMetadata.copilot_details;
                    }
                    this.displayWidget.showMessages(this.chatStore.query());
                }
            }
        );
      },

      //================================================================
      // SESSION MANAGEMENT METHODS
      //================================================================

      /**
       * Resets widget state for new chat session
       * Clears textarea and sets new chat flag
       */
      startNewChat: function() {
        this.new_chat = true;
        this.textArea.set('value', '');
      },

      /**
       * Updates the current session identifier
       * @param {string} sessionId - New session ID
       */
      setSessionId: function(sessionId) {
        this.sessionId = sessionId;
      },

      /**
       * Finalizes creation of a brand-new chat after the first successful response.
       * Adds the session to the global sessions memory store, publishes reload event,
       * then triggers title generation.
       * @param {boolean} generateTitleImmediately – if false, skip title generation (default true)
       */
      _finishNewChat: function(generateTitleImmediately = true) {
        this.new_chat = false;

        // Add to global sessions store
        if (window && window.App && window.App.chatSessionsStore) {
          window.App.chatSessionsStore.addSession({
            session_id: this.sessionId,
            title: 'New Chat',
            created_at: Date.now()
          });
        }

        // Reload scroll bar and highlight
        topic.publish('reloadUserSessions', { highlightSessionId: this.sessionId });

        if (generateTitleImmediately) {
          setTimeout(function() {
            topic.publish('generateSessionTitle');
          }, 100);
        }
      },

      //================================================================
      // CONFIGURATION METHODS (SETTERS/GETTERS)
      //================================================================

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

      /**
       * Sets state-specific prompt context
       */
      setStatePrompt: function(statePrompt) {
        this.statePrompt = statePrompt;
      },

      //================================================================
      // UTILITY METHODS
      //================================================================

      /**
       * Updates the toggle button's visual state based on pageContentEnabled
       */
      _updateToggleButtonStyle: function() {
        var buttonNode = this.pageContentToggle.domNode;
        if (this.pageContentEnabled) {
            buttonNode.classList.remove('pageContentToggleInactive');
            buttonNode.classList.add('pageContentToggleActive');
        } else {
            buttonNode.classList.remove('pageContentToggleActive');
            buttonNode.classList.add('pageContentToggleInactive');
        }
      },

      /**
       * Creates a new blank ChatAttachment and adds it to the container
       * Limited to maximum of 3 attachments
       */
      _addBlankAttachment: function() {
        // Check if we've reached the limit of 3 attachments
        if (this.attachments.length >= 3) {
          console.log('Maximum of 3 attachments allowed');
          return;
        }

        var blankAttachment = new ChatAttachment({
          icon: '📎',
          label: 'New Attachment',
          data: {
            id: 'attachment_' + Date.now(),
            type: 'blank',
            created: new Date().toISOString()
          },
          container: this.attachmentContainer,
          onRemove: lang.hitch(this, this._onAttachmentRemoved) // Add removal callback
        });

        // Store the attachment
        this.attachments.push(blankAttachment);

        console.log('Added blank attachment:', blankAttachment.data);
        console.log('Total attachments:', this.attachments.length);
      },

      /**
       * Handles removal of an attachment from the attachments array
       * @param {Object} attachment - The attachment being removed
       */
      _onAttachmentRemoved: function(attachment) {
          this.removeAttachment(attachment);
      },

      //================================================================
      // ATTACHMENT MANAGEMENT METHODS
      //================================================================

      /**
       * Removes an attachment from the attachments array and updates UI
       * @param {Object} attachment - The attachment to remove
       * @returns {boolean} True if attachment was removed, false otherwise
       */
      removeAttachment: function(attachment) {
          if (!attachment) {
              console.warn('Cannot remove attachment: attachment is null or undefined');
              return false;
          }

          var index = this.attachments.indexOf(attachment);
          if (index === -1) {
              console.warn('Cannot remove attachment: attachment not found in array');
              return false;
          }

          // Remove from array
          this.attachments.splice(index, 1);

          // Destroy the attachment widget
          if (attachment.destroy && typeof attachment.destroy === 'function') {
              attachment.destroy();
          }

          console.log('Attachment removed. Total attachments:', this.attachments.length);

          // Update attachment preview if it exists
          this._updateAttachmentPreview();

          return true;
      },

      /**
       * Removes an attachment by its ID
       * @param {string} attachmentId - The ID of the attachment to remove
       * @returns {boolean} True if attachment was removed, false otherwise
       */
      removeAttachmentById: function(attachmentId) {
          if (!attachmentId) {
              console.warn('Cannot remove attachment: attachmentId is null or undefined');
              return false;
          }

          var attachment = this.getAttachmentById(attachmentId);
          if (!attachment) {
              console.warn('Cannot remove attachment: attachment with ID "' + attachmentId + '" not found');
              return false;
          }

          return this.removeAttachment(attachment);
      },

      /**
       * Removes an attachment by its index in the attachments array
       * @param {number} index - The index of the attachment to remove
       * @returns {boolean} True if attachment was removed, false otherwise
       */
      removeAttachmentByIndex: function(index) {
          if (typeof index !== 'number' || index < 0 || index >= this.attachments.length) {
              console.warn('Cannot remove attachment: invalid index ' + index);
              return false;
          }

          var attachment = this.attachments[index];
          return this.removeAttachment(attachment);
      },

      /**
       * Removes all attachments from the attachments array
       * @returns {number} Number of attachments removed
       */
      removeAllAttachments: function() {
          var count = this.attachments.length;

          // Create a copy of the array to avoid issues with modifying while iterating
          var attachmentsToRemove = this.attachments.slice();

          attachmentsToRemove.forEach(lang.hitch(this, function(attachment) {
              this.removeAttachment(attachment);
          }));

          console.log('Removed all attachments. Count:', count);
          return count;
      },

      /**
       * Updates an existing attachment with new data
       * @param {Object} attachment - The attachment to update
       * @param {Object} newData - New data to set on the attachment
       * @returns {boolean} True if attachment was updated, false otherwise
       */
      updateAttachment: function(attachment, newData) {
          if (!attachment) {
              console.warn('Cannot update attachment: attachment is null or undefined');
              return false;
          }

          if (!newData) {
              console.warn('Cannot update attachment: newData is null or undefined');
              return false;
          }

          var index = this.attachments.indexOf(attachment);
          if (index === -1) {
              console.warn('Cannot update attachment: attachment not found in array');
              return false;
          }

          // Update the attachment's data
          if (attachment.setData && typeof attachment.setData === 'function') {
              attachment.setData(newData);
          } else if (attachment.setAttachment && typeof attachment.setAttachment === 'function') {
              attachment.setAttachment(newData);
          } else {
              // Fallback: directly set the data property
              attachment.data = newData;
          }

          console.log('Attachment updated:', attachment);

          // Update attachment preview if it exists
          this._updateAttachmentPreview();

          return true;
      },

      /**
       * Updates an attachment by its ID with new data
       * @param {string} attachmentId - The ID of the attachment to update
       * @param {Object} newData - New data to set on the attachment
       * @returns {boolean} True if attachment was updated, false otherwise
       */
      updateAttachmentById: function(attachmentId, newData) {
          if (!attachmentId) {
              console.warn('Cannot update attachment: attachmentId is null or undefined');
              return false;
          }

          var attachment = this.getAttachmentById(attachmentId);
          if (!attachment) {
              console.warn('Cannot update attachment: attachment with ID "' + attachmentId + '" not found');
              return false;
          }

          return this.updateAttachment(attachment, newData);
      },

      /**
       * Gets an attachment by its ID
       * @param {string} attachmentId - The ID of the attachment to find
       * @returns {Object|null} The attachment if found, null otherwise
       */
      getAttachmentById: function(attachmentId) {
          if (!attachmentId) {
              return null;
          }

          for (var i = 0; i < this.attachments.length; i++) {
              var attachment = this.attachments[i];
              if (attachment && attachment.data && attachment.data.id === attachmentId) {
                  return attachment;
              }
          }

          return null;
      },

      /**
       * Gets an attachment by its index in the attachments array
       * @param {number} index - The index of the attachment to get
       * @returns {Object|null} The attachment if found, null otherwise
       */
      getAttachmentByIndex: function(index) {
          if (typeof index !== 'number' || index < 0 || index >= this.attachments.length) {
              return null;
          }

          return this.attachments[index];
      },

      /**
       * Gets all attachments of a specific type
       * @param {string} type - The type of attachments to find
       * @returns {Array} Array of attachments matching the type
       */
      getAttachmentsByType: function(type) {
          if (!type) {
              return [];
          }

          return this.attachments.filter(function(attachment) {
              return attachment && attachment.data && attachment.data.type === type;
          });
      },

      /**
       * Checks if an attachment exists in the attachments array
       * @param {Object} attachment - The attachment to check for
       * @returns {boolean} True if attachment exists, false otherwise
       */
      hasAttachment: function(attachment) {
          return this.attachments.indexOf(attachment) !== -1;
      },

      /**
       * Checks if an attachment with the given ID exists
       * @param {string} attachmentId - The ID to check for
       * @returns {boolean} True if attachment with ID exists, false otherwise
       */
      hasAttachmentWithId: function(attachmentId) {
          return this.getAttachmentById(attachmentId) !== null;
      },

      /**
       * Gets the total number of attachments
       * @returns {number} Number of attachments
       */
      getAttachmentCount: function() {
          return this.attachments.length;
      },

      /**
       * Gets the number of valid (non-blank) attachments
       * @returns {number} Number of valid attachments
       */
      getValidAttachmentCount: function() {
          return this.attachments.filter(function(attachment) {
              return attachment && attachment.data && attachment.data.type !== 'blank';
          }).length;
      },

      /**
       * Replaces an existing attachment with a new one
       * @param {Object} oldAttachment - The attachment to replace
       * @param {Object} newAttachment - The new attachment
       * @returns {boolean} True if replacement was successful, false otherwise
       */
      replaceAttachment: function(oldAttachment, newAttachment) {
          if (!oldAttachment || !newAttachment) {
              console.warn('Cannot replace attachment: oldAttachment or newAttachment is null/undefined');
              return false;
          }

          var index = this.attachments.indexOf(oldAttachment);
          if (index === -1) {
              console.warn('Cannot replace attachment: oldAttachment not found in array');
              return false;
          }

          // Remove the old attachment
          if (oldAttachment.destroy && typeof oldAttachment.destroy === 'function') {
              oldAttachment.destroy();
          }

          // Replace with new attachment
          this.attachments[index] = newAttachment;

          // Place the new attachment in the container
          if (newAttachment.placeAt && typeof newAttachment.placeAt === 'function') {
              newAttachment.placeAt(this.attachmentContainer);
          }

          console.log('Attachment replaced at index', index);

          // Update attachment preview if it exists
          this._updateAttachmentPreview();

          return true;
      },

      /**
       * Clears all attachments and resets the attachment container
       * @returns {number} Number of attachments cleared
       */
      clearAttachments: function() {
          var count = this.removeAllAttachments();

          // Clear the attachment container
          if (this.attachmentContainer) {
              this.attachmentContainer.innerHTML = '';

              // Re-add the "Add Attach" button
              if (this.addContextButton) {
                  this.addContextButton.placeAt(this.attachmentContainer);
              }
          }

          console.log('Cleared all attachments. Count:', count);
          return count;
      },

      /**
       * Collects attachment prompts from all active attachments
       * @returns {string} Combined attachment prompt text or empty string
       */
      _getAttachmentsPrompt: function() {
          if (!this.attachments || this.attachments.length === 0) {
              return '';
          }

          // Check if we have any valid attachments with prompts
          var hasValidPrompts = false;
          this.attachments.forEach(function(attachment) {
              if (attachment && typeof attachment.getAttachmentPrompt === 'function') {
                  var prompt = attachment.getAttachmentPrompt();
                  if (prompt && prompt.trim() !== '') {
                      hasValidPrompts = true;
                  }
              }
          });

          if (!hasValidPrompts) {
              return '';
          }

          // Format the attachment prompts
          var promptText = '\\n\\nAttached Context:\\n';
          this.attachments.forEach(lang.hitch(this, function(attachment, index) {
              if (attachment && typeof attachment.getAttachmentPrompt === 'function') {
                  var prompt = attachment.getAttachmentPrompt();
                  if (prompt && prompt.trim() !== '') {
                      var attachmentType = attachment.getAttachmentType() || 'Unknown';
                      promptText += `${attachmentType}: ${prompt}\\n`;
                  }
              }
          }));

          return promptText;
      },

      /**
       * Validates that all attachments are properly configured before submission
       * @returns {boolean} True if all attachments are valid, false otherwise
       */
      _validateAttachments: function() {
          return this.validateAllAttachments().isValid;
      },

      /**
       * Comprehensive validation of all attachments with detailed results
       * @returns {Object} Validation result with isValid, errors, and warnings
       */
      validateAllAttachments: function() {
          var result = {
              isValid: true,
              errors: [],
              warnings: [],
              validCount: 0,
              totalCount: this.attachments.length
          };

          if (this.attachments.length === 0) {
              return result; // Empty is valid
          }

          this.attachments.forEach(lang.hitch(this, function(attachment, index) {
              var attachmentValidation = this.validateAttachment(attachment, index);

              if (!attachmentValidation.isValid) {
                  result.isValid = false;
                  result.errors = result.errors.concat(attachmentValidation.errors);
              }

              if (attachmentValidation.warnings.length > 0) {
                  result.warnings = result.warnings.concat(attachmentValidation.warnings);
              }

              if (attachmentValidation.isValid && attachment.data && attachment.data.type !== 'blank') {
                  result.validCount++;
              }
          }));

          return result;
      },

      /**
       * Validates a single attachment
       * @param {Object} attachment - The attachment to validate
       * @param {number} index - The index of the attachment (for error reporting)
       * @returns {Object} Validation result with isValid, errors, and warnings
       */
      validateAttachment: function(attachment, index) {
          var result = {
              isValid: true,
              errors: [],
              warnings: []
          };

          // Check if attachment exists
          if (!attachment) {
              result.isValid = false;
              result.errors.push('Attachment at index ' + index + ' is null or undefined');
              return result;
          }

          // Check if attachment has data
          if (!attachment.data) {
              result.isValid = false;
              result.errors.push('Attachment at index ' + index + ' has no data');
              return result;
          }

          // Check if attachment has required properties
          if (!attachment.data.id) {
              result.warnings.push('Attachment at index ' + index + ' has no ID');
          }

          if (!attachment.data.type) {
              result.isValid = false;
              result.errors.push('Attachment at index ' + index + ' has no type');
              return result;
          }

          // Check if attachment is blank (which is valid but not useful)
          if (attachment.data.type === 'blank') {
              result.warnings.push('Attachment at index ' + index + ' is blank and will not provide context');
          }

          // Validate attachment instance if it exists
          if (attachment.attachmentInstance) {
              var instanceValidation = this._validateAttachmentInstance(attachment.attachmentInstance, index);
              if (!instanceValidation.isValid) {
                  result.isValid = false;
                  result.errors = result.errors.concat(instanceValidation.errors);
              }
              if (instanceValidation.warnings.length > 0) {
                  result.warnings = result.warnings.concat(instanceValidation.warnings);
              }
          }

          return result;
      },

      /**
       * Validates an attachment instance (specialized attachment)
       * @param {Object} instance - The attachment instance to validate
       * @param {number} index - The index of the attachment (for error reporting)
       * @returns {Object} Validation result with isValid, errors, and warnings
       */
      _validateAttachmentInstance: function(instance, index) {
          var result = {
              isValid: true,
              errors: [],
              warnings: []
          };

          if (!instance) {
              result.warnings.push('Attachment at index ' + index + ' has no specialized instance');
              return result;
          }

          // Check if instance has required methods
          if (typeof instance.getAttachmentPrompt !== 'function') {
              result.warnings.push('Attachment at index ' + index + ' instance has no getAttachmentPrompt method');
          }

          // Validate instance data
          if (instance.data) {
              if (!instance.data.id) {
                  result.warnings.push('Attachment at index ' + index + ' instance has no ID');
              }
          }

          return result;
      },

      /**
       * Validates attachment operations before performing them
       * @param {string} operation - The operation being performed ('add', 'remove', 'update', 'replace')
       * @param {Object} params - Parameters for the operation
       * @returns {Object} Validation result with isValid and errors
       */
      validateAttachmentOperation: function(operation, params) {
          var result = {
              isValid: true,
              errors: []
          };

          switch (operation) {
              case 'add':
                  if (this.attachments.length >= 3) {
                      result.isValid = false;
                      result.errors.push('Maximum of 3 attachments allowed');
                  }
                  if (!params || !params.attachment) {
                      result.isValid = false;
                      result.errors.push('Attachment parameter is required for add operation');
                  }
                  break;

              case 'remove':
                  if (!params || (!params.attachment && !params.attachmentId && typeof params.index !== 'number')) {
                      result.isValid = false;
                      result.errors.push('Attachment, attachmentId, or index parameter is required for remove operation');
                  }
                  break;

              case 'update':
                  if (!params || !params.attachment || !params.newData) {
                      result.isValid = false;
                      result.errors.push('Attachment and newData parameters are required for update operation');
                  }
                  break;

              case 'replace':
                  if (!params || !params.oldAttachment || !params.newAttachment) {
                      result.isValid = false;
                      result.errors.push('oldAttachment and newAttachment parameters are required for replace operation');
                  }
                  break;

              default:
                  result.isValid = false;
                  result.errors.push('Unknown operation: ' + operation);
          }

          return result;
      },

      /**
       * Updates a preview element showing what attachment context will be sent
       */
      _updateAttachmentPreview: function() {
          var previewElement = document.getElementById('attachment-preview');
          if (previewElement) {
              var prompt = this._getAttachmentsPrompt();
              previewElement.textContent = prompt || 'No attachment context';
          }
      },

      //================================================================
      // ATTACHMENT STATE MANAGEMENT & SYNCHRONIZATION
      //================================================================

      /**
       * Gets the current state of all attachments as a serializable object
       * @returns {Object} Attachment state object
       */
      getAttachmentState: function() {
          var state = {
              attachments: [],
              timestamp: new Date().toISOString(),
              version: '1.0'
          };

          this.attachments.forEach(lang.hitch(this, function(attachment, index) {
              var attachmentState = this._getAttachmentState(attachment, index);
              if (attachmentState) {
                  state.attachments.push(attachmentState);
              }
          }));

          return state;
      },

      /**
       * Gets the state of a single attachment
       * @param {Object} attachment - The attachment to get state for
       * @param {number} index - The index of the attachment
       * @returns {Object|null} Attachment state object or null if invalid
       */
      _getAttachmentState: function(attachment, index) {
          if (!attachment || !attachment.data) {
              return null;
          }

          var state = {
              index: index,
              id: attachment.data.id,
              type: attachment.data.type,
              label: attachment.label,
              icon: attachment.icon,
              data: lang.clone(attachment.data),
              selectedContext: attachment.selectedContext ? {
                  name: attachment.selectedContext.name,
                  icon: attachment.selectedContext.icon
              } : null
          };

          // Include attachment instance state if available
          if (attachment.attachmentInstance && attachment.attachmentInstance.getState) {
              state.instanceState = attachment.attachmentInstance.getState();
          }

          return state;
      },

      /**
       * Restores attachment state from a serialized state object
       * @param {Object} state - The attachment state to restore
       * @returns {boolean} True if restoration was successful, false otherwise
       */
      restoreAttachmentState: function(state) {
          if (!state || !state.attachments || !Array.isArray(state.attachments)) {
              console.warn('Invalid attachment state provided for restoration');
              return false;
          }

          // Clear existing attachments
          this.clearAttachments();

          var success = true;
          state.attachments.forEach(lang.hitch(this, function(attachmentState) {
              if (!this._restoreAttachmentFromState(attachmentState)) {
                  success = false;
              }
          }));

          console.log('Attachment state restored. Success:', success);
          return success;
      },

      /**
       * Restores a single attachment from state
       * @param {Object} attachmentState - The attachment state to restore
       * @returns {boolean} True if restoration was successful, false otherwise
       */
      _restoreAttachmentFromState: function(attachmentState) {
          if (!attachmentState || !attachmentState.id || !attachmentState.type) {
              console.warn('Invalid attachment state for restoration:', attachmentState);
              return false;
          }

          try {
              // Create new attachment with restored data
              var attachment = new ChatAttachment({
                  icon: attachmentState.icon || '📎',
                  label: attachmentState.label || 'Restored Attachment',
                  data: lang.clone(attachmentState.data),
                  container: this.attachmentContainer,
                  onRemove: lang.hitch(this, this._onAttachmentRemoved)
              });

              // Restore selected context if available
              if (attachmentState.selectedContext) {
                  attachment.setContext(attachmentState.selectedContext.name);
              }

              // Restore instance state if available
              if (attachmentState.instanceState && attachment.attachmentInstance && attachment.attachmentInstance.setState) {
                  attachment.attachmentInstance.setState(attachmentState.instanceState);
              }

              // Add to attachments array
              this.attachments.push(attachment);

              return true;
          } catch (error) {
              console.error('Error restoring attachment from state:', error);
              return false;
          }
      },

      /**
       * Synchronizes attachment state with external systems
       * @param {Object} options - Synchronization options
       * @returns {Promise} Promise that resolves when synchronization is complete
       */
      synchronizeAttachments: function(options) {
          options = options || {};

          return new Promise(lang.hitch(this, function(resolve, reject) {
              try {
                  // Validate current state
                  var validation = this.validateAllAttachments();
                  if (!validation.isValid) {
                      reject(new Error('Cannot synchronize: invalid attachment state - ' + validation.errors.join(', ')));
                      return;
                  }

                  // Get current state
                  var currentState = this.getAttachmentState();

                  // Perform synchronization based on options
                  if (options.saveToStorage) {
                      this._saveAttachmentsToStorage(currentState);
                  }

                  if (options.notifyParent) {
                      this._notifyParentOfAttachmentChange('synchronize', currentState);
                  }

                  console.log('Attachment synchronization completed');
                  resolve(currentState);
              } catch (error) {
                  console.error('Error during attachment synchronization:', error);
                  reject(error);
              }
          }));
      },

      /**
       * Saves attachment state to browser storage
       * @param {Object} state - The attachment state to save
       */
      _saveAttachmentsToStorage: function(state) {
          try {
              var storageKey = 'copilot_attachments_' + (this.sessionId || 'default');
              localStorage.setItem(storageKey, JSON.stringify(state));
              console.log('Attachment state saved to storage');
          } catch (error) {
              console.error('Error saving attachment state to storage:', error);
          }
      },

      /**
       * Loads attachment state from browser storage
       * @returns {Object|null} The loaded attachment state or null if not found
       */
      _loadAttachmentsFromStorage: function() {
          try {
              var storageKey = 'copilot_attachments_' + (this.sessionId || 'default');
              var stored = localStorage.getItem(storageKey);
              return stored ? JSON.parse(stored) : null;
          } catch (error) {
              console.error('Error loading attachment state from storage:', error);
              return null;
          }
      },

      /**
       * Notifies parent components of attachment changes
       * @param {string} action - The action that was performed
       * @param {Object} data - Additional data about the change
       */
      _notifyParentOfAttachmentChange: function(action, data) {
          var eventData = {
              action: action,
              attachmentCount: this.attachments.length,
              validAttachmentCount: this.getValidAttachmentCount(),
              timestamp: new Date().toISOString(),
              data: data
          };

          // Publish topic for other components to listen to
          topic.publish('attachmentStateChanged', eventData);

          console.log('Notified parent of attachment change:', action);
      },

      /**
       * Adds an attachment with validation and state management
       * @param {Object} attachment - The attachment to add
       * @returns {boolean} True if attachment was added successfully, false otherwise
       */
      addAttachmentWithValidation: function(attachment) {
          // Validate operation
          var operationValidation = this.validateAttachmentOperation('add', { attachment: attachment });
          if (!operationValidation.isValid) {
              console.error('Cannot add attachment:', operationValidation.errors.join(', '));
              return false;
          }

          // Validate attachment itself
          var attachmentValidation = this.validateAttachment(attachment, this.attachments.length);
          if (!attachmentValidation.isValid) {
              console.error('Cannot add attachment:', attachmentValidation.errors.join(', '));
              return false;
          }

          // Add the attachment
          this.attachments.push(attachment);

          // Notify parent of change
          this._notifyParentOfAttachmentChange('add', { attachment: attachment });

          console.log('Attachment added with validation. Total attachments:', this.attachments.length);
          return true;
      },

      /**
       * Removes an attachment with validation and state management
       * @param {Object} attachment - The attachment to remove
       * @returns {boolean} True if attachment was removed successfully, false otherwise
       */
      removeAttachmentWithValidation: function(attachment) {
          // Validate operation
          var operationValidation = this.validateAttachmentOperation('remove', { attachment: attachment });
          if (!operationValidation.isValid) {
              console.error('Cannot remove attachment:', operationValidation.errors.join(', '));
              return false;
          }

          // Remove the attachment
          var success = this.removeAttachment(attachment);

          if (success) {
              // Notify parent of change
              this._notifyParentOfAttachmentChange('remove', { attachment: attachment });
          }

          return success;
      },

      //================================================================
      // ADDITIONAL UTILITY METHODS
      //================================================================

      /**
       * Gets a summary of all attachments for debugging/logging
       * @returns {Object} Summary object with attachment information
       */
      getAttachmentSummary: function() {
          var summary = {
              totalCount: this.attachments.length,
              validCount: this.getValidAttachmentCount(),
              blankCount: this.getAttachmentsByType('blank').length,
              attachments: []
          };

          this.attachments.forEach(lang.hitch(this, function(attachment, index) {
              summary.attachments.push({
                  index: index,
                  id: attachment.data ? attachment.data.id : 'unknown',
                  type: attachment.data ? attachment.data.type : 'unknown',
                  label: attachment.label || 'unknown',
                  hasInstance: !!attachment.attachmentInstance,
                  isValid: attachment.data && attachment.data.type !== 'blank'
              });
          }));

          return summary;
      },

      /**
       * Checks if attachments are ready for submission
       * @returns {Object} Ready status with details
       */
      areAttachmentsReadyForSubmission: function() {
          var validation = this.validateAllAttachments();
          var summary = this.getAttachmentSummary();

          return {
              ready: validation.isValid && summary.validCount > 0,
              hasAttachments: summary.totalCount > 0,
              hasValidAttachments: summary.validCount > 0,
              validation: validation,
              summary: summary
          };
      },

      /**
       * Gets all attachment prompts as an array with type information
       * @returns {Array} Array of attachment prompt objects with type and content
       */
      getAllAttachmentPrompts: function() {
          var prompts = [];

          this.attachments.forEach(function(attachment, index) {
              if (attachment && typeof attachment.getAttachmentPrompt === 'function') {
                  var prompt = attachment.getAttachmentPrompt();
                  if (prompt && prompt.trim() !== '') {
                      var attachmentType = attachment.getAttachmentType() || 'Unknown';
                      prompts.push({
                          index: index,
                          type: attachmentType,
                          content: prompt,
                          formatted: `Attachment ${index + 1} (${attachmentType}): ${prompt}`
                      });
                  }
              }
          });

          return prompts;
      },

      /**
       * Duplicates an existing attachment
       * @param {Object} attachment - The attachment to duplicate
       * @returns {Object|null} The duplicated attachment or null if failed
       */
      duplicateAttachment: function(attachment) {
          if (!attachment || !attachment.data) {
              console.warn('Cannot duplicate attachment: invalid attachment');
              return null;
          }

          if (this.attachments.length >= 3) {
              console.warn('Cannot duplicate attachment: maximum of 3 attachments allowed');
              return null;
          }

          try {
              // Create new attachment with duplicated data
              var duplicatedData = lang.clone(attachment.data);
              duplicatedData.id = 'attachment_' + Date.now();
              duplicatedData.created = new Date().toISOString();

              var duplicatedAttachment = new ChatAttachment({
                  icon: attachment.icon,
                  label: attachment.label + ' (Copy)',
                  data: duplicatedData,
                  container: this.attachmentContainer,
                  onRemove: lang.hitch(this, this._onAttachmentRemoved)
              });

              // Copy selected context if available
              if (attachment.selectedContext) {
                  duplicatedAttachment.setContext(attachment.selectedContext.name);
              }

              // Add to attachments array
              this.attachments.push(duplicatedAttachment);

              console.log('Attachment duplicated:', duplicatedAttachment.data.id);
              return duplicatedAttachment;
          } catch (error) {
              console.error('Error duplicating attachment:', error);
              return null;
          }
      },

      /**
       * Moves an attachment to a different position in the array
       * @param {Object} attachment - The attachment to move
       * @param {number} newIndex - The new index position
       * @returns {boolean} True if move was successful, false otherwise
       */
      moveAttachment: function(attachment, newIndex) {
          if (!attachment) {
              console.warn('Cannot move attachment: attachment is null or undefined');
              return false;
          }

          var currentIndex = this.attachments.indexOf(attachment);
          if (currentIndex === -1) {
              console.warn('Cannot move attachment: attachment not found in array');
              return false;
          }

          if (typeof newIndex !== 'number' || newIndex < 0 || newIndex >= this.attachments.length) {
              console.warn('Cannot move attachment: invalid new index ' + newIndex);
              return false;
          }

          if (currentIndex === newIndex) {
              console.log('Attachment is already at the specified position');
              return true;
          }

          // Remove from current position
          this.attachments.splice(currentIndex, 1);

          // Insert at new position
          this.attachments.splice(newIndex, 0, attachment);

          console.log('Attachment moved from index', currentIndex, 'to index', newIndex);

          // Update attachment preview if it exists
          this._updateAttachmentPreview();

          return true;
      }
    });
  });
/**
 * ClarificationChips — Renders clickable option chips for planning agent
 * clarification questions. Each question shows selectable options as
 * styled chips, plus a free-text input field.
 *
 * After the user submits answers, the chips are replaced with a text
 * summary ("Q: ... A: ...") that persists in the chat.
 */
define([
  'dojo/_base/declare',
  'dojo/_base/lang',
  'dijit/_WidgetBase',
  'dijit/_TemplatedMixin',
  'dojo/dom-construct',
  'dojo/dom-class',
  'dojo/on',
  'dojo/topic'
], function (
  declare, lang, _WidgetBase, _TemplatedMixin,
  domConstruct, domClass, on, topic
) {
  return declare([_WidgetBase], {

    questions: null,       // Array of {id, question, options, required}
    copilotApi: null,      // CopilotApi instance
    sessionId: null,
    originalQuery: null,   // The user's original query that triggered clarification
    containerNode: null,

    // Internal state
    _selectedAnswers: null, // Map of question_id -> selected option text
    _chipNodes: null,       // Map of question_id -> array of chip DOM nodes
    _textInputs: null,      // Map of question_id -> text input node
    _submitted: false,

    constructor: function (params) {
      this.questions = params.questions || [];
      this.copilotApi = params.copilotApi || null;
      this.sessionId = params.sessionId || null;
      this.originalQuery = params.originalQuery || '';
      this._selectedAnswers = {};
      this._chipNodes = {};
      this._textInputs = {};
    },

    buildRendering: function () {
      this.domNode = domConstruct.create('div', {
        'class': 'clarification-container'
      });
      this._renderQuestions();
    },

    _renderQuestions: function () {
      var self = this;

      // Header
      domConstruct.create('div', {
        'class': 'clarification-header',
        innerHTML: 'Before I create a plan, I have a few questions:'
      }, this.domNode);

      // Render each question
      this.questions.forEach(function (q) {
        var qBlock = domConstruct.create('div', {
          'class': 'clarification-question-block'
        }, self.domNode);

        // Question text
        domConstruct.create('div', {
          'class': 'clarification-question-text',
          innerHTML: q.question
        }, qBlock);

        // Option chips
        var chipsRow = domConstruct.create('div', {
          'class': 'clarification-chips-row'
        }, qBlock);

        self._chipNodes[q.id] = [];

        q.options.forEach(function (option) {
          var chip = domConstruct.create('button', {
            'class': 'clarification-chip',
            innerHTML: option,
            tabindex: '0'
          }, chipsRow);

          on(chip, 'click', function () {
            self._selectOption(q.id, option, chip);
          });

          self._chipNodes[q.id].push(chip);
        });

        // Free text input
        var textInput = domConstruct.create('input', {
          'class': 'clarification-text-input',
          type: 'text',
          placeholder: 'Or type your own answer...'
        }, qBlock);

        on(textInput, 'input', function () {
          if (textInput.value.trim()) {
            // Deselect all chips for this question
            self._deselectAllChips(q.id);
            self._selectedAnswers[q.id] = textInput.value.trim();
          }
        });

        self._textInputs[q.id] = textInput;
      });

      // Submit button
      var buttonRow = domConstruct.create('div', {
        'class': 'clarification-button-row'
      }, this.domNode);

      var submitBtn = domConstruct.create('button', {
        'class': 'clarification-submit-btn',
        innerHTML: 'Submit Answers'
      }, buttonRow);

      on(submitBtn, 'click', function () {
        self._submitAnswers();
      });
    },

    _selectOption: function (questionId, option, chipNode) {
      // Deselect all chips for this question first
      this._deselectAllChips(questionId);

      // Select this chip
      domClass.add(chipNode, 'clarification-chip-selected');
      this._selectedAnswers[questionId] = option;

      // Clear free text input for this question
      if (this._textInputs[questionId]) {
        this._textInputs[questionId].value = '';
      }
    },

    _deselectAllChips: function (questionId) {
      if (this._chipNodes[questionId]) {
        this._chipNodes[questionId].forEach(function (chip) {
          domClass.remove(chip, 'clarification-chip-selected');
        });
      }
    },

    _submitAnswers: function () {
      if (this._submitted) return;

      var self = this;
      var answers = [];
      var allAnswered = true;

      this.questions.forEach(function (q) {
        var answer = self._selectedAnswers[q.id] || '';
        if (!answer && q.required) {
          allAnswered = false;
        }
        if (answer) {
          answers.push({
            question: q.question,
            answer: answer
          });
        }
      });

      if (!allAnswered) {
        // Highlight unanswered required questions
        this.questions.forEach(function (q) {
          if (q.required && !self._selectedAnswers[q.id]) {
            var blocks = self.domNode.querySelectorAll('.clarification-question-block');
            // Simple visual feedback
            if (blocks.length > 0) {
              // Flash the unanswered question
            }
          }
        });
        return;
      }

      this._submitted = true;

       // Replace chips with text summary
      this._replaceWithSummary(answers);

      // Remove the now-answered ask_questions message from the chat UI.
      // The persisted record is the user_clarification message we add below.
      topic.publish('CopilotPlanClarificationAnswered', {
        sessionId: this.sessionId
      });

      // Publish event for the API to handle
      topic.publish('CopilotPlanAnswerQuestions', {
        answers: answers,
        originalQuery: this.originalQuery,
        sessionId: this.sessionId
      });
    },

    _replaceWithSummary: function (answers) {
      // Clear the chips UI
      this.domNode.innerHTML = '';

      var summaryDiv = domConstruct.create('div', {
        'class': 'clarification-summary'
      }, this.domNode);

      answers.forEach(function (a) {
        var line = domConstruct.create('div', {
          'class': 'clarification-summary-line'
        }, summaryDiv);

        domConstruct.create('span', {
          'class': 'clarification-summary-q',
          innerHTML: 'Q: ' + a.question
        }, line);

        domConstruct.create('span', {
          'class': 'clarification-summary-a',
          innerHTML: ' A: ' + a.answer
        }, line);
      });
    },

    destroy: function () {
      this.inherited(arguments);
    }
  });
});

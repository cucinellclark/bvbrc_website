define([
    'dojo/_base/declare',
    'dijit/_WidgetBase',
    'dijit/_TemplatedMixin',
    'dojo/dom-construct',
    'dijit/form/CheckBox',
    'dijit/form/TextBox',
    'dijit/form/Button',
    'dojo/request',
    'dojo/_base/lang',
    'markdown-it/dist/markdown-it.min',
    'dojo/text!../templates/Demo.html'
  ], function (
    declare,
    _WidgetBase,
    _TemplatedMixin,
    domConstruct,
    CheckBox,
    TextBox,
    Button,
    request,
    lang,
    markdownIt,
    Template
  ) {
    return declare([_WidgetBase, _TemplatedMixin], {
      baseClass: 'twoPartDisplay',
      templateString: Template,

      postCreate: function() {
        this.inherited(arguments);

        // Create top div with input and button
        var topDiv = domConstruct.create('div', {
          class: 'topSection',
          style: 'display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 50%;'
        }, this.domNode);

        var inputContainer = domConstruct.create('div', {
          style: 'display: flex; justify-content: center; align-items: center; padding-bottom: 50px; width: 30%'
        }, topDiv);

        // Add checkbox container before the input wrapper
        var checkboxContainer = domConstruct.create('div', {
          style: 'display: flex; align-items: center; margin-bottom: 10px;'
        }, inputContainer);

        // Create checkbox and label using standard HTML elements
        var _self = this;
        this.ragCheckbox = domConstruct.create('input', {
          type: 'checkbox',
          id: 'ragCheckbox',
          style: 'width: 15px; height: 15px; margin-right: 5px;'
        }, checkboxContainer);

        domConstruct.create('label', {
          for: 'ragCheckbox',
          innerHTML: 'RAG',
          style: 'margin-left: 5px;'
        }, checkboxContainer);

        var input_wrapper = domConstruct.create('div', {
          style: 'display: flex; justify-content: center; align-items: center;padding: 10px;width: 100%;'
        }, inputContainer);

        this.textInput = new TextBox({
          style: 'margin-right: 10px;width: 100%;'
        }).placeAt(input_wrapper);

        new Button({
          label: 'Submit',
          onClick: this.onSubmit.bind(this)
        }).placeAt(input_wrapper);

        // Create bottom div for displaying text
        this.bottomDiv = domConstruct.create('div', {
            class: 'bottomSection',
            style: 'display: flex; justify-content: flex-start; align-items: flex-start; background-color: #f5f5f5; height: 50%; padding: 20px;'
        }, this.domNode);

        // Configure markdown-it options with breaks enabled
        this.md = markdownIt({
          breaks: true,  // Enable line breaks
          linkify: true  // Autoconvert URLs to links
        });

        // Add markdown styles
        this.addMarkdownStyles();
      },

      onSubmit: function() {
        // Function to be filled in later
        this.displayText('Submit button clicked, loading...');
        var value = this.textInput.get('value');
        if (!value) {
          this.displayText('Please enter a value');
          return;
        }

        var rag_flag = this.ragCheckbox.checked;
        var url = 'https://dev-3.bv-brc.org/copilot-api/chatbrc/olek-demo/';
        request.post(url, {
          headers: {
            'accept': 'application/json',
            'Content-Type': 'application/json',
            Authorization: (window.App.authorizationToken || '')
          },
          handleAs: 'json',
          data: JSON.stringify({
            text: value,
            rag_flag: rag_flag
          })
        }).then(lang.hitch(this, function(res) {
          if (res && res.content) {
            this.displayText(JSON.stringify(res.content, null, 2));
          } else {
            this.displayText('Invalid response');
          }
        }), lang.hitch(this, function(err) {
          console.error('Error fetching data:', err);
          this.displayText('Error fetching data');
        }));
      },

      displayText: function(text) {
        // Replace literal \n with actual newlines before rendering
        text = text.replace(/\\n/g, '\n');
        this.bottomDiv.innerHTML = this.md.render(text);
      },

      addMarkdownStyles: function() {
        if (!document.getElementById('markdown-styles')) {
          var style = domConstruct.create('style', {
            id: 'markdown-styles',
            innerHTML: `
              .message {
                max-width: 100%;
                overflow-wrap: break-word;
              }
              .message * {
                max-width: 100%;
              }
              .message img {
                height: auto;
              }
              .message pre {
                background-color: #f8f8f8;
                padding: 10px;
                border-radius: 4px;
                overflow-x: auto;
                white-space: pre-wrap;
                word-wrap: break-word;
              }
              .message code {
                background-color: #f8f8f8;
                padding: 2px 4px;
                border-radius: 3px;
                word-wrap: break-word;
              }
              .message table {
                width: 100%;
                display: block;
                overflow-x: auto;
              }
              .message p {
                margin: 0 0 10px 0;
              }
              .message p:last-child {
                margin-bottom: 0;
              }
            `
          }, document.head);
          var style2 = domConstruct.create('style', {
            id: 'loading-animation',
            innerHTML: `
              @keyframes bounce {
                0%, 100% { transform: translateY(0); }
                50% { transform: translateY(-10px); }
              }
            `
          }, document.head);
        }
      },
    });
  });
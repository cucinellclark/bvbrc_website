define([
  'dojo/_base/declare', 'dojo/_base/lang',
  'dojo/on', 'dojo/dom-construct', 'dojo/dom-class', 'dojo/request',
  'dijit/layout/BorderContainer', 'dijit/layout/ContentPane',
  'dijit/Dialog',
  './Base',
  '../copilot/CopilotApi'
], function (
  declare, lang,
  on, domConstruct, domClass, request,
  BorderContainer, ContentPane,
  Dialog,
  ViewerBase,
  CopilotApi
) {

  var DATA_TYPES = {
    none: {
      label: 'None',
      columns: null
    },
    ppi: {
      label: 'Protein-Protein Interaction (PPI)',
      columns: ['Pathogen', 'Protein A', 'Protein B', 'Interaction Type', 'Method', 'Assertion', 'Reference']
    },
    protein_function: {
      label: 'Protein Function',
      columns: ['Organism', 'Gene Name', 'Function', 'Assertion', 'Reference']
    },
    mutation: {
      label: 'Mutation',
      columns: ['Organism', 'Gene Name', 'Mutation', 'Phenotype', 'Assertion', 'Reference']
    }
  };

  var MODEL_NAME_MAP = {
    'Llama-4-Scout-17B-16E-Instruct-quantized.w4a16': 'Llama-4-Scout',
    'Llama-3.3-70B-Instruct': 'Llama-3.3-70B'
  };

  return declare([ViewerBase], {
    baseClass: 'Literature',
    disabled: false,
    topK: 10,
    useGraph: false,
    results: null,
    loading: false,
    generatedAnswer: null,
    generatingAnswer: false,

    copilotApi: null,
    modelList: null,
    selectedModel: null,

    postCreate: function () {
      this.inherited(arguments);
      this._initCopilotApi();
      this._buildUI();
    },

    startup: function () {
      if (this._started) { return; }
      this.inherited(arguments);
    },

    _initCopilotApi: function () {
      var userId = (window.App && window.App.user) ? window.App.user.l_id : null;
      this.copilotApi = new CopilotApi({ user_id: userId });
      this._loadModelList();
    },

    _loadModelList: function () {
      if (!this.copilotApi || !this.copilotApi.copilotAvailable) {
        console.warn('[Literature] Copilot service unavailable, model list not loaded');
        return;
      }
      var self = this;
      this.copilotApi.getModelList().then(function (response) {
        var raw = response.model_list || response.models;
        self.modelList = self._parseListPayload(raw);
        self._populateModelSelect();
      }).catch(function (err) {
        console.error('[Literature] Failed to load model list:', err);
      });
    },

    _parseListPayload: function (value) {
      if (Array.isArray(value)) { return value; }
      if (typeof value === 'string') {
        try {
          var parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [];
        } catch (e) { return []; }
      }
      return [];
    },

    _getModelDisplayName: function (modelObj) {
      var fullName = modelObj.model || modelObj.name || modelObj;
      var shortName = String(fullName).split('/').pop();
      return MODEL_NAME_MAP[shortName] || shortName;
    },

    _populateModelSelect: function () {
      if (!this.modelSelect || !this.modelList) { return; }

      while (this.modelSelect.options.length > 0) {
        this.modelSelect.remove(0);
      }

      for (var i = 0; i < this.modelList.length; i++) {
        var m = this.modelList[i];
        var opt = domConstruct.create('option', {
          value: m.model || m.name || m,
          innerHTML: this._escapeHtml(this._getModelDisplayName(m))
        });
        this.modelSelect.appendChild(opt);
      }

      if (this.modelList.length > 0) {
        this.selectedModel = this.modelList[0].model || this.modelList[0].name || this.modelList[0];
      }
    },

    _buildUI: function () {
      this.searchPanel = new ContentPane({
        region: 'top',
        style: 'padding: 20px; background: #f8f9fa; border-bottom: 1px solid #dee2e6;',
        splitter: false
      });

      this.resultsPanel = new ContentPane({
        region: 'center',
        style: 'padding: 20px; overflow-y: auto;'
      });

      this.addChild(this.searchPanel);
      this.addChild(this.resultsPanel);

      this._buildSearchForm();
      this._buildResultsContainer();
    },

    _buildSearchForm: function () {
      var self = this;
      var container = domConstruct.create('div', { className: 'litSearchForm' }, this.searchPanel.containerNode);

      domConstruct.create('h2', {
        innerHTML: 'Literature Search',
        className: 'litSearchTitle'
      }, container);

      // Row 1: Organism + Genes
      var row1 = domConstruct.create('div', { className: 'litFormRow' }, container);

      var orgGroup = domConstruct.create('div', { className: 'litFormGroup litFormGroupFlex1' }, row1);
      domConstruct.create('label', { innerHTML: 'Organism of Interest', htmlFor: 'litOrganismInput' }, orgGroup);
      this.organismInput = domConstruct.create('input', {
        type: 'text',
        id: 'litOrganismInput',
        className: 'litInput',
        placeholder: 'e.g., SARS-CoV-2, Mycobacterium tuberculosis'
      }, orgGroup);

      var genesGroup = domConstruct.create('div', { className: 'litFormGroup litFormGroupFlex1' }, row1);
      domConstruct.create('label', { innerHTML: 'Genes of Interest', htmlFor: 'litGenesInput' }, genesGroup);
      this.genesInput = domConstruct.create('input', {
        type: 'text',
        id: 'litGenesInput',
        className: 'litInput',
        placeholder: 'e.g., Spike, NSP13, ACE2 (comma-separated)'
      }, genesGroup);

      // Row 1b: Other Terms
      var row1b = domConstruct.create('div', { className: 'litFormRow' }, container);

      var otherGroup = domConstruct.create('div', { className: 'litFormGroup litFormGroupFlex1' }, row1b);
      domConstruct.create('label', { innerHTML: 'Other Terms', htmlFor: 'litOtherTermsInput' }, otherGroup);
      this.otherTermsInput = domConstruct.create('input', {
        type: 'text',
        id: 'litOtherTermsInput',
        className: 'litInput',
        placeholder: 'e.g., antibiotic resistance, viral entry, host interaction'
      }, otherGroup);

      on(this.otherTermsInput, 'keypress', function (evt) {
        if (evt.keyCode === 13) { self._doSearch(); }
      });

      // Row 2: Data Type + Format + Model
      var row2 = domConstruct.create('div', { className: 'litFormRow' }, container);

      var dataTypeGroup = domConstruct.create('div', { className: 'litFormGroup litFormGroupFixed' }, row2);
      domConstruct.create('label', { innerHTML: 'Data Type', htmlFor: 'litDataTypeSelect' }, dataTypeGroup);
      this.dataTypeSelect = domConstruct.create('select', {
        id: 'litDataTypeSelect',
        className: 'litSelect'
      }, dataTypeGroup);

      var dtKeys = Object.keys(DATA_TYPES);
      for (var i = 0; i < dtKeys.length; i++) {
        domConstruct.create('option', {
          value: dtKeys[i],
          innerHTML: DATA_TYPES[dtKeys[i]].label
        }, this.dataTypeSelect);
      }

      var formatGroup = domConstruct.create('div', { className: 'litFormGroup litFormGroupFixed' }, row2);
      domConstruct.create('label', { innerHTML: 'Format', htmlFor: 'litFormatSelect' }, formatGroup);
      this.formatSelect = domConstruct.create('select', {
        id: 'litFormatSelect',
        className: 'litSelect'
      }, formatGroup);
      domConstruct.create('option', { value: 'raw', innerHTML: 'Raw Text' }, this.formatSelect);
      domConstruct.create('option', { value: 'table', innerHTML: 'Table' }, this.formatSelect);

      on(this.dataTypeSelect, 'change', lang.hitch(this, '_onDataTypeChange'));
      this._onDataTypeChange();

      var modelGroup = domConstruct.create('div', { className: 'litFormGroup litFormGroupFixed' }, row2);
      domConstruct.create('label', { innerHTML: 'Model', htmlFor: 'litModelSelect' }, modelGroup);
      this.modelSelect = domConstruct.create('select', {
        id: 'litModelSelect',
        className: 'litSelect'
      }, modelGroup);
      domConstruct.create('option', { value: '', innerHTML: 'Loading models...' }, this.modelSelect);

      on(this.modelSelect, 'change', function () {
        self.selectedModel = this.value;
      });

      // Row 3: Controls (topK, graph toggle, search button)
      var row3 = domConstruct.create('div', { className: 'litFormRow litControlsRow' }, container);

      var topKGroup = domConstruct.create('div', { className: 'litFormGroup litFormGroupTopK' }, row3);
      domConstruct.create('label', { innerHTML: 'RAG Results', htmlFor: 'litTopKInput' }, topKGroup);
      var topKWrapper = domConstruct.create('div', { className: 'litTopKWrapper' }, topKGroup);
      this.topKInput = domConstruct.create('input', {
        type: 'range',
        id: 'litTopKInput',
        className: 'litRange',
        min: '1',
        max: '25',
        value: '10'
      }, topKWrapper);
      this.topKLabel = domConstruct.create('span', {
        className: 'litTopKValue',
        innerHTML: '10'
      }, topKWrapper);

      var graphGroup = domConstruct.create('div', { className: 'litFormGroup litFormGroupGraph' }, row3);
      domConstruct.create('label', { innerHTML: 'Knowledge Graph', htmlFor: 'litGraphToggle' }, graphGroup);
      var toggleWrapper = domConstruct.create('label', { className: 'litToggle' }, graphGroup);
      this.graphToggle = domConstruct.create('input', {
        type: 'checkbox',
        id: 'litGraphToggle'
      }, toggleWrapper);
      domConstruct.create('span', { className: 'litToggleSlider' }, toggleWrapper);

      var btnGroup = domConstruct.create('div', { className: 'litFormGroup litFormGroupBtn litBtnRow' }, row3);
      this.searchBtn = domConstruct.create('button', {
        innerHTML: '<i class="icon-search"></i> Search &amp; Generate',
        className: 'litSearchBtn',
        type: 'button'
      }, btnGroup);

      this.editPromptBtn = domConstruct.create('button', {
        innerHTML: '<i class="icon-pencil"></i> View / Edit Prompt',
        className: 'litEditPromptBtn',
        type: 'button',
        disabled: true
      }, btnGroup);

      on(this.topKInput, 'input', function () {
        self.topKLabel.innerHTML = this.value;
      });

      on(this.searchBtn, 'click', lang.hitch(this, '_doSearch'));
      on(this.editPromptBtn, 'click', lang.hitch(this, '_showPromptDialog'));

      on(this.organismInput, 'keypress', function (evt) {
        if (evt.keyCode === 13) { self._doSearch(); }
      });
      on(this.genesInput, 'keypress', function (evt) {
        if (evt.keyCode === 13) { self._doSearch(); }
      });
    },

    _onDataTypeChange: function () {
      var dt = this.dataTypeSelect.value;
      var hasColumns = DATA_TYPES[dt] && DATA_TYPES[dt].columns;
      if (!hasColumns) {
        this.formatSelect.value = 'raw';
        this.formatSelect.disabled = true;
      } else {
        this.formatSelect.disabled = false;
      }
    },

    _buildResultsContainer: function () {
      var wrapper = domConstruct.create('div', {
        className: 'litResultsWrapper'
      }, this.resultsPanel.containerNode);

      this.answerContainer = domConstruct.create('div', {
        className: 'litAnswerContainer'
      }, wrapper);

      this.resultsContainer = domConstruct.create('div', {
        className: 'litResultsContainer'
      }, wrapper);

      this.statusMessage = domConstruct.create('div', {
        className: 'litStatusMessage',
        innerHTML: 'Enter organism and gene details to search literature and generate an answer.'
      }, this.resultsContainer);
    },

    _buildQueryFromFields: function () {
      var organism = this.organismInput.value.trim();
      var genes = this.genesInput.value.trim();
      var otherTerms = this.otherTermsInput.value.trim();
      var dataType = this.dataTypeSelect.value;
      var dtConfig = DATA_TYPES[dataType];
      var dtLabel = (dtConfig && dtConfig.columns) ? dtConfig.label : '';

      var parts = [];
      if (organism) { parts.push(organism); }
      if (genes) { parts.push(genes); }
      if (dtLabel) { parts.push(dtLabel); }
      if (otherTerms) { parts.push(otherTerms); }

      return parts.join(' ');
    },

    _doSearch: function () {
      var organism = this.organismInput.value.trim();
      if (!organism) {
        this.organismInput.focus();
        return;
      }

      var query = this._buildQueryFromFields();
      var topK = parseInt(this.topKInput.value, 10);
      var useGraph = this.graphToggle.checked;

      this._setLoading(true);
      this._clearResults();
      this._clearAnswer();

      var apiUrl = this._getApiUrl();
      if (!apiUrl) {
        this._showError('Literature search service is not configured.');
        this._setLoading(false);
        return;
      }

      var headers = {
        'Content-Type': 'application/json',
        'X-Requested-With': null
      };
      if (window.App && window.App.authorizationToken) {
        headers['Authorization'] = window.App.authorizationToken;
      }

      var self = this;
      request.post(apiUrl, {
        data: JSON.stringify({
          query: query,
          top_k: topK,
          use_graph: useGraph
        }),
        headers: headers,
        handleAs: 'json'
      }).then(
        function (response) {
          self._setLoading(false);
          self._renderResults(response, query);
          self._generateAnswer(response, query);
        },
        function (err) {
          self._setLoading(false);
          var status = err.response ? err.response.status : 'no response';
          var errText = err.response && err.response.text ? err.response.text : '';
          console.error('[LiteratureSearch] Request failed:', status, err.message || err);
          var msg = 'An error occurred while searching.';
          if (err.response && err.response.status === 401) {
            msg = 'Authentication required. Please log in to use Literature Search.';
          } else if (err.response && err.response.status === 0) {
            msg = 'Unable to connect to the literature search service.';
          } else if (err.response && err.response.status >= 400) {
            msg = 'Search failed (HTTP ' + err.response.status + '). ' + (errText || '');
          }
          self._showError(msg);
        }
      );
    },

    _generateAnswer: function (ragResponse, query) {
      var sources = ragResponse && ragResponse.sources;
      if (!sources || sources.length === 0) { return; }

      var model = this.selectedModel;
      if (!model) {
        this._showAnswerError('No model selected. Please select a model to generate an answer.');
        return;
      }

      if (!this.copilotApi || !this.copilotApi.copilotAvailable) {
        this._showAnswerError('Copilot service is unavailable. Cannot generate answer.');
        return;
      }

      var organism = this.organismInput.value.trim();
      var genes = this.genesInput.value.trim();
      var otherTerms = this.otherTermsInput.value.trim();
      var dataType = this.dataTypeSelect.value;
      var format = this.formatSelect.value;
      var dtConfig = DATA_TYPES[dataType];

      var prompt = this._buildPrompt(organism, genes, otherTerms, dtConfig, format, sources);

      this._lastFormat = format;
      this._lastDtConfig = dtConfig;

      this._lastPrompt = prompt;
      this.editPromptBtn.disabled = false;
      this._submitPrompt(prompt, format, dtConfig);
    },

    _submitPrompt: function (prompt, format, dtConfig) {
      var model = this.selectedModel;
      if (!model) {
        this._showAnswerError('No model selected.');
        return;
      }

      this._setAnswerLoading(true);
      if (this._regenerateBtn) { this._regenerateBtn.disabled = true; }

      var self = this;
      this.copilotApi.submitQueryChatOnly(prompt, null, model).then(
        function (response) {
          self._setAnswerLoading(false);
          if (self._regenerateBtn) { self._regenerateBtn.disabled = false; }
          var text = response.response || response.content || response.answer || '';
          if (typeof text === 'object') { text = JSON.stringify(text, null, 2); }
          self._renderAnswer(text, format, dtConfig);
        },
        function (err) {
          self._setAnswerLoading(false);
          if (self._regenerateBtn) { self._regenerateBtn.disabled = false; }
          console.error('[Literature] LLM query failed:', err);
          self._showAnswerError('Failed to generate answer: ' + (err.message || 'Unknown error'));
        }
      );
    },

    _showPromptDialog: function () {
      var self = this;
      var prompt = this._lastPrompt || '';

      if (this._promptDialog) {
        this._promptDialog.destroyRecursive();
        this._promptDialog = null;
      }

      var content = domConstruct.create('div', {
        style: 'width: 750px; max-width: 85vw;'
      });

      var textarea = domConstruct.create('textarea', {
        value: prompt,
        spellcheck: false,
        style: 'width: 100%; height: 400px; padding: 12px; border: 1px solid #ccc; border-radius: 4px;' +
          ' font-family: Menlo, Consolas, Monaco, monospace; font-size: 12px; line-height: 1.5;' +
          ' color: #333; background: #fafafa; resize: none; overflow-y: auto; box-sizing: border-box;'
      }, content);

      var btnRow = domConstruct.create('div', {
        style: 'display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px;'
      }, content);

      var regenerateBtn = domConstruct.create('button', {
        className: 'litRegenerateBtn',
        innerHTML: '<i class="icon-refresh"></i> Regenerate',
        type: 'button'
      }, btnRow);

      var cancelBtn = domConstruct.create('button', {
        className: 'litPromptCancelBtn',
        innerHTML: 'Close',
        type: 'button'
      }, btnRow);

      this._promptDialog = new Dialog({
        title: 'View / Edit Prompt',
        content: content
      });

      on(regenerateBtn, 'click', function () {
        var editedPrompt = textarea.value;
        if (!editedPrompt.trim()) { return; }
        self._lastPrompt = editedPrompt;
        self._promptDialog.hide();
        self._submitPrompt(editedPrompt, self._lastFormat, self._lastDtConfig);
      });

      on(cancelBtn, 'click', function () {
        self._lastPrompt = textarea.value;
        self._promptDialog.hide();
      });

      this._promptDialog.show();
    },

    _buildPrompt: function (organism, genes, otherTerms, dtConfig, format, sources) {
      var contextChunks = [];
      for (var i = 0; i < sources.length; i++) {
        var s = sources[i];
        var meta = s.metadata || {};
        var chunk = 'Source ' + (i + 1);
        if (meta.title) { chunk += ' (' + meta.title + ')'; }
        if (meta.doi) { chunk += ' [DOI: ' + meta.doi + ']'; }
        chunk += ':\n' + (s.content || '');
        contextChunks.push(chunk);
      }

      var context = contextChunks.join('\n\n---\n\n');
      var hasDataType = dtConfig && dtConfig.columns;
      var subjectDesc = hasDataType ? dtConfig.label : 'relevant findings';

      var instructions;
      if (format === 'table' && hasDataType) {
        instructions =
          'Based on the literature context below, extract structured data about ' + dtConfig.label +
          ' for organism "' + organism + '"' +
          (genes ? ' involving genes/proteins: ' + genes : '') +
          (otherTerms ? ', related to: ' + otherTerms : '') + '.\n\n' +
          'Return ONLY a TSV (tab-separated values) table with these columns:\n' +
          dtConfig.columns.join('\t') + '\n\n' +
          'Rules:\n' +
          '- Output the header row first, then data rows.\n' +
          '- Use tab characters to separate columns.\n' +
          '- If a value is unknown, use "N/A".\n' +
          '- Include the reference (author, year, DOI if available) for each row.\n' +
          '- Do NOT include any explanatory text before or after the table.\n' +
          '- Extract as many relevant entries as the literature supports.';
      } else {
        instructions =
          'Based on the literature context below, provide a comprehensive answer about ' + subjectDesc +
          ' for organism "' + organism + '"' +
          (genes ? ' involving genes/proteins: ' + genes : '') +
          (otherTerms ? ', related to: ' + otherTerms : '') + '.\n\n' +
          'Summarize the key findings, citing the source references where appropriate. ' +
          'Organize by gene/protein if multiple are discussed.';
      }

      return instructions + '\n\n--- LITERATURE CONTEXT ---\n\n' + context;
    },

    _getApiUrl: function () {
      if (window.App && window.App.copilotApiURL) {
        var base = window.App.copilotApiURL.replace(/\/[^/]*$/, '');
        return base + '/rag/retrieve';
      }
      return null;
    },

    _setLoading: function (loading) {
      this.loading = loading;
      if (loading) {
        domClass.add(this.searchBtn, 'litLoading');
        this.searchBtn.disabled = true;
        this.statusMessage.innerHTML = '<div class="litSpinner"></div> Searching literature...';
        this.statusMessage.style.display = '';
      } else {
        domClass.remove(this.searchBtn, 'litLoading');
        this.searchBtn.disabled = false;
      }
    },

    _clearResults: function () {
      var cards = this.resultsContainer.querySelectorAll('.litResultCard');
      for (var i = 0; i < cards.length; i++) {
        domConstruct.destroy(cards[i]);
      }
      this.statusMessage.style.display = '';
    },

    _clearAnswer: function () {
      this.answerContainer.innerHTML = '';
      this._lastPrompt = null;
      this.editPromptBtn.disabled = true;
      if (this._promptDialog) {
        this._promptDialog.destroyRecursive();
        this._promptDialog = null;
      }
    },

    _setAnswerLoading: function (loading) {
      this.generatingAnswer = loading;
      if (loading) {
        this.answerContainer.innerHTML =
          '<div class="litAnswerCard">' +
            '<div class="litAnswerHeader">' +
              '<span class="litAnswerIcon"><i class="icon-lightbulb"></i></span>' +
              '<h3 class="litAnswerTitle">Generated Answer</h3>' +
            '</div>' +
            '<div class="litAnswerBody">' +
              '<div class="litSpinner"></div> Generating answer from literature...' +
            '</div>' +
          '</div>';
      }
    },

    _showAnswerError: function (msg) {
      this.answerContainer.innerHTML =
        '<div class="litAnswerCard litAnswerError">' +
          '<div class="litAnswerHeader">' +
            '<span class="litAnswerIcon"><i class="icon-warning"></i></span>' +
            '<h3 class="litAnswerTitle">Generated Answer</h3>' +
          '</div>' +
          '<div class="litAnswerBody">' +
            '<span class="litError">' + this._escapeHtml(msg) + '</span>' +
          '</div>' +
        '</div>';
    },

    _renderAnswer: function (text, format, dtConfig) {
      var card = domConstruct.create('div', { className: 'litAnswerCard' });

      var header = domConstruct.create('div', { className: 'litAnswerHeader' }, card);
      domConstruct.create('span', {
        className: 'litAnswerIcon',
        innerHTML: '<i class="icon-lightbulb"></i>'
      }, header);
      domConstruct.create('h3', {
        className: 'litAnswerTitle',
        innerHTML: 'Generated Answer'
      }, header);

      var modelName = this.selectedModel ? this._getModelDisplayName({ model: this.selectedModel }) : 'Unknown';
      domConstruct.create('span', {
        className: 'litAnswerModel',
        innerHTML: modelName
      }, header);

      var body = domConstruct.create('div', { className: 'litAnswerBody' }, card);

      if (format === 'table' && dtConfig && dtConfig.columns) {
        var parsed = this._parseTSV(text, dtConfig);
        if (parsed && parsed.rows.length > 0) {
          this._renderTable(parsed, body);
        } else {
          domConstruct.create('p', {
            className: 'litContentText',
            innerHTML: this._escapeHtml(text)
          }, body);
        }
      } else {
        domConstruct.create('div', {
          className: 'litAnswerText',
          innerHTML: this._formatMarkdown(text)
        }, body);
      }

      this.answerContainer.innerHTML = '';
      this.answerContainer.appendChild(card);
    },

    _parseTSV: function (text, dtConfig) {
      var cleaned = text.replace(/```[a-z]*\n?/g, '').replace(/```/g, '').trim();
      var lines = cleaned.split('\n').filter(function (l) {
        var trimmed = l.trim();
        return trimmed.length > 0 && !/^[-|=\s]+$/.test(trimmed);
      });

      if (lines.length < 2) { return null; }

      var delimiter = '\t';
      if (lines[0].indexOf('\t') === -1 && lines[0].indexOf('|') !== -1) {
        delimiter = '|';
      }

      var parseRow = function (line) {
        var cells = line.split(delimiter).map(function (c) { return c.trim(); });
        if (delimiter === '|') {
          cells = cells.filter(function (c) { return c !== ''; });
        }
        return cells;
      };

      var headerRow = parseRow(lines[0]);
      var rows = [];
      for (var i = 1; i < lines.length; i++) {
        var row = parseRow(lines[i]);
        if (row.length > 0 && row.some(function (c) { return c !== ''; })) {
          rows.push(row);
        }
      }

      return { headers: headerRow, rows: rows, expectedColumns: dtConfig.columns };
    },

    _renderTable: function (parsed, container) {
      var table = domConstruct.create('table', { className: 'litTable' }, container);
      var thead = domConstruct.create('thead', {}, table);
      var headerTr = domConstruct.create('tr', {}, thead);

      var cols = parsed.headers.length > 0 ? parsed.headers : parsed.expectedColumns;
      for (var h = 0; h < cols.length; h++) {
        domConstruct.create('th', { innerHTML: this._escapeHtml(cols[h]) }, headerTr);
      }

      var tbody = domConstruct.create('tbody', {}, table);
      for (var r = 0; r < parsed.rows.length; r++) {
        var tr = domConstruct.create('tr', {}, tbody);
        for (var c = 0; c < cols.length; c++) {
          var cellVal = (parsed.rows[r][c] !== undefined) ? parsed.rows[r][c] : '';
          domConstruct.create('td', { innerHTML: this._escapeHtml(cellVal) }, tr);
        }
      }
    },

    _formatMarkdown: function (text) {
      if (!text) return '';
      var escaped = this._escapeHtml(text);
      escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      escaped = escaped.replace(/\n/g, '<br>');
      return escaped;
    },

    _showError: function (msg) {
      this.statusMessage.innerHTML = '<span class="litError">' + msg + '</span>';
      this.statusMessage.style.display = '';
    },

    _renderResults: function (response, query) {
      var sources = response && response.sources;
      if (!sources || sources.length === 0) {
        this.statusMessage.innerHTML = 'No results found for "<strong>' + this._escapeHtml(query) + '</strong>".';
        return;
      }

      this.statusMessage.innerHTML = 'Found <strong>' + sources.length + '</strong> source' + (sources.length !== 1 ? 's' : '') + ' for "<strong>' + this._escapeHtml(query) + '</strong>"';

      for (var i = 0; i < sources.length; i++) {
        this._renderCard(sources[i], i + 1);
      }
    },

    _renderCard: function (source, rank) {
      var meta = source.metadata || {};
      var card = domConstruct.create('div', { className: 'litResultCard' }, this.resultsContainer);

      var header = domConstruct.create('div', { className: 'litCardHeader' }, card);

      domConstruct.create('span', {
        className: 'litCardRank',
        innerHTML: '#' + rank
      }, header);

      var scoreClass = 'litScoreMed';
      if (source.score >= 8) { scoreClass = 'litScoreHigh'; }
      else if (source.score < 5) { scoreClass = 'litScoreLow'; }

      domConstruct.create('span', {
        className: 'litCardScore ' + scoreClass,
        innerHTML: 'Score: ' + source.score.toFixed(2)
      }, header);

      var title = meta.title || meta.filename || 'Untitled Document';
      var titleEl = domConstruct.create('h3', { className: 'litCardTitle' }, card);
      if (meta.doi) {
        domConstruct.create('a', {
          href: 'https://doi.org/' + meta.doi,
          target: '_blank',
          rel: 'noopener noreferrer',
          innerHTML: this._escapeHtml(title)
        }, titleEl);
      } else {
        titleEl.innerHTML = this._escapeHtml(title);
      }

      var metaRow = domConstruct.create('div', { className: 'litCardMeta' }, card);
      if (meta.year) {
        domConstruct.create('span', {
          className: 'litMetaTag',
          innerHTML: '<i class="icon-calendar"></i> ' + meta.year
        }, metaRow);
      }
      if (meta.doc_type) {
        domConstruct.create('span', {
          className: 'litMetaTag',
          innerHTML: '<i class="icon-file-text2"></i> ' + meta.doc_type
        }, metaRow);
      }
      if (meta.n_citations != null) {
        domConstruct.create('span', {
          className: 'litMetaTag',
          innerHTML: '<i class="icon-quotes-left"></i> ' + meta.n_citations + ' citation' + (meta.n_citations !== 1 ? 's' : '')
        }, metaRow);
      }
      if (meta.doi) {
        domConstruct.create('span', {
          className: 'litMetaTag litMetaDoi',
          innerHTML: '<a href="https://doi.org/' + meta.doi + '" target="_blank" rel="noopener noreferrer">DOI: ' + this._escapeHtml(meta.doi) + '</a>'
        }, metaRow);
      }

      var contentText = (source.content || '').replace(/\n/g, ' ').trim();
      var contentDiv = domConstruct.create('div', { className: 'litCardContent' }, card);
      var preview = contentText.length > 400 ? contentText.substring(0, 400) + '...' : contentText;
      var contentP = domConstruct.create('p', {
        className: 'litContentText',
        innerHTML: this._escapeHtml(preview)
      }, contentDiv);

      if (contentText.length > 400) {
        var self = this;
        var expandBtn = domConstruct.create('button', {
          className: 'litExpandBtn',
          innerHTML: 'Show more',
          type: 'button'
        }, contentDiv);

        on(expandBtn, 'click', function () {
          var expanded = domClass.contains(card, 'litExpanded');
          if (expanded) {
            domClass.remove(card, 'litExpanded');
            contentP.innerHTML = self._escapeHtml(preview);
            this.innerHTML = 'Show more';
          } else {
            domClass.add(card, 'litExpanded');
            contentP.innerHTML = self._escapeHtml(contentText);
            this.innerHTML = 'Show less';
          }
        });
      }
    },

    _escapeHtml: function (str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }
  });
});

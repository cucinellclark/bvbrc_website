define([
  'dojo/_base/declare', 'dojo/_base/lang',
  'dojo/on', 'dojo/dom-construct', 'dojo/dom-class', 'dojo/request',
  'dijit/layout/BorderContainer', 'dijit/layout/ContentPane',
  './Base'
], function (
  declare, lang,
  on, domConstruct, domClass, request,
  BorderContainer, ContentPane,
  ViewerBase
) {

  return declare([ViewerBase], {
    baseClass: 'Literature',
    disabled: false,
    query: '',
    topK: 10,
    useGraph: false,
    results: null,
    loading: false,

    postCreate: function () {
      this.inherited(arguments);
      this._buildUI();
    },

    startup: function () {
      if (this._started) { return; }
      this.inherited(arguments);
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

      var formRow = domConstruct.create('div', { className: 'litFormRow' }, container);

      var queryGroup = domConstruct.create('div', { className: 'litFormGroup litFormGroupQuery' }, formRow);
      domConstruct.create('label', { innerHTML: 'Search Query', htmlFor: 'litQueryInput' }, queryGroup);
      this.queryInput = domConstruct.create('input', {
        type: 'text',
        id: 'litQueryInput',
        className: 'litInput',
        placeholder: 'e.g., mechanisms of bacterial antibiotic resistance'
      }, queryGroup);

      var controlsRow = domConstruct.create('div', { className: 'litFormRow litControlsRow' }, container);

      var topKGroup = domConstruct.create('div', { className: 'litFormGroup litFormGroupTopK' }, controlsRow);
      domConstruct.create('label', { innerHTML: 'Results', htmlFor: 'litTopKInput' }, topKGroup);
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

      var graphGroup = domConstruct.create('div', { className: 'litFormGroup litFormGroupGraph' }, controlsRow);
      domConstruct.create('label', { innerHTML: 'Knowledge Graph', htmlFor: 'litGraphToggle' }, graphGroup);
      var toggleWrapper = domConstruct.create('label', { className: 'litToggle' }, graphGroup);
      this.graphToggle = domConstruct.create('input', {
        type: 'checkbox',
        id: 'litGraphToggle'
      }, toggleWrapper);
      domConstruct.create('span', { className: 'litToggleSlider' }, toggleWrapper);

      var btnGroup = domConstruct.create('div', { className: 'litFormGroup litFormGroupBtn' }, controlsRow);
      this.searchBtn = domConstruct.create('button', {
        innerHTML: '<i class="icon-search"></i> Search',
        className: 'litSearchBtn',
        type: 'button'
      }, btnGroup);

      on(this.topKInput, 'input', function () {
        self.topKLabel.innerHTML = this.value;
      });

      on(this.searchBtn, 'click', lang.hitch(this, '_doSearch'));
      on(this.queryInput, 'keypress', function (evt) {
        if (evt.keyCode === 13) { self._doSearch(); }
      });
    },

    _buildResultsContainer: function () {
      this.resultsContainer = domConstruct.create('div', {
        className: 'litResultsContainer'
      }, this.resultsPanel.containerNode);

      this.statusMessage = domConstruct.create('div', {
        className: 'litStatusMessage',
        innerHTML: 'Enter a search query to find relevant literature.'
      }, this.resultsContainer);
    },

    _doSearch: function () {
      var query = this.queryInput.value.trim();
      if (!query) { return; }

      var topK = parseInt(this.topKInput.value, 10);
      var useGraph = this.graphToggle.checked;

      this._setLoading(true);
      this._clearResults();

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
        },
        function (err) {
          self._setLoading(false);
          var msg = 'An error occurred while searching.';
          if (err.response && err.response.status === 401) {
            msg = 'Authentication required. Please log in to use Literature Search.';
          } else if (err.response && err.response.status === 0) {
            msg = 'Unable to connect to the literature search service.';
          }
          self._showError(msg);
        }
      );
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

      this.statusMessage.innerHTML = 'Found <strong>' + sources.length + '</strong> result' + (sources.length !== 1 ? 's' : '') + ' for "<strong>' + this._escapeHtml(query) + '</strong>"';

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

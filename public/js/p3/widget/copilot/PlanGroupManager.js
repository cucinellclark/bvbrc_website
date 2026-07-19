/**
 * PlanGroupManager -- Inline review panel widget for managing genome/feature
 * groups within a plan step.
 *
 * Rendered inside PlanCard when review_type === 'group_management'. Provides:
 *   - A link to view the genome/feature set in the BV-BRC list viewer
 *   - Group name input with validation
 *   - Workspace folder display
 *   - Save Group & Continue / Skip buttons
 *
 * Uses the source data step's query_used (RQL) to build the viewer link
 * and to fetch IDs when creating the group.
 *
 * The widget creates groups directly via WorkspaceManager, then passes the
 * resulting group path back as review_selections for downstream plan steps.
 */
define([
  'dojo/_base/declare',
  'dojo/_base/lang',
  'dojo/_base/Deferred',
  'dijit/_WidgetBase',
  'dojo/dom-construct',
  'dojo/dom-class',
  'dojo/on',
  'dojo/request',
  '../../WorkspaceManager'
], function (
  declare, lang, Deferred, _WidgetBase,
  domConstruct, domClass, on, request, WorkspaceManager
) {

  // Map group_type to the BV-BRC list viewer path
  var VIEWER_PATHS = {
    genome_group: '/view/GenomeList/',
    feature_group: '/view/FeatureList/'
  };

  return declare([_WidgetBase], {

    // --- Constructor parameters ---
    reviewConfig: null,     // { review_type, group_type, group_action, suggested_group_name, id_field, ... }
    sourceData: null,       // { answer, structured_data, status }
    structuredData: null,   // { record_count, collection, query_used }
    onComplete: null,       // function(selections) -- called when user saves group
    onSkip: null,           // function() -- called when user skips

    // --- Internal state ---
    _loading: false,
    _destroyed: false,

    // --- Internal state ---
    _actionMode: 'create',  // 'create' | 'use_existing'

    postCreate: function () {
      this.inherited(arguments);
      domClass.add(this.domNode, 'plan-group-manager');
    },

    startup: function () {
      this.inherited(arguments);
      this._buildUI();
    },

    // ---------------------------------------------------------------
    // UI construction
    // ---------------------------------------------------------------

    _buildUI: function () {
      var rc = this.reviewConfig || {};
      var sd = this.structuredData || {};
      var count = sd.record_count;
      var queryUsed = sd.query_used || '';
      var collection = sd.collection || '';
      var groupType = rc.group_type || 'genome_group';
      var idField = rc.id_field || 'genome_id';
      var itemLabel = groupType === 'feature_group' ? 'features' : 'genomes';

      // Store for use in _onSave
      this._queryUsed = queryUsed;
      this._collection = collection || (groupType === 'feature_group' ? 'genome_feature' : 'genome');
      this._idField = idField;
      this._groupType = groupType;

      // 1. Review prompt
      domConstruct.create('div', {
        'class': 'plan-group-header',
        innerHTML: rc.prompt || 'Manage genome/feature group before continuing.'
      }, this.domNode);

      // 2. Record count badge
      var displayCount = (count !== undefined && count !== null) ? count : 0;
      if (displayCount) {
        domConstruct.create('div', {
          'class': 'plan-group-count-badge',
          innerHTML: displayCount + ' ' + itemLabel + ' available'
        }, this.domNode);
      }

      // 3. View link -- opens the genome/feature list in BV-BRC viewer
      if (queryUsed) {
        var viewerPath = VIEWER_PATHS[groupType] || VIEWER_PATHS.genome_group;
        var viewUrl = 'https://www.bv-brc.org' + viewerPath + '#' + encodeURIComponent(queryUsed);

        var viewLinkDiv = domConstruct.create('div', {
          'class': 'plan-group-view-link-container'
        }, this.domNode);

        var viewLabel = groupType === 'feature_group' ? 'Feature' : 'Genome';
        domConstruct.create('a', {
          'class': 'plan-group-view-link',
          href: viewUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          innerHTML: 'View ' + (displayCount || '') + ' ' + itemLabel + ' in ' + viewLabel + ' List'
        }, viewLinkDiv);

        domConstruct.create('span', {
          'class': 'plan-group-view-link-hint',
          innerHTML: ' (opens in new tab)'
        }, viewLinkDiv);
      }

      // 4. Radio toggle: Create new group / Use existing group
      var actionSection = domConstruct.create('div', {
        'class': 'plan-group-action-section'
      }, this.domNode);

      var toggleDiv = domConstruct.create('div', {
        'class': 'plan-group-action-toggle'
      }, actionSection);

      var createId = 'pgm-create-' + this.id;
      var existingId = 'pgm-existing-' + this.id;

      this._createRadio = domConstruct.create('input', {
        type: 'radio',
        name: 'pgm-action-' + this.id,
        id: createId,
        value: 'create',
        checked: true
      }, toggleDiv);
      domConstruct.create('label', {
        'for': createId,
        innerHTML: 'Create new group'
      }, toggleDiv);

      domConstruct.create('span', { innerHTML: '&nbsp;&nbsp;&nbsp;' }, toggleDiv);

      this._existingRadio = domConstruct.create('input', {
        type: 'radio',
        name: 'pgm-action-' + this.id,
        id: existingId,
        value: 'use_existing'
      }, toggleDiv);
      domConstruct.create('label', {
        'for': existingId,
        innerHTML: 'Use existing group'
      }, toggleDiv);

      on(this._createRadio, 'change', lang.hitch(this, function () {
        if (this._createRadio.checked) {
          this._actionMode = 'create';
          this._showCreateSection();
        }
      }));
      on(this._existingRadio, 'change', lang.hitch(this, function () {
        if (this._existingRadio.checked) {
          this._actionMode = 'use_existing';
          this._showExistingSection();
        }
      }));

      // --- Create new group section ---
      this._createSection = domConstruct.create('div', {
        'class': 'plan-group-create-section'
      }, actionSection);

      domConstruct.create('label', {
        innerHTML: 'Group name:',
        'class': 'plan-group-label'
      }, this._createSection);

      this._groupNameInput = domConstruct.create('input', {
        type: 'text',
        'class': 'plan-group-name-input',
        placeholder: 'Enter group name...',
        value: rc.suggested_group_name || ''
      }, this._createSection);

      this._nameErrorNode = domConstruct.create('div', {
        'class': 'plan-group-error',
        style: 'display:none;'
      }, this._createSection);

      on(this._groupNameInput, 'input', lang.hitch(this, '_validateGroupName'));

      domConstruct.create('label', {
        innerHTML: 'Folder:',
        'class': 'plan-group-label'
      }, this._createSection);

      var defaultPath = WorkspaceManager.getDefaultFolder(groupType);
      this._folderPath = defaultPath;

      domConstruct.create('div', {
        'class': 'plan-group-folder-path',
        innerHTML: defaultPath || '(default folder)'
      }, this._createSection);

      // --- Use existing group section ---
      this._existingSection = domConstruct.create('div', {
        'class': 'plan-group-existing-section',
        style: 'display:none;'
      }, actionSection);

      domConstruct.create('label', {
        innerHTML: 'Select a group:',
        'class': 'plan-group-label'
      }, this._existingSection);

      this._existingSelect = domConstruct.create('select', {
        'class': 'plan-group-existing-select'
      }, this._existingSection);

      domConstruct.create('option', {
        value: '',
        innerHTML: 'Loading groups...'
      }, this._existingSelect);

      // Start loading existing groups in the background
      this._loadExistingGroups();

      // 5. Buttons
      var actionDiv = domConstruct.create('div', {
        'class': 'plan-group-actions'
      }, this.domNode);

      this._saveBtn = domConstruct.create('button', {
        'class': 'plan-card-btn plan-card-btn-primary',
        innerHTML: 'Save Group & Continue'
      }, actionDiv);

      this._skipBtn = domConstruct.create('button', {
        'class': 'plan-card-btn plan-card-btn-secondary',
        innerHTML: 'Skip'
      }, actionDiv);

      this._spinnerNode = domConstruct.create('span', {
        'class': 'plan-group-spinner',
        style: 'display:none;',
        innerHTML: 'Saving...'
      }, actionDiv);

      this._actionErrorNode = domConstruct.create('div', {
        'class': 'plan-group-error',
        style: 'display:none;'
      }, this.domNode);

      on(this._saveBtn, 'click', lang.hitch(this, '_onSave'));
      on(this._skipBtn, 'click', lang.hitch(this, function () {
        if (typeof this.onSkip === 'function') {
          this.onSkip();
        }
      }));
    },

    // ---------------------------------------------------------------
    // Validation
    // ---------------------------------------------------------------

    _validateGroupName: function () {
      var name = this._groupNameInput ? this._groupNameInput.value.trim() : '';
      var invalidChars = /[()/:]/g;
      var match = name.match(invalidChars);

      if (!name) {
        this._showNameError('Group name is required.');
        return false;
      }
      if (match) {
        this._showNameError('Name contains invalid characters: "' + match.join('') + '"');
        return false;
      }

      this._hideNameError();

      // Async check for name collision
      var fullPath = this._folderPath + '/' + name;
      var self = this;
      Deferred.when(
        WorkspaceManager.objectsExist([fullPath]),
        function (result) {
          if (self._destroyed) return;
          if (result && result[fullPath] && result[fullPath].exists) {
            self._showNameError('A group with this name already exists.');
          }
        }
      );

      return true;
    },

    _showNameError: function (msg) {
      if (this._nameErrorNode) {
        this._nameErrorNode.innerHTML = msg;
        this._nameErrorNode.style.display = '';
      }
    },

    _hideNameError: function () {
      if (this._nameErrorNode) {
        this._nameErrorNode.innerHTML = '';
        this._nameErrorNode.style.display = 'none';
      }
    },

    // ---------------------------------------------------------------
    // Save / submit
    // ---------------------------------------------------------------

    _onSave: function () {
      this._hideActionError();

      if (this._actionMode === 'use_existing') {
        this._onUseExisting();
        return;
      }

      // Create new group mode
      var name = this._groupNameInput ? this._groupNameInput.value.trim() : '';

      if (!name) {
        this._showNameError('Group name is required.');
        return;
      }

      var invalidChars = /[()/:]/g;
      if (name.match(invalidChars)) {
        this._showNameError('Name contains invalid characters.');
        return;
      }

      var folderPath = this._folderPath;
      if (!folderPath) {
        this._showActionError('No workspace folder available.');
        return;
      }

      if (!this._queryUsed) {
        this._showActionError('No query available to fetch genomes.');
        return;
      }

      this._setLoading(true);
      this._fetchIdsThenCreateGroup(name, folderPath);
    },

    /**
     * Fetch all IDs matching the original query, then create the group.
     */
    _fetchIdsThenCreateGroup: function (name, folderPath) {
      var self = this;
      var dataApiUrl = window.App.dataAPI || window.App.dataServiceURL;
      if (!dataApiUrl) {
        this._setLoading(false);
        this._showActionError('Data API not available.');
        return;
      }

      var idField = this._idField;
      var collection = this._collection;
      var rqlQuery = this._queryUsed + '&select(' + idField + ')&limit(25000)';

      request.post(dataApiUrl + '/' + collection, {
        data: rqlQuery,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/rqlquery+x-www-form-urlencoded',
          'Authorization': (window.App.authorizationToken || '')
        },
        handleAs: 'json'
      }).then(function (results) {
        if (self._destroyed) return;
        var ids = [];
        if (Array.isArray(results)) {
          results.forEach(function (rec) {
            var id = rec[idField];
            if (id && ids.indexOf(String(id)) === -1) {
              ids.push(String(id));
            }
          });
        }
        if (ids.length === 0) {
          self._setLoading(false);
          self._showActionError('No IDs found from the query. Try a different search.');
          return;
        }
        self._createGroup(name, folderPath, ids);
      }, function (err) {
        if (self._destroyed) return;
        self._setLoading(false);
        var errMsg = (err && err.message) ? err.message : 'Failed to fetch genome IDs.';
        self._showActionError(errMsg);
      });
    },

    _createGroup: function (name, folderPath, ids) {
      var self = this;
      var groupType = this._groupType;
      var idField = this._idField;

      Deferred.when(
        WorkspaceManager.createGroup(name, groupType, folderPath, idField, ids),
        function () {
          if (self._destroyed) return;
          self._setLoading(false);
          self._disableControls();

          if (typeof self.onComplete === 'function') {
            self.onComplete({
              group_name: name,
              group_path: folderPath + '/' + name,
              group_type: groupType,
              group_action: 'create',
              record_count: ids.length,
              id_field: idField
            });
          }
        },
        function (err) {
          if (self._destroyed) return;
          self._setLoading(false);
          var errMsg = (err && err.message) ? err.message : 'Failed to create group.';
          self._showActionError(errMsg);
        }
      );
    },

    // ---------------------------------------------------------------
    // Section visibility
    // ---------------------------------------------------------------

    _showCreateSection: function () {
      if (this._createSection) this._createSection.style.display = '';
      if (this._existingSection) this._existingSection.style.display = 'none';
      if (this._saveBtn) this._saveBtn.innerHTML = 'Save Group & Continue';
    },

    _showExistingSection: function () {
      if (this._createSection) this._createSection.style.display = 'none';
      if (this._existingSection) this._existingSection.style.display = '';
      if (this._saveBtn) this._saveBtn.innerHTML = 'Use Group & Continue';
    },

    // ---------------------------------------------------------------
    // Existing group loading
    // ---------------------------------------------------------------

    _loadExistingGroups: function () {
      var groupType = this._groupType;
      var defaultPath = WorkspaceManager.getDefaultFolder(groupType);
      var self = this;

      if (!defaultPath) {
        this._populateExistingSelect([]);
        return;
      }

      Deferred.when(
        WorkspaceManager.api('Workspace.ls', [{ paths: [defaultPath] }]),
        function (results) {
          if (self._destroyed) return;
          var groups = [];
          if (results && results[0] && results[0][defaultPath]) {
            var items = results[0][defaultPath];
            items.forEach(function (item) {
              var itemType = item[1] || '';
              var itemName = item[0] || '';
              var itemPath = item[2] || (defaultPath + '/' + itemName);
              if (itemType === groupType) {
                groups.push({ name: itemName, path: itemPath });
              }
            });
          }
          self._existingGroupsLoaded = true;
          self._populateExistingSelect(groups);
        },
        function (err) {
          console.warn('[PlanGroupManager] Failed to load existing groups:', err);
          self._existingGroupsLoaded = true;
          self._populateExistingSelect([]);
        }
      );
    },

    _populateExistingSelect: function (groups) {
      if (!this._existingSelect) return;
      this._existingSelect.innerHTML = '';

      if (groups.length === 0) {
        domConstruct.create('option', {
          value: '',
          innerHTML: 'No existing groups found'
        }, this._existingSelect);
        return;
      }

      domConstruct.create('option', {
        value: '',
        innerHTML: '-- Choose a group --'
      }, this._existingSelect);

      this._existingGroupsList = groups;
      groups.forEach(lang.hitch(this, function (g) {
        domConstruct.create('option', {
          value: g.path,
          innerHTML: g.name
        }, this._existingSelect);
      }));
    },

    _onUseExisting: function () {
      var groupPath = this._existingSelect ? this._existingSelect.value : '';
      if (!groupPath) {
        this._showActionError('Please select a group.');
        return;
      }

      var groupName = '';
      if (this._existingGroupsList) {
        this._existingGroupsList.forEach(function (g) {
          if (g.path === groupPath) groupName = g.name;
        });
      }

      this._hideActionError();
      this._disableControls();

      if (typeof this.onComplete === 'function') {
        this.onComplete({
          group_name: groupName,
          group_path: groupPath,
          group_type: this._groupType,
          group_action: 'use_existing',
          record_count: 0,
          id_field: this._idField
        });
      }
    },

    // ---------------------------------------------------------------
    // UI helpers
    // ---------------------------------------------------------------

    _setLoading: function (loading) {
      this._loading = loading;
      if (this._saveBtn) {
        this._saveBtn.disabled = loading;
        this._saveBtn.innerHTML = loading ? 'Saving...' : 'Save Group & Continue';
      }
      if (this._skipBtn) this._skipBtn.disabled = loading;
      if (this._spinnerNode) {
        this._spinnerNode.style.display = loading ? '' : 'none';
      }
    },

    _disableControls: function () {
      if (this._saveBtn) this._saveBtn.disabled = true;
      if (this._skipBtn) this._skipBtn.disabled = true;
      if (this._groupNameInput) this._groupNameInput.disabled = true;
      if (this._existingSelect) this._existingSelect.disabled = true;
      if (this._createRadio) this._createRadio.disabled = true;
      if (this._existingRadio) this._existingRadio.disabled = true;
    },

    _showActionError: function (msg) {
      if (this._actionErrorNode) {
        this._actionErrorNode.innerHTML = msg;
        this._actionErrorNode.style.display = '';
      }
    },

    _hideActionError: function () {
      if (this._actionErrorNode) {
        this._actionErrorNode.innerHTML = '';
        this._actionErrorNode.style.display = 'none';
      }
    },

    destroy: function () {
      this._destroyed = true;
      this.inherited(arguments);
    }
  });
});

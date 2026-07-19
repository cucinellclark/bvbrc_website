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
  '../../WorkspaceManager'
], function (
  declare, lang, Deferred, _WidgetBase,
  domConstruct, domClass, on, WorkspaceManager
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
    structuredData: null,   // { record_ids, record_count, collection }
    onComplete: null,       // function(selections) -- called when user saves group
    onSkip: null,           // function() -- called when user skips

    // --- Internal state ---
    _loading: false,
    _destroyed: false,

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
      var self = this;
      var rc = this.reviewConfig || {};
      var sd = this.structuredData || {};
      var ids = sd.record_ids || [];
      var count = sd.record_count;
      var groupType = rc.group_type || 'genome_group';
      var idField = rc.id_field || 'genome_id';
      var itemLabel = groupType === 'feature_group' ? 'features' : 'genomes';

      // 1. Review prompt
      domConstruct.create('div', {
        'class': 'plan-group-header',
        innerHTML: rc.prompt || 'Manage genome/feature group before continuing.'
      }, this.domNode);

      // 2. Record count badge
      var displayCount = (count !== undefined && count !== null) ? count : ids.length;
      if (displayCount) {
        domConstruct.create('div', {
          'class': 'plan-group-count-badge',
          innerHTML: displayCount + ' ' + itemLabel + ' available'
        }, this.domNode);
      }

      // 3. View link -- opens the genome/feature list in BV-BRC viewer
      if (ids.length > 0) {
        var viewerPath = VIEWER_PATHS[groupType] || VIEWER_PATHS.genome_group;
        var rqlQuery = 'in(' + idField + ',(' + ids.join(',') + '))';
        var viewUrl = 'https://www.bv-brc.org' + viewerPath + '#' + encodeURIComponent(rqlQuery);

        var viewLinkDiv = domConstruct.create('div', {
          'class': 'plan-group-view-link-container'
        }, this.domNode);

        domConstruct.create('a', {
          'class': 'plan-group-view-link',
          href: viewUrl,
          target: '_blank',
          rel: 'noopener noreferrer',
          innerHTML: 'View ' + displayCount + ' ' + itemLabel + ' in ' +
            (groupType === 'feature_group' ? 'Feature' : 'Genome') + ' List'
        }, viewLinkDiv);

        domConstruct.create('span', {
          'class': 'plan-group-view-link-hint',
          innerHTML: ' (opens in new tab)'
        }, viewLinkDiv);
      }

      // 4. Group name input
      var formSection = domConstruct.create('div', {
        'class': 'plan-group-create-section'
      }, this.domNode);

      domConstruct.create('label', {
        innerHTML: 'Group name:',
        'class': 'plan-group-label'
      }, formSection);

      this._groupNameInput = domConstruct.create('input', {
        type: 'text',
        'class': 'plan-group-name-input',
        placeholder: 'Enter group name...',
        value: rc.suggested_group_name || ''
      }, formSection);

      this._nameErrorNode = domConstruct.create('div', {
        'class': 'plan-group-error',
        style: 'display:none;'
      }, formSection);

      on(this._groupNameInput, 'input', lang.hitch(this, '_validateGroupName'));

      // Folder display
      domConstruct.create('label', {
        innerHTML: 'Folder:',
        'class': 'plan-group-label'
      }, formSection);

      var defaultPath = WorkspaceManager.getDefaultFolder(groupType);
      this._folderPath = defaultPath;

      domConstruct.create('div', {
        'class': 'plan-group-folder-path',
        innerHTML: defaultPath || '(default folder)'
      }, formSection);

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
      var rc = this.reviewConfig || {};
      var sd = this.structuredData || {};
      var groupType = rc.group_type || 'genome_group';
      var idField = rc.id_field || 'genome_id';
      var allIds = sd.record_ids || [];

      if (allIds.length === 0) {
        this._showActionError('No items available to save.');
        return;
      }

      var self = this;
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

      this._setLoading(true);
      this._hideActionError();

      Deferred.when(
        WorkspaceManager.createGroup(name, groupType, folderPath, idField, allIds),
        function (result) {
          if (self._destroyed) return;
          self._setLoading(false);
          self._disableControls();

          if (typeof self.onComplete === 'function') {
            self.onComplete({
              group_name: name,
              group_path: folderPath + '/' + name,
              group_type: groupType,
              group_action: 'create',
              selected_ids: allIds,
              record_count: allIds.length,
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

      if (this._saveBtn) {
        this._saveBtn.innerHTML = 'Group Saved';
        domClass.add(this._saveBtn, 'plan-group-btn-success');
      }
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

/**
 * PlanGroupManager -- Inline review panel widget for managing genome/feature
 * groups within a plan step.
 *
 * Rendered inside PlanCard when review_type === 'group_management'. Provides:
 *   - Scrollable item list with checkboxes (genome IDs + resolved names)
 *   - Create new group / Add to existing group toggle
 *   - Group name input with validation
 *   - Workspace folder picker
 *   - Existing group dropdown (fetched from workspace)
 *
 * The widget creates/updates groups directly via WorkspaceManager, then
 * passes the resulting group path back as review_selections for downstream
 * plan steps.
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

  return declare([_WidgetBase], {

    // --- Constructor parameters ---
    reviewConfig: null,     // { review_type, group_type, group_action, suggested_group_name, id_field, ... }
    sourceData: null,       // { answer, structured_data, status }
    structuredData: null,   // { record_ids, record_count, collection }
    onComplete: null,       // function(selections) -- called when user saves group
    onSkip: null,           // function() -- called when user skips

    // --- Internal state ---
    _items: null,           // Array of { id, name, selected }
    _nameMap: null,         // Map of id -> resolved name
    _actionMode: 'create',  // 'create' | 'add_to'
    _existingGroups: null,  // Array of { name, path, count }
    _loading: false,
    _destroyed: false,

    postCreate: function () {
      this.inherited(arguments);
      domClass.add(this.domNode, 'plan-group-manager');

      this._items = [];
      this._nameMap = {};
      this._existingGroups = [];

      // Determine defaults from reviewConfig
      var rc = this.reviewConfig || {};
      this._actionMode = (rc.group_action === 'add_to') ? 'add_to' : 'create';
      if (rc.group_action === 'use_existing') {
        this._actionMode = 'add_to'; // use_existing shows the existing group picker
      }
    },

    startup: function () {
      this.inherited(arguments);
      this._buildInitialUI();
      this._loadItems();
    },

    // ---------------------------------------------------------------
    // UI construction
    // ---------------------------------------------------------------

    _buildInitialUI: function () {
      var self = this;
      var rc = this.reviewConfig || {};
      var sd = this.structuredData || {};

      // 1. Review prompt
      domConstruct.create('div', {
        'class': 'plan-group-header',
        innerHTML: rc.prompt || 'Manage genome/feature group before continuing.'
      }, this.domNode);

      // 2. Record count badge
      var countText = '';
      var count = sd.record_count;
      var groupType = rc.group_type || 'genome_group';
      var itemLabel = groupType === 'feature_group' ? 'features' : 'genomes';
      if (count !== undefined && count !== null) {
        countText = count + ' ' + itemLabel + ' available';
      }
      if (countText) {
        domConstruct.create('div', {
          'class': 'plan-group-count-badge',
          innerHTML: countText
        }, this.domNode);
      }

      // 3. Select all / deselect all bar
      this._selectBarNode = domConstruct.create('div', {
        'class': 'plan-group-select-all'
      }, this.domNode);

      this._selectAllCheckbox = domConstruct.create('input', {
        type: 'checkbox',
        checked: true,
        id: 'pgm-select-all-' + this.id
      }, this._selectBarNode);

      this._selectAllLabel = domConstruct.create('label', {
        'for': 'pgm-select-all-' + this.id,
        innerHTML: 'Select All'
      }, this._selectBarNode);

      on(this._selectAllCheckbox, 'change', lang.hitch(this, function () {
        var checked = this._selectAllCheckbox.checked;
        this._items.forEach(function (item) { item.selected = checked; });
        this._updateItemCheckboxes();
        this._updateSelectAllLabel();
      }));

      // 4. Scrollable item list
      this._itemListNode = domConstruct.create('div', {
        'class': 'plan-group-item-list'
      }, this.domNode);

      // 5. Loading indicator (shown until items load)
      this._loadingNode = domConstruct.create('div', {
        'class': 'plan-group-loading',
        innerHTML: 'Loading items...'
      }, this._itemListNode);

      // 6. Action section
      this._buildActionSection();

      // 7. Buttons
      this._buildButtonSection();
    },

    _buildActionSection: function () {
      var self = this;
      var rc = this.reviewConfig || {};

      var actionSection = domConstruct.create('div', {
        'class': 'plan-group-action-section'
      }, this.domNode);

      // Action toggle: Create new / Add to existing
      var toggleDiv = domConstruct.create('div', {
        'class': 'plan-group-action-toggle'
      }, actionSection);

      var createId = 'pgm-create-' + this.id;
      var addToId = 'pgm-addto-' + this.id;

      this._createRadio = domConstruct.create('input', {
        type: 'radio',
        name: 'pgm-action-' + this.id,
        id: createId,
        value: 'create',
        checked: this._actionMode === 'create'
      }, toggleDiv);
      domConstruct.create('label', {
        'for': createId,
        innerHTML: 'Create new group'
      }, toggleDiv);

      domConstruct.create('span', { innerHTML: '&nbsp;&nbsp;&nbsp;' }, toggleDiv);

      this._addToRadio = domConstruct.create('input', {
        type: 'radio',
        name: 'pgm-action-' + this.id,
        id: addToId,
        value: 'add_to',
        checked: this._actionMode === 'add_to'
      }, toggleDiv);
      domConstruct.create('label', {
        'for': addToId,
        innerHTML: 'Add to existing group'
      }, toggleDiv);

      on(this._createRadio, 'change', lang.hitch(this, function () {
        if (this._createRadio.checked) {
          this._actionMode = 'create';
          this._showCreateSection();
        }
      }));
      on(this._addToRadio, 'change', lang.hitch(this, function () {
        if (this._addToRadio.checked) {
          this._actionMode = 'add_to';
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

      // Validate on input
      on(this._groupNameInput, 'input', lang.hitch(this, '_validateGroupName'));

      domConstruct.create('label', {
        innerHTML: 'Folder:',
        'class': 'plan-group-label'
      }, this._createSection);

      var groupType = rc.group_type || 'genome_group';
      var defaultPath = WorkspaceManager.getDefaultFolder(groupType);
      this._folderPathNode = domConstruct.create('div', {
        'class': 'plan-group-folder-path',
        innerHTML: defaultPath || '(default folder)'
      }, this._createSection);
      this._folderPath = defaultPath;

      // --- Add to existing group section ---
      this._existingSection = domConstruct.create('div', {
        'class': 'plan-group-existing-section',
        style: 'display:none;'
      }, actionSection);

      domConstruct.create('label', {
        innerHTML: 'Select existing group:',
        'class': 'plan-group-label'
      }, this._existingSection);

      this._existingSelect = domConstruct.create('select', {
        'class': 'plan-group-existing-select'
      }, this._existingSection);

      domConstruct.create('option', {
        value: '',
        innerHTML: 'Loading groups...'
      }, this._existingSelect);

      // Show/hide based on initial mode
      if (this._actionMode === 'add_to') {
        this._showExistingSection();
      } else {
        this._showCreateSection();
      }

      // Start loading existing groups in the background
      this._loadExistingGroups();
    },

    _buildButtonSection: function () {
      var self = this;
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
    // Data loading
    // ---------------------------------------------------------------

    _loadItems: function () {
      var sd = this.structuredData || {};
      var rc = this.reviewConfig || {};
      var ids = sd.record_ids || [];
      var idField = rc.id_field || 'genome_id';
      var groupType = rc.group_type || 'genome_group';

      // Build initial items from IDs (all selected by default)
      this._items = ids.map(function (id) {
        return { id: id, name: null, selected: true };
      });

      // Render items immediately with IDs only
      this._renderItems();

      // Fetch names in the background if we have IDs
      if (ids.length > 0) {
        this._fetchNames(ids, idField, groupType);
      }
    },

    _fetchNames: function (ids, idField, groupType) {
      var self = this;
      var collection = groupType === 'feature_group' ? 'genome_feature' : 'genome';
      var nameField = groupType === 'feature_group' ? 'patric_id,product,gene' : 'genome_name';
      var selectFields = idField + ',' + nameField;
      var dataApiUrl = window.App.dataAPI || window.App.dataServiceURL;

      if (!dataApiUrl) {
        console.warn('[PlanGroupManager] No dataAPI URL available');
        return;
      }

      // Batch fetch in chunks of 200 IDs to avoid URL length limits
      var chunkSize = 200;
      var chunks = [];
      for (var i = 0; i < ids.length; i += chunkSize) {
        chunks.push(ids.slice(i, i + chunkSize));
      }

      var completedChunks = 0;
      chunks.forEach(function (chunk) {
        var rqlQuery = 'in(' + idField + ',(' + chunk.join(',') + '))&select(' + selectFields + ')&limit(' + chunk.length + ')';

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
          if (Array.isArray(results)) {
            results.forEach(function (rec) {
              var id = rec[idField];
              if (id) {
                if (groupType === 'feature_group') {
                  self._nameMap[id] = rec.product || rec.patric_id || rec.gene || id;
                } else {
                  self._nameMap[id] = rec.genome_name || id;
                }
              }
            });
          }
          completedChunks++;
          if (completedChunks === chunks.length) {
            self._applyNames();
          }
        }, function (err) {
          console.warn('[PlanGroupManager] Failed to fetch names:', err);
          completedChunks++;
          if (completedChunks === chunks.length) {
            self._applyNames();
          }
        });
      });
    },

    _applyNames: function () {
      var self = this;
      this._items.forEach(function (item) {
        if (self._nameMap[item.id]) {
          item.name = self._nameMap[item.id];
        }
      });
      this._renderItems();
    },

    _loadExistingGroups: function () {
      var rc = this.reviewConfig || {};
      var groupType = rc.group_type || 'genome_group';
      var defaultPath = WorkspaceManager.getDefaultFolder(groupType);

      if (!defaultPath) {
        this._populateExistingSelect([]);
        return;
      }

      var self = this;
      // Use WorkspaceManager to list contents of the group folder
      Deferred.when(
        WorkspaceManager.api('Workspace.ls', [{ paths: [defaultPath] }]),
        function (results) {
          if (self._destroyed) return;
          var groups = [];
          if (results && results[0] && results[0][defaultPath]) {
            var items = results[0][defaultPath];
            items.forEach(function (item) {
              // item is [name, type, path, timestamp, id, owner, size, userMeta, autoMeta, permissions]
              // or a metadata array -- WorkspaceManager format
              var itemType = item[1] || '';
              var itemName = item[0] || '';
              var itemPath = item[2] || (defaultPath + '/' + itemName);

              if (itemType === groupType) {
                groups.push({
                  name: itemName,
                  path: itemPath,
                  type: itemType
                });
              }
            });
          }
          self._existingGroups = groups;
          self._populateExistingSelect(groups);
        },
        function (err) {
          console.warn('[PlanGroupManager] Failed to load existing groups:', err);
          self._populateExistingSelect([]);
        }
      );
    },

    _populateExistingSelect: function (groups) {
      if (!this._existingSelect) return;
      // Clear existing options
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

      groups.forEach(function (g) {
        domConstruct.create('option', {
          value: g.path,
          innerHTML: g.name
        }, this._existingSelect);
      });
    },

    // ---------------------------------------------------------------
    // Item rendering
    // ---------------------------------------------------------------

    _renderItems: function () {
      if (!this._itemListNode) return;

      // Remove loading indicator
      if (this._loadingNode) {
        domConstruct.destroy(this._loadingNode);
        this._loadingNode = null;
      }

      // Clear existing items
      this._itemListNode.innerHTML = '';

      if (this._items.length === 0) {
        domConstruct.create('div', {
          'class': 'plan-group-empty',
          innerHTML: 'No items available.'
        }, this._itemListNode);
        return;
      }

      var self = this;
      this._items.forEach(function (item, idx) {
        var row = domConstruct.create('div', {
          'class': 'plan-group-item'
        }, self._itemListNode);

        var cb = domConstruct.create('input', {
          type: 'checkbox',
          checked: item.selected,
          'data-idx': idx
        }, row);

        domConstruct.create('span', {
          'class': 'plan-group-item-id',
          innerHTML: item.id
        }, row);

        var nameText = item.name || '';
        if (!item.name && self._items.length > 0 && Object.keys(self._nameMap).length === 0) {
          nameText = '<span class="plan-group-loading-text">resolving...</span>';
        }
        domConstruct.create('span', {
          'class': 'plan-group-item-name',
          innerHTML: nameText
        }, row);

        on(cb, 'change', function () {
          item.selected = cb.checked;
          self._updateSelectAllLabel();
        });
      });

      this._updateSelectAllLabel();
    },

    _updateItemCheckboxes: function () {
      if (!this._itemListNode) return;
      var checkboxes = this._itemListNode.querySelectorAll('input[type="checkbox"]');
      var self = this;
      checkboxes.forEach(function (cb) {
        var idx = parseInt(cb.getAttribute('data-idx'), 10);
        if (!isNaN(idx) && self._items[idx]) {
          cb.checked = self._items[idx].selected;
        }
      });
    },

    _updateSelectAllLabel: function () {
      if (!this._selectAllLabel || !this._selectAllCheckbox) return;
      var selectedCount = this._items.filter(function (i) { return i.selected; }).length;
      var total = this._items.length;
      this._selectAllLabel.innerHTML = 'Select All (' + selectedCount + '/' + total + ')';
      this._selectAllCheckbox.checked = selectedCount === total;
    },

    // ---------------------------------------------------------------
    // Section visibility
    // ---------------------------------------------------------------

    _showCreateSection: function () {
      if (this._createSection) this._createSection.style.display = '';
      if (this._existingSection) this._existingSection.style.display = 'none';
    },

    _showExistingSection: function () {
      if (this._createSection) this._createSection.style.display = 'none';
      if (this._existingSection) this._existingSection.style.display = '';
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
      var self = this;
      var rc = this.reviewConfig || {};
      var groupType = rc.group_type || 'genome_group';
      var idField = rc.id_field || 'genome_id';

      // Collect selected IDs
      var selectedIds = this._items
        .filter(function (item) { return item.selected; })
        .map(function (item) { return item.id; });

      if (selectedIds.length === 0) {
        this._showActionError('Please select at least one item.');
        return;
      }

      if (this._actionMode === 'create') {
        this._saveNewGroup(selectedIds, groupType, idField);
      } else {
        this._addToExistingGroup(selectedIds, groupType, idField);
      }
    },

    _saveNewGroup: function (selectedIds, groupType, idField) {
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
        WorkspaceManager.createGroup(name, groupType, folderPath, idField, selectedIds),
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
              selected_ids: selectedIds,
              record_count: selectedIds.length,
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

    _addToExistingGroup: function (selectedIds, groupType, idField) {
      var self = this;
      var groupPath = this._existingSelect ? this._existingSelect.value : '';

      if (!groupPath) {
        this._showActionError('Please select an existing group.');
        return;
      }

      // Find the group name from our loaded list
      var groupName = '';
      this._existingGroups.forEach(function (g) {
        if (g.path === groupPath) groupName = g.name;
      });

      this._setLoading(true);
      this._hideActionError();

      Deferred.when(
        WorkspaceManager.addToGroup(groupPath, idField, selectedIds),
        function () {
          if (self._destroyed) return;
          self._setLoading(false);
          self._disableControls();

          if (typeof self.onComplete === 'function') {
            self.onComplete({
              group_name: groupName,
              group_path: groupPath,
              group_type: groupType,
              group_action: 'add_to',
              selected_ids: selectedIds,
              record_count: selectedIds.length,
              id_field: idField
            });
          }
        },
        function (err) {
          if (self._destroyed) return;
          self._setLoading(false);
          var errMsg = (err && err.message) ? err.message : 'Failed to add to group.';
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
      // Disable everything after successful save
      if (this._saveBtn) this._saveBtn.disabled = true;
      if (this._skipBtn) this._skipBtn.disabled = true;
      if (this._groupNameInput) this._groupNameInput.disabled = true;
      if (this._existingSelect) this._existingSelect.disabled = true;
      if (this._createRadio) this._createRadio.disabled = true;
      if (this._addToRadio) this._addToRadio.disabled = true;
      if (this._selectAllCheckbox) this._selectAllCheckbox.disabled = true;

      // Disable all item checkboxes
      if (this._itemListNode) {
        var checkboxes = this._itemListNode.querySelectorAll('input[type="checkbox"]');
        checkboxes.forEach(function (cb) { cb.disabled = true; });
      }

      // Show success message
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

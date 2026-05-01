define([
  'dojo/_base/declare', './GridContainer',
  './TaxonomyTreeGrid', 'dijit/popup',
  'dijit/TooltipDialog', 'dojo/on', 'dojo/dom-class'
], function (
  declare, GridContainer,
  Grid, popup,
  TooltipDialog, on, domClass
) {

  var dfc = '<div>Download Table As...</div><div class="wsActionTooltip" rel="text/tsv">Text</div><div class="wsActionTooltip" rel="text/csv">CSV</div><div class="wsActionTooltip" rel="application/vnd.openxmlformats">Excel</div>';
  var downloadTT = new TooltipDialog({
    content: dfc,
    onMouseLeave: function () {
      popup.close(downloadTT);
    }
  });

  on(downloadTT.domNode, 'div:click', function (evt) {
    var rel = evt.target.attributes.rel.value;
    // console.log("REL: ", rel);
    // var selection = self.actionPanel.get('selection');
    var dataType = (self.actionPanel.currentContainerWidget.containerType == 'genome_group') ? 'genome' : 'genome_feature';
    var currentQuery = self.actionPanel.currentContainerWidget.get('query');
    // console.log("selection: ", selection);
    // console.log("DownloadQuery: ", dataType, currentQuery );
    window.open('/api/' + dataType + '/' + currentQuery + '&http_authorization=' + encodeURIComponent(window.App.authorizationToken) + '&http_accept=' + rel + '&http_download');
    popup.close(downloadTT);
  });

  return declare([GridContainer], {
    'class': 'GridContainer TaxonTreeGrid no-phylo-col',
    facetFields: [],
    enableFilterPanel: false,
    dataModel: 'taxonomy',
    containerType: 'taxonomy_data',
    tutorialLink: 'quick_references/organisms_taxon/taxonomy.html',
    tooltip: 'The "Taxonomy" tab provides taxonomy subtree for the current taxon level.',
    _treeFilterActive: false,
    onSetState: function (attr, oldState, state) {
      // console.log("GridContainer onSetState: ", state, " oldState:", oldState);
      if (!state) {
        // console.log("!state in grid container; return;")
        return;
      }

      if (state && state.search) {
        this.set('query', state.search);
      }
    },
    getFilterPanel: function (opts) {
    },
    containerActions: GridContainer.prototype.containerActions.concat([
      [
        'ToggleFilters',
        'fa icon-filter fa-2x',
        {
          label: 'FILTERS',
          multiple: false,
          validTypes: ['*'],
          tooltip: 'Toggle Filters',
          tooltipDialog: downloadTT
        },
        function (selection) {
          on.emit(this.domNode, 'ToggleFilters', {});
        },
        true
      ],
      [
        'DownloadTable',
        'fa icon-download fa-2x',
        {
          label: 'DOWNLOAD',
          multiple: false,
          validTypes: ['*'],
          tooltip: 'Download Table',
          tooltipDialog: downloadTT
        },
        function (selection) {
          popup.open({
            popup: this.containerActionBar._actions.DownloadTable.options.tooltipDialog,
            around: this.containerActionBar._actions.DownloadTable.button,
            orient: ['below']
          });
        },
        true
      ]
    ]),
    selectionActions: GridContainer.prototype.selectionActions.concat([
      [
        'ShowWithTrees',
        'fa icon-tree2 fa-2x',
        {
          label: 'HIGHLIGHT',
          persistent: true,
          validTypes: ['*'],
          tooltip: 'Highlight rows with phylogenetic trees'
        },
        function (selection, container, button) {
          this._treeFilterActive = !this._treeFilterActive;
          domClass.toggle(this.domNode, 'trees-only-mode', this._treeFilterActive);
          var iconNode = button.querySelector('.ActionButton');
          if (iconNode) {
            domClass.toggle(iconNode, 'ActiveActionButton', this._treeFilterActive);
          }
          var labelNode = button.querySelector('.ActionButtonText');
          if (labelNode) {
            labelNode.textContent = this._treeFilterActive ? 'RESET' : 'HIGHLIGHT';
          }
        },
        true // visibility is controlled by CSS (.no-phylo-col hides it)
      ]
    ]),

    gridCtor: Grid,

    setVirusContext: function (isVirus) {
      domClass.toggle(this.domNode, 'no-phylo-col', !isVirus);
      // Reset highlight filter when leaving virus context
      if (!isVirus && this._treeFilterActive) {
        this._treeFilterActive = false;
        domClass.remove(this.domNode, 'trees-only-mode');
        var btn = this.selectionActionBar &&
          this.selectionActionBar._actions.ShowWithTrees &&
          this.selectionActionBar._actions.ShowWithTrees.button;
        if (btn) {
          var iconNode = btn.querySelector('.ActionButton');
          if (iconNode) {
            domClass.remove(iconNode, 'ActiveActionButton');
          }
          var labelNode = btn.querySelector('.ActionButtonText');
          if (labelNode) {
            labelNode.textContent = 'HIGHLIGHT';
          }
        }
      }
    },

    setPhyloManifest: function (manifest) {
      this._pendingPhyloManifest = manifest;
      if (this.grid) {
        this.grid.set('phyloManifest', manifest);
      }
    },

    setPhyloManifestData: function (data) {
      this._pendingPhyloManifestData = data;
      if (this.grid) {
        this.grid.set('phyloManifestData', data);
      }
    },

    onFirstView: function () {
      this.inherited(arguments);
      if (this._pendingPhyloManifest) {
        this.grid.set('phyloManifest', this._pendingPhyloManifest);
      }
      if (this._pendingPhyloManifestData) {
        this.grid.set('phyloManifestData', this._pendingPhyloManifestData);
      }
    }

  });
});

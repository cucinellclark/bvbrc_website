define([
    'dojo/_base/declare',
    'dojo/_base/lang',
    'dijit/TooltipDialog',
    'dijit/form/Button',
    'dijit/popup',
    'dojo/dom-construct',
    './BaseAttachment',
    '../../WorkspaceObjectSelector',
    '../../WorkspaceManager'
], function(
    declare,
    lang,
    TooltipDialog,
    Button,
    popup,
    domConstruct,
    BaseAttachment,
    WorkspaceObjectSelector,
    WorkspaceManager
) {
    /**
     * @class WorkspaceAttachment
     * @description Attachment widget specifically for workspace-related attachments.
     * Extends BaseAttachment to provide workspace-specific functionality.
     */
    return declare(BaseAttachment, {

        // Default icon for workspace attachments
        icon: '📁',

        // Default label for workspace attachments
        label: 'Workspace',

        // CSS class for workspace attachments
        className: 'workspace-attachment',

        // TODO: Need to use a custom widget for the dialog, communicate with attachment

        /**
         * @constructor
         * Creates a new WorkspaceAttachment instance
         * @param {Object} options - Configuration options
         */
        constructor: function(options) {
            // Set workspace-specific defaults
            this.icon = this.icon || '📁';
            this.label = this.label || 'Workspace';
            this.className = this.className || 'workspace-attachment';

            // Call parent constructor
            this.inherited(arguments);
        },

        /**
         * Handles click events on the workspace attachment
         * Opens a workspace file selector dialog when clicked
         * @param {Event} event - The click event
         */
        _onClick: function(event) {
            event.preventDefault();
            event.stopPropagation();

            console.log('WorkspaceAttachment clicked:', this.label);
            console.log('Workspace attachment data:', this.data);
            console.log('DOM node:', this.domNode);
            console.log('Event target:', event.target);

            // Open workspace file selector
            this._openWorkspaceFileSelector(event.target);
        },

        /**
         * Opens a tooltip with a WorkspaceObjectSelector widget and Select button
         * @private
         */
        _openWorkspaceFileSelector: function(targetElement) {
            var self = this;

            console.log('Opening workspace file selector tooltip...');
            console.log('Target element:', targetElement);

            // Use the target element if domNode is not available
            var anchorElement = this.domNode || targetElement;
            console.log('Using anchor element:', anchorElement);

            // Create the tooltip dialog
            var tooltip = new TooltipDialog({
                style: 'width: 300px; height: 35px;'
            });

            // Create container for the workspace selector
            var selectorContainer = domConstruct.create('div', {
                style: 'width: 100%; height: 35px; margin-bottom: 10px;'
            });

            // Create the workspace object selector
            var fileSelector = new WorkspaceObjectSelector({
                allowUpload: false,
                autoSelectCurrent: false,
                onlyWritable: true,
                selectionText: 'Selected File',
                disableDropdownSelector: false,
                title: 'Select Workspace File',
                style: 'width: 100%;',
                promptMessage: 'Select a file from your workspace'
            });

            // Set allowed file types (use specific types instead of '*')
            fileSelector.set('type', ['folder', 'contigs', 'reads', 'feature_dna_fasta', 'feature_protein_fasta', 'aligned_dna_fasta', 'aligned_protein_fasta', 'csv', 'tsv', 'txt', 'json', 'nwk', 'phyloxml']);

            // Set the path to user's workspace
            if (window.App && window.App.user) {
                fileSelector.set('path', '/' + window.App.user.id);
            }

            // Place the selector in the container
            fileSelector.placeAt(selectorContainer);

            // Start the selector to initialize it properly
            fileSelector.startup();

            // Add container to tooltip
            domConstruct.place(selectorContainer, tooltip.containerNode);

            // Handle selection changes to automatically select and close
            fileSelector.onSelection = function(selectedPath) {
                var selection = fileSelector.selection;
                if (selection && selection.name) {
                    // Update the attachment with the selected file
                    self.setAttachment({
                        name: selection.name,
                        path: selection.path,
                        type: selection.type,
                        id: selection.id || selection.path,
                        metadata: selection
                    });

                    console.log('Workspace file selected:', selection);

                    // Close the tooltip
                    popup.close(tooltip);
                }
            };

            // Show the tooltip positioned around the attachment
            console.log('About to open popup with anchor element:', anchorElement);
            popup.open({
                popup: tooltip,
                around: anchorElement,
                orient: ['above']
            });
            console.log('Popup open called');

            // Add click-outside handler to close tooltip
            var clickOutsideHandler = function(event) {
                // Check if the click is outside the tooltip and not on the anchor element
                if (!tooltip.domNode.contains(event.target) && !anchorElement.contains(event.target)) {
                    popup.close(tooltip);
                    // Remove the event listener after closing
                    document.removeEventListener('click', clickOutsideHandler);
                }
            };

            // Add the click event listener with a small delay to prevent immediate closure
            setTimeout(function() {
                document.addEventListener('click', clickOutsideHandler);
            }, 100);
        },

        /**
         * Sets the attachment data for a workspace attachment
         * @param {Object} attachmentData - The workspace attachment information
         * @param {string} attachmentData.name - Name of the workspace
         * @param {string} attachmentData.type - Type of workspace (e.g., 'folder', 'project', 'collection')
         * @param {string} attachmentData.id - Unique identifier for the workspace
         * @param {string} attachmentData.path - Path to the workspace
         * @param {Array} attachmentData.contents - Contents of the workspace
         * @param {Object} attachmentData.metadata - Additional metadata about the workspace
         */
        setAttachment: function(attachmentData) {
            if (!attachmentData) {
                throw new Error('Workspace attachment data is required');
            }

            // Store the attachment data
            this.data = attachmentData;

            // Update the display based on the data
            if (attachmentData.name) {
                this.setLabel(attachmentData.name);
            }

            if (attachmentData.type) {
                // Set appropriate icon based on workspace type
                this._setIconForWorkspaceType(attachmentData.type);
            }

            // Log the attachment for debugging
            console.log('Workspace attachment set:', attachmentData);
        },

        /**
         * Sets the appropriate icon based on the workspace type
         * @param {string} workspaceType - The type of workspace
         * @private
         */
        _setIconForWorkspaceType: function(workspaceType) {
            var iconMap = {
                'folder': '📁',
                'project': '📂',
                'collection': '🗂️',
                'workspace': '🏢',
                'directory': '📋',
                'archive': '🗃️',
                'shared': '👥',
                'personal': '👤',
                'public': '🌐',
                'private': '🔒',
                'default': '📁'
            };

            var icon = iconMap[workspaceType.toLowerCase()] || iconMap.default;
            this.setIcon(icon);
        },

        /**
         * Shows workspace-specific information
         * @private
         */
        _showWorkspaceInfo: function() {
            if (this.data) {
                console.log('Workspace Information:');
                console.log('- Name:', this.data.name || 'Unknown');
                console.log('- Type:', this.data.type || 'Unknown');
                console.log('- ID:', this.data.id || 'Unknown');
                if (this.data.path) {
                    console.log('- Path:', this.data.path);
                }
                if (this.data.contents && Array.isArray(this.data.contents)) {
                    console.log('- Contents:', this.data.contents.length, 'items');
                }
                if (this.data.metadata) {
                    console.log('- Metadata:', this.data.metadata);
                }
            }
        },

        /**
         * Gets the workspace type of this attachment
         * @returns {string} The workspace type
         */
        getWorkspaceType: function() {
            return this.data ? this.data.type : null;
        },

        /**
         * Gets the workspace ID of this attachment
         * @returns {string} The workspace ID
         */
        getWorkspaceId: function() {
            return this.data ? this.data.id : null;
        },

        /**
         * Gets the workspace name of this attachment
         * @returns {string} The workspace name
         */
        getWorkspaceName: function() {
            return this.data ? this.data.name : null;
        },

        /**
         * Gets the workspace path of this attachment
         * @returns {string} The workspace path
         */
        getWorkspacePath: function() {
            return this.data ? this.data.path : null;
        },

        /**
         * Gets the workspace contents of this attachment
         * @returns {Array} The workspace contents
         */
        getWorkspaceContents: function() {
            return this.data ? this.data.contents : null;
        },

        /**
         * Updates the workspace contents
         * @param {Array} contents - New contents array
         */
        updateWorkspaceContents: function(contents) {
            if (this.data) {
                this.data.contents = contents;
                console.log('Workspace contents updated:', contents.length, 'items');
            }
        },

        /**
         * Adds an item to the workspace contents
         * @param {Object} item - Item to add to the workspace
         */
        addToWorkspace: function(item) {
            if (this.data && this.data.contents) {
                this.data.contents.push(item);
                console.log('Item added to workspace:', item);
            }
        },

        /**
         * Removes an item from the workspace contents
         * @param {string|Object} item - Item to remove (by ID or object reference)
         */
        removeFromWorkspace: function(item) {
            if (this.data && this.data.contents) {
                var index = -1;
                if (typeof item === 'string') {
                    // Remove by ID
                    index = this.data.contents.findIndex(function(content) {
                        return content.id === item;
                    });
                } else {
                    // Remove by object reference
                    index = this.data.contents.indexOf(item);
                }

                if (index > -1) {
                    var removedItem = this.data.contents.splice(index, 1)[0];
                    console.log('Item removed from workspace:', removedItem);
                }
            }
        },

        /**
         * Gets the attachment prompt with details about the attachment
         * Workspace attachments return null as per requirements
         * @returns {null} Always returns null for workspace attachments
         */
        getAttachmentPrompt: function() {
            return null;
        }
    });
});

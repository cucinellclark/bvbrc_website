define([
    'dojo/_base/declare',
    'dojo/dom-construct',
    'dojo/on',
    'dojo/_base/lang',
    './attachments/BaseAttachment',
    './attachments/DataAttachment',
    './attachments/ServiceAttachment',
    './attachments/WorkspaceAttachment'
], function(
    declare,
    domConstruct,
    on,
    lang,
    BaseAttachment,
    DataAttachment,
    ServiceAttachment,
    WorkspaceAttachment
) {
    /**
     * @class ChatAttachment
     * @description A horizontal pill-shaped widget that displays an icon and label.
     * When clicked, it shows a dropdown to select context types (Data, Service, Workspace).
     * Once a context is selected, it creates the appropriate specialized attachment instance.
     */
    return declare(null, {

        // Data fields associated with this attachment
        data: null,

        // Icon to display (can be text, HTML, or CSS class)
        icon: null,

        // Label text to display
        label: null,

        // CSS classes for styling
        className: 'chat-attachment',

        // Container element where this widget is placed
        container: null,

        // Main DOM node for this widget
        domNode: null,

        // Currently selected context type
        selectedContext: null,

        // Available context types with their icons and corresponding attachment classes
        contextTypes: [
            { name: 'Workspace', icon: '📁', attachmentClass: WorkspaceAttachment },
            { name: 'Service', icon: '⚙️', attachmentClass: ServiceAttachment },
            { name: 'Data', icon: '💾', attachmentClass: DataAttachment }
        ],

        // Current attachment instance (null until a context is selected)
        attachmentInstance: null,

        // Dropdown menu element
        dropdownMenu: null,

        // Callback function to notify parent when attachment is removed
        onRemove: null,

        /**
         * @constructor
         * Creates a new ChatAttachment instance
         * @param {Object} options - Configuration options
         * @param {string} options.icon - Icon to display (text, HTML, or CSS class)
         * @param {string} options.label - Label text to display
         * @param {Object} options.data - Data fields associated with this attachment
         * @param {string} options.className - Optional CSS class name
         * @param {HTMLElement} options.container - Container to place the widget in
         * @param {Function} options.onRemove - Callback function called when attachment is removed
         */
        constructor: function(options) {
            if (options) {
                lang.mixin(this, options);
            }

            // Set defaults
            this.icon = this.icon || '📎';
            this.label = this.label || 'Attachment';
            this.data = this.data || {};

            // Create the widget
            this.createWidget();
        },

        /**
         * Creates the DOM structure for the attachment widget
         */
        createWidget: function() {
            // Create main container
            this.domNode = domConstruct.create('div', {
                class: this.className,
                style: this._getPillStyles()
            });

            // Create icon section (first third)
            var iconSection = domConstruct.create('div', {
                class: 'chat-attachment-icon',
                style: this._getIconStyles()
            }, this.domNode);

            // Set icon content
            if (this.icon.startsWith('<') || this.icon.includes('.')) {
                // HTML content or CSS class
                iconSection.innerHTML = this.icon;
            } else {
                // Text content
                iconSection.textContent = this.icon;
            }

            // Create label section (remaining two thirds)
            var labelSection = domConstruct.create('div', {
                class: 'chat-attachment-label',
                style: this._getLabelStyles(),
                textContent: this.label
            }, this.domNode);

            // Add click handler
            on(this.domNode, 'click', lang.hitch(this, this._onClick));

            // Place in container if provided
            if (this.container) {
                domConstruct.place(this.domNode, this.container);
            }
        },

        /**
         * Handles click events on the attachment
         * Shows context dropdown when clicking icon, delegates to attachment instance when clicking label
         */
        _onClick: function(event) {
            event.preventDefault();
            event.stopPropagation();

            // Check if the click was on the icon section
            var iconSection = this.domNode.querySelector('.chat-attachment-icon');
            var isIconClick = iconSection && iconSection.contains(event.target);

            if (isIconClick) {
                // Icon clicked - always show dropdown (for new or assigned contexts)
                this._showContextDropdown();
            } else {
                // Label clicked
                if (this.attachmentInstance && this.attachmentInstance._onClick) {
                    // Delegate to the attachment instance's click handler
                    this.attachmentInstance._onClick(event);
                } else if (this.selectedContext) {
                    // Already assigned a context - just log what it is
                    console.log('ChatAttachment context:', this.selectedContext);
                } else {
                    // New attachment - show context dropdown
                    this._showContextDropdown();
                }
            }
        },

        /**
         * Shows the context type dropdown menu
         */
        _showContextDropdown: function() {
            // Remove existing dropdown if any
            this._hideContextDropdown();

            // Create dropdown container
            this.dropdownMenu = domConstruct.create('div', {
                class: 'chat-attachment-dropdown',
                style: this._getDropdownStyles()
            });

            // Add Remove option only
            var removeItem = domConstruct.create('div', {
                class: 'chat-attachment-dropdown-item',
                style: this._getDropdownItemStyles() + 'color: #dc2626;', // Red color for remove
                innerHTML: '<span style="margin-right: 8px;">🗑️</span>Remove'
            });

            // Add click handler for remove
            on(removeItem, 'click', lang.hitch(this, function() {
                this._hideContextDropdown();
                this._removeAttachment();
            }));

            // Add hover effects for remove item
            on(removeItem, 'mouseenter', function() {
                this.style.backgroundColor = '#fef2f2'; // Light red background
            });
            on(removeItem, 'mouseleave', function() {
                this.style.backgroundColor = 'transparent';
            });

            domConstruct.place(removeItem, this.dropdownMenu);

            // Position dropdown above the attachment
            this._positionDropdown();

            // Add to document body to ensure it's above everything
            domConstruct.place(this.dropdownMenu, document.body);

            // Add click outside handler to close dropdown
            this._dropdownClickHandler = on(document, 'click', lang.hitch(this, function(event) {
                if (!this.domNode.contains(event.target) && !this.dropdownMenu.contains(event.target)) {
                    this._hideContextDropdown();
                }
            }));
        },

        /**
         * Hides the context dropdown menu
         */
        _hideContextDropdown: function() {
            if (this.dropdownMenu) {
                domConstruct.destroy(this.dropdownMenu);
                this.dropdownMenu = null;
            }
            if (this._dropdownClickHandler) {
                this._dropdownClickHandler.remove();
                this._dropdownClickHandler = null;
            }
        },

        /**
         * Selects a context type and creates the appropriate attachment instance
         * @param {Object} contextType - The selected context type
         */
        _selectContext: function(contextType) {
            this.selectedContext = contextType;

            // Destroy existing attachment instance if any
            if (this.attachmentInstance) {
                this.attachmentInstance.destroy();
                this.attachmentInstance = null;
            }

            // Create new attachment instance based on the selected context type
            var AttachmentClass = contextType.attachmentClass;
            if (AttachmentClass) {
                // Create the attachment instance without creating its own DOM
                this.attachmentInstance = new AttachmentClass({
                    icon: contextType.icon,
                    label: contextType.name,
                    data: this.data,
                    container: null, // Don't let it create its own DOM placement
                    onRemove: this.onRemove,
                    createDOM: false // Don't create DOM elements
                });

                // Update the current widget's display to match the new attachment
                this.setIcon(contextType.icon);
                this.setLabel(contextType.name);

                console.log('Created attachment instance:', contextType.name, this.attachmentInstance);
            } else {
                // Fallback to basic functionality if no attachment class is specified
                this.setIcon(contextType.icon);
                this.setLabel(contextType.name);
            }
        },

        /**
         * Positions the dropdown menu above the attachment
         */
        _positionDropdown: function() {
            if (!this.dropdownMenu || !this.domNode) return;

            var rect = this.domNode.getBoundingClientRect();
            // Account for only the remove option
            var dropdownHeight = 32; // Single item height

            this.dropdownMenu.style.left = rect.left + 'px';
            this.dropdownMenu.style.top = (rect.top - dropdownHeight - 4) + 'px';
        },

        /**
         * Returns CSS styles for the dropdown menu
         * @returns {string} CSS style string
         */
        _getDropdownStyles: function() {
            return [
                'position: fixed;',
                'background: white;',
                'border: 1px solid #d1d5db;',
                'border-radius: 8px;',
                'box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);',
                'z-index: 9999;',
                'min-width: 120px;',
                'padding: 4px 0;'
            ].join(' ');
        },

        /**
         * Returns CSS styles for dropdown items
         * @returns {string} CSS style string
         */
        _getDropdownItemStyles: function() {
            return [
                'padding: 8px 12px;',
                'cursor: pointer;',
                'font-size: 12px;',
                'color: #374151;',
                'display: flex;',
                'align-items: center;',
                'transition: background-color 0.2s ease;'
            ].join(' ');
        },

        /**
         * Returns CSS styles for the pill container
         * @returns {string} CSS style string
         */
        _getPillStyles: function() {
            return [
                'display: flex;',
                'align-items: center;',
                'background: #f1f5f9;',
                'border: 1px solid #d1d5db;',
                'border-radius: 12px;',
                'padding: 4px 8px;',
                'margin: 2px;',
                'cursor: pointer;',
                'transition: all 0.2s ease;',
                'max-width: 100px;',
                'min-width: 50px;',
                'box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);'
            ].join(' ');
        },

        /**
         * Returns CSS styles for the icon section
         * @returns {string} CSS style string
         */
        _getIconStyles: function() {
            return [
                'flex: 0 0 33.33%;',
                'display: flex;',
                'align-items: center;',
                'justify-content: center;',
                'font-size: 12px;',
                'color: #6b7280;',
                'margin-right: 4px;'
            ].join(' ');
        },

        /**
         * Returns CSS styles for the label section
         * @returns {string} CSS style string
         */
        _getLabelStyles: function() {
            return [
                'flex: 1;',
                'font-size: 11px;',
                'color: #374151;',
                'font-weight: 500;',
                'white-space: nowrap;',
                'overflow: hidden;',
                'text-overflow: ellipsis;'
            ].join(' ');
        },

        /**
         * Updates the icon of the attachment
         * @param {string} newIcon - New icon to display
         */
        setIcon: function(newIcon) {
            this.icon = newIcon;
            if (this.domNode) {
                var iconSection = this.domNode.querySelector('.chat-attachment-icon');
                if (iconSection) {
                    if (newIcon.startsWith('<') || newIcon.includes('.')) {
                        iconSection.innerHTML = newIcon;
                    } else {
                        iconSection.textContent = newIcon;
                    }
                }
            }
        },

        /**
         * Updates the label of the attachment
         * @param {string} newLabel - New label text
         */
        setLabel: function(newLabel) {
            this.label = newLabel;
            if (this.domNode) {
                var labelSection = this.domNode.querySelector('.chat-attachment-label');
                if (labelSection) {
                    labelSection.textContent = newLabel;
                }
            }
        },

        /**
         * Updates the data associated with this attachment
         * @param {Object} newData - New data object
         */
        setData: function(newData) {
            this.data = newData || {};

            // If we have an attachment instance, update its data as well
            if (this.attachmentInstance && this.attachmentInstance.setData) {
                this.attachmentInstance.setData(newData);
            }
        },

        /**
         * Sets attachment data using the specialized setAttachment method
         * @param {Object} attachmentData - The attachment data to set
         */
        setAttachment: function(attachmentData) {
            if (this.attachmentInstance && this.attachmentInstance.setAttachment) {
                this.attachmentInstance.setAttachment(attachmentData);

                // Update the display based on the attachment data
                if (attachmentData.name) {
                    this.setLabel(attachmentData.name);
                }
                if (attachmentData.type && this.attachmentInstance._setIconForDataType) {
                    // Let the attachment instance handle icon setting based on type
                    this.attachmentInstance._setIconForDataType(attachmentData.type);
                    this.setIcon(this.attachmentInstance.icon);
                } else if (attachmentData.type && this.attachmentInstance._setIconForServiceType) {
                    this.attachmentInstance._setIconForServiceType(attachmentData.type);
                    this.setIcon(this.attachmentInstance.icon);
                } else if (attachmentData.type && this.attachmentInstance._setIconForWorkspaceType) {
                    this.attachmentInstance._setIconForWorkspaceType(attachmentData.type);
                    this.setIcon(this.attachmentInstance.icon);
                }
            } else {
                // Fallback to basic data setting if no specialized instance
                this.setData(attachmentData);
            }
        },

        /**
         * Places the widget in a container
         * @param {HTMLElement} container - Container to place the widget in
         */
        placeAt: function(container) {
            if (this.domNode && container) {
                domConstruct.place(this.domNode, container);
            }
        },

        /**
         * Gets the currently selected context type
         * @returns {Object|null} The selected context type or null if none selected
         */
        getSelectedContext: function() {
            return this.selectedContext;
        },

        /**
         * Sets a context type programmatically
         * @param {string} contextName - Name of the context type to set
         */
        setContext: function(contextName) {
            var contextType = this.contextTypes.find(function(ct) {
                return ct.name === contextName;
            });
            if (contextType) {
                this._selectContext(contextType);
            }
        },

        /**
         * Gets the current attachment instance
         * @returns {Object|null} The current attachment instance or null if none selected
         */
        getAttachmentInstance: function() {
            return this.attachmentInstance;
        },

        /**
         * Gets the type of the current attachment instance
         * @returns {string|null} The attachment type name or null if none selected
         */
        getAttachmentType: function() {
            return this.selectedContext ? this.selectedContext.name : null;
        },

        /**
         * Removes the attachment widget and notifies parent
         */
        _removeAttachment: function() {
            // Notify parent if callback is provided
            if (this.onRemove && typeof this.onRemove === 'function') {
                this.onRemove(this);
            }

            // Destroy the widget
            this.destroy();
        },

        /**
         * Gets the attachment prompt from the specialized attachment instance
         * @returns {string|null} The attachment prompt or null if no instance or method
         */
        getAttachmentPrompt: function() {
            if (this.attachmentInstance && typeof this.attachmentInstance.getAttachmentPrompt === 'function') {
                return this.attachmentInstance.getAttachmentPrompt();
            }
            return null;
        },

        /**
         * Destroys the widget and removes it from the DOM
         */
        destroy: function() {
            // Clean up dropdown
            this._hideContextDropdown();

            // Destroy attachment instance if it exists
            if (this.attachmentInstance) {
                this.attachmentInstance.destroy();
                this.attachmentInstance = null;
            }

            if (this.domNode && this.domNode.parentNode) {
                this.domNode.parentNode.removeChild(this.domNode);
            }
            this.domNode = null;
        }
    });
});

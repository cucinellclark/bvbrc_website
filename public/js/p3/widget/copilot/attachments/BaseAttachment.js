define([
    'dojo/_base/declare',
    'dojo/dom-construct',
    'dojo/on',
    'dojo/_base/lang'
], function(
    declare,
    domConstruct,
    on,
    lang
) {
    /**
     * @class BaseAttachment
     * @description Abstract base class for attachment widgets.
     * Provides common functionality and defines the interface that all attachment types must implement.
     */
    return declare(null, {

        // Data fields associated with this attachment
        data: null,

        // Icon to display (can be text, HTML, or CSS class)
        icon: null,

        // Label text to display
        label: null,

        // CSS classes for styling
        className: 'base-attachment',

        // Container element where this widget is placed
        container: null,

        // Main DOM node for this widget
        domNode: null,

        // Callback function to notify parent when attachment is removed
        onRemove: null,

        /**
         * @constructor
         * Creates a new BaseAttachment instance
         * @param {Object} options - Configuration options
         * @param {string} options.icon - Icon to display (text, HTML, or CSS class)
         * @param {string} options.label - Label text to display
         * @param {Object} options.data - Data fields associated with this attachment
         * @param {string} options.className - Optional CSS class name
         * @param {HTMLElement} options.container - Container to place the widget in
         * @param {Function} options.onRemove - Callback function called when attachment is removed
         * @param {boolean} options.createDOM - Whether to create DOM elements (default: true)
         */
        constructor: function(options) {
            if (options) {
                lang.mixin(this, options);
            }

            // Set defaults
            this.icon = this.icon || '📎';
            this.label = this.label || 'Attachment';
            this.data = this.data || {};

            // Create the widget only if createDOM is not explicitly false
            if (this.createDOM !== false) {
                this.createWidget();
            }
        },

        /**
         * Creates the DOM structure for the attachment widget
         * This method should be overridden by subclasses to provide specific implementations
         */
        createWidget: function() {
            // Create main container
            this.domNode = domConstruct.create('div', {
                class: this.className,
                style: this._getPillStyles()
            });

            // Create icon section (first third)
            var iconSection = domConstruct.create('div', {
                class: 'attachment-icon',
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
                class: 'attachment-label',
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
         * This method should be overridden by subclasses to provide specific behavior
         */
        _onClick: function(event) {
            event.preventDefault();
            event.stopPropagation();
            console.log('BaseAttachment clicked:', this.label);
        },

        /**
         * Abstract method that must be implemented by subclasses
         * Sets the attachment data and updates the widget accordingly
         * @param {Object} attachmentData - The attachment data to set
         */
        setAttachment: function(attachmentData) {
            throw new Error('setAttachment method must be implemented by subclass');
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
                var iconSection = this.domNode.querySelector('.attachment-icon');
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
                var labelSection = this.domNode.querySelector('.attachment-label');
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
         * Destroys the widget and removes it from the DOM
         */
        destroy: function() {
            if (this.domNode && this.domNode.parentNode) {
                this.domNode.parentNode.removeChild(this.domNode);
            }
            this.domNode = null;
        },

        /**
         * Gets the attachment prompt with details about the attachment
         * This method should be overridden by subclasses to provide specific functionality
         * @returns {string|null} A string prompt with attachment details or null
         */
        getAttachmentPrompt: function() {
            return null;
        }
    });
});

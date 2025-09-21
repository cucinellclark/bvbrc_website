define([
    'dojo/_base/declare',
    'dojo/dom-construct',
    'dojo/on',
    'dijit/TooltipDialog',
    'dijit/form/TextBox',
    'dijit/form/Button',
    'dijit/popup',
    './BaseAttachment'
], function(
    declare,
    domConstruct,
    on,
    TooltipDialog,
    TextBox,
    Button,
    popup,
    BaseAttachment
) {
    /**
     * @class DataAttachment
     * @description Attachment widget specifically for data-related attachments.
     * Extends BaseAttachment to provide data-specific functionality.
     */
    return declare(BaseAttachment, {

        // Default icon for data attachments
        icon: '💾',

        // Default label for data attachments
        label: 'Data',

        // CSS class for data attachments
        className: 'data-attachment',

        // Form data for the attachment
        formData: {
            genomeId: '',
            genomeName: '',
            featureId: ''
        },

        /**
         * @constructor
         * Creates a new DataAttachment instance
         * @param {Object} options - Configuration options
         */
        constructor: function(options) {
            // Set data-specific defaults
            this.icon = this.icon || '💾';
            this.label = this.label || 'Data';
            this.className = this.className || 'data-attachment';

            // Initialize form data
            this.formData = {
                genomeId: '',
                genomeName: '',
                featureId: ''
            };

            // Call parent constructor
            this.inherited(arguments);
        },

        /**
         * Handles click events on the data attachment
         * @param {Event} event - The click event
         */
        _onClick: function(event) {
            event.preventDefault();
            event.stopPropagation();

            console.log('DataAttachment clicked:', this.label);
            console.log('Data attachment data:', this.data);

            // Show tooltip with form
            this._showDataFormTooltip(event.target);
        },

        /**
         * Sets the attachment data for a data attachment
         * @param {Object} attachmentData - The data attachment information
         * @param {string} attachmentData.name - Name of the data item
         * @param {string} attachmentData.type - Type of data (e.g., 'genome', 'sequence', 'annotation')
         * @param {string} attachmentData.id - Unique identifier for the data
         * @param {Object} attachmentData.metadata - Additional metadata about the data
         */
        setAttachment: function(attachmentData) {
            if (!attachmentData) {
                throw new Error('Data attachment data is required');
            }

            // Store the attachment data
            this.data = attachmentData;

            // Update the display based on the data
            if (attachmentData.name) {
                this.setLabel(attachmentData.name);
            }

            if (attachmentData.type) {
                // Set appropriate icon based on data type
                this._setIconForDataType(attachmentData.type);
            }

            // Log the attachment for debugging
            console.log('Data attachment set:', attachmentData);
        },

        /**
         * Sets the appropriate icon based on the data type
         * @param {string} dataType - The type of data
         * @private
         */
        _setIconForDataType: function(dataType) {
            var iconMap = {
                'genome': '🧬',
                'sequence': '📄',
                'annotation': '📝',
                'protein': '🔬',
                'gene': '🧪',
                'pathway': '🛤️',
                'metabolic': '⚗️',
                'regulatory': '🎛️',
                'default': '💾'
            };

            var icon = iconMap[dataType.toLowerCase()] || iconMap.default;
            this.setIcon(icon);
        },

        /**
         * Shows a tooltip with a form for data attachment details
         * @param {HTMLElement} targetElement - The element to anchor the tooltip to
         * @private
         */
        _showDataFormTooltip: function(targetElement) {
            var self = this;

            // Create the tooltip dialog
            var tooltip = new TooltipDialog({
                style: 'width: 300px; padding: 15px;'
            });

            // Create form container
            var formContainer = domConstruct.create('div', {
                style: 'display: flex; flex-direction: column; gap: 10px;'
            });

            // Create form fields
            var genomeIdField = new TextBox({
                placeholder: 'Genome ID',
                value: this.formData.genomeId,
                style: 'width: 100%;'
            });

            var genomeNameField = new TextBox({
                placeholder: 'Genome Name',
                value: this.formData.genomeName,
                style: 'width: 100%;'
            });

            var featureIdField = new TextBox({
                placeholder: 'Feature ID',
                value: this.formData.featureId,
                style: 'width: 100%;'
            });

            // Create save button
            var saveButton = new Button({
                label: 'Save',
                onClick: function() {
                    // Update form data
                    self.formData.genomeId = genomeIdField.get('value');
                    self.formData.genomeName = genomeNameField.get('value');
                    self.formData.featureId = featureIdField.get('value');

                    console.log('Form data saved:', self.formData);

                    // Close the tooltip
                    popup.close(tooltip);
                }
            });

            // Place form elements in container
            genomeIdField.placeAt(formContainer);
            genomeNameField.placeAt(formContainer);
            featureIdField.placeAt(formContainer);
            saveButton.placeAt(formContainer);

            // Start the form elements
            genomeIdField.startup();
            genomeNameField.startup();
            featureIdField.startup();
            saveButton.startup();

            // Add form to tooltip
            domConstruct.place(formContainer, tooltip.containerNode);

            // Show the tooltip
            popup.open({
                popup: tooltip,
                around: targetElement,
                orient: ['above', 'below']
            });

            // Add click-outside handler to close tooltip
            var clickOutsideHandler = function(event) {
                if (!tooltip.domNode.contains(event.target) && !targetElement.contains(event.target)) {
                    popup.close(tooltip);
                    document.removeEventListener('click', clickOutsideHandler);
                }
            };

            setTimeout(function() {
                document.addEventListener('click', clickOutsideHandler);
            }, 100);
        },

        /**
         * Shows data-specific information
         * @private
         */
        _showDataInfo: function() {
            if (this.data) {
                console.log('Data Information:');
                console.log('- Name:', this.data.name || 'Unknown');
                console.log('- Type:', this.data.type || 'Unknown');
                console.log('- ID:', this.data.id || 'Unknown');
                if (this.data.metadata) {
                    console.log('- Metadata:', this.data.metadata);
                }
            }
        },

        /**
         * Gets the data type of this attachment
         * @returns {string} The data type
         */
        getDataType: function() {
            return this.data ? this.data.type : null;
        },

        /**
         * Gets the data ID of this attachment
         * @returns {string} The data ID
         */
        getDataId: function() {
            return this.data ? this.data.id : null;
        },

        /**
         * Gets the data name of this attachment
         * @returns {string} The data name
         */
        getDataName: function() {
            return this.data ? this.data.name : null;
        },

        /**
         * Gets the attachment prompt with form data details
         * @returns {string|null} JSON string of non-empty form fields or null
         */
        getAttachmentPrompt: function() {
            var nonEmptyFields = {};

            // Check each form field and add to result if not empty
            if (this.formData.genomeId && this.formData.genomeId.trim() !== '') {
                nonEmptyFields.genome_id = this.formData.genomeId.trim();
            }
            if (this.formData.genomeName && this.formData.genomeName.trim() !== '') {
                nonEmptyFields.genome_name = this.formData.genomeName.trim();
            }
            if (this.formData.featureId && this.formData.featureId.trim() !== '') {
                nonEmptyFields.feature_id = this.formData.featureId.trim();
            }

            // Return JSON string if there are non-empty fields, otherwise null
            return Object.keys(nonEmptyFields).length > 0 ? JSON.stringify(nonEmptyFields) : null;
        }
    });
});

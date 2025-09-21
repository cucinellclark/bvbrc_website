define([
    'dojo/_base/declare',
    './BaseAttachment'
], function(
    declare,
    BaseAttachment
) {
    /**
     * @class ServiceAttachment
     * @description Attachment widget specifically for service-related attachments.
     * Extends BaseAttachment to provide service-specific functionality.
     */
    return declare(BaseAttachment, {

        // Default icon for service attachments
        icon: '⚙️',

        // Default label for service attachments
        label: 'Service',

        // CSS class for service attachments
        className: 'service-attachment',

        /**
         * @constructor
         * Creates a new ServiceAttachment instance
         * @param {Object} options - Configuration options
         */
        constructor: function(options) {
            // Set service-specific defaults
            this.icon = this.icon || '⚙️';
            this.label = this.label || 'Service';
            this.className = this.className || 'service-attachment';

            // Call parent constructor
            this.inherited(arguments);
        },

        /**
         * Handles click events on the service attachment
         * @param {Event} event - The click event
         */
        _onClick: function(event) {
            event.preventDefault();
            event.stopPropagation();

            console.log('ServiceAttachment clicked:', this.label);
            console.log('Service attachment data:', this.data);

            // Service-specific click behavior can be added here
            this._showServiceInfo();
        },

        /**
         * Sets the attachment data for a service attachment
         * @param {Object} attachmentData - The service attachment information
         * @param {string} attachmentData.name - Name of the service
         * @param {string} attachmentData.type - Type of service (e.g., 'analysis', 'tool', 'workflow')
         * @param {string} attachmentData.id - Unique identifier for the service
         * @param {Object} attachmentData.config - Service configuration parameters
         * @param {Object} attachmentData.metadata - Additional metadata about the service
         */
        setAttachment: function(attachmentData) {
            if (!attachmentData) {
                throw new Error('Service attachment data is required');
            }

            // Store the attachment data
            this.data = attachmentData;

            // Update the display based on the data
            if (attachmentData.name) {
                this.setLabel(attachmentData.name);
            }

            if (attachmentData.type) {
                // Set appropriate icon based on service type
                this._setIconForServiceType(attachmentData.type);
            }

            // Log the attachment for debugging
            console.log('Service attachment set:', attachmentData);
        },

        /**
         * Sets the appropriate icon based on the service type
         * @param {string} serviceType - The type of service
         * @private
         */
        _setIconForServiceType: function(serviceType) {
            var iconMap = {
                'analysis': '📊',
                'tool': '🔧',
                'workflow': '🔄',
                'blast': '🎯',
                'alignment': '📐',
                'phylogeny': '🌳',
                'annotation': '📝',
                'comparison': '⚖️',
                'visualization': '📈',
                'export': '📤',
                'import': '📥',
                'default': '⚙️'
            };

            var icon = iconMap[serviceType.toLowerCase()] || iconMap.default;
            this.setIcon(icon);
        },

        /**
         * Shows service-specific information
         * @private
         */
        _showServiceInfo: function() {
            if (this.data) {
                console.log('Service Information:');
                console.log('- Name:', this.data.name || 'Unknown');
                console.log('- Type:', this.data.type || 'Unknown');
                console.log('- ID:', this.data.id || 'Unknown');
                if (this.data.config) {
                    console.log('- Configuration:', this.data.config);
                }
                if (this.data.metadata) {
                    console.log('- Metadata:', this.data.metadata);
                }
            }
        },

        /**
         * Gets the service type of this attachment
         * @returns {string} The service type
         */
        getServiceType: function() {
            return this.data ? this.data.type : null;
        },

        /**
         * Gets the service ID of this attachment
         * @returns {string} The service ID
         */
        getServiceId: function() {
            return this.data ? this.data.id : null;
        },

        /**
         * Gets the service name of this attachment
         * @returns {string} The service name
         */
        getServiceName: function() {
            return this.data ? this.data.name : null;
        },

        /**
         * Gets the service configuration of this attachment
         * @returns {Object} The service configuration
         */
        getServiceConfig: function() {
            return this.data ? this.data.config : null;
        },

        /**
         * Updates the service configuration
         * @param {Object} config - New configuration object
         */
        updateServiceConfig: function(config) {
            if (this.data) {
                this.data.config = config;
                console.log('Service configuration updated:', config);
            }
        },

        /**
         * Gets the attachment prompt with details about the attachment
         * Service attachments return null as per requirements
         * @returns {null} Always returns null for service attachments
         */
        getAttachmentPrompt: function() {
            return null;
        }
    });
});

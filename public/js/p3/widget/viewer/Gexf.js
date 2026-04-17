define([
    "dojo/_base/declare", "dijit/layout/BorderContainer", "dijit/layout/ContentPane", 
    "dojo/_base/lang", "dojo/on", "dojo/topic", "dojo/request", "dojo/when",
    "../../WorkspaceManager", "../../util/PathJoin", 
    "dojo/query", "dojo/dom-geometry", "dojo/dom-style", "dojo/dom-construct",
    "../ActionBar", "../ItemDetailPanel", "../PerspectiveToolTip", "dojo/dom-class",
    "../SelectionToGroup", "dijit/Dialog",
    "dijit/TooltipDialog", "dijit/popup"
 

], function(
    declare, BorderContainer, ContentPane, 
    lang, on, Topic, xhr, when,
    WorkspaceManager, PathJoin, 
    query, domGeom, domStyle, domConstruct,
    ActionBar, ItemDetailPanel, PerspectiveToolTipDialog, domClass,
    SelectionToGroup, Dialog,
    TooltipDialog, popup
){
    var scriptsReady = false;
    var pendingCallbacks = [];
    
    var loadGexfDependencies = function(callback) {
        if (scriptsReady) { callback(); return; }
        pendingCallbacks.push(callback);
        if (pendingCallbacks.length > 1) { return; }
        
        var stylesToLoad = [
            '/vendor/gexf-js/styles/jquery-ui-1.10.3.custom.min.css',
            '/vendor/gexf-js/styles/gexfjs.css'
        ];

        stylesToLoad.forEach(function(href){
            if (!document.querySelector('link[href="' + href + '"]')) {
                var link = document.createElement('link');
                link.rel = 'stylesheet';
                link.type = 'text/css';
                link.href = href;
                document.getElementsByTagName('head')[0].appendChild(link);
            }
        });
        
        // Using strict order loading
        var scriptsToLoad = [
            '/vendor/gexf-js/js/jquery-2.0.2.min.js',
            '/vendor/gexf-js/js/jquery-ui-1.10.4.custom.min.js',
            '/vendor/gexf-js/js/jquery.mousewheel.min.js',
            '/vendor/gexf-js/js/gexfjs.js'
        ];
        
        var loadScript = function(index) {
            if (index >= scriptsToLoad.length) {
                scriptsReady = true;
                pendingCallbacks.forEach(function(cb){ cb(); });
                return;
            }
            var script = document.createElement('script');
            script.type = 'text/javascript';
            script.src = scriptsToLoad[index];
            script.onload = function() { loadScript(index + 1); };
            script.onerror = function() { console.error("Failed to load script:", scriptsToLoad[index]); };
            document.getElementsByTagName('head')[0].appendChild(script);
        };
        loadScript(0);
    };

    // INHERITANCE CHANGE: Inherit from BorderContainer to manage layout
    return declare([BorderContainer], { 
        "baseClass": "GEXFView",
        "disabled": false,
        "path": "",
        "file": null,
        "gutters": false, // No spacing between regions
        "design": "headline",
        _resizeHandle: null,
        
        // Data management properties
        selection: null,
        containerType: "feature_data", // Default assumption

        // HTML Template for the CENTER region (The Graph)
        // Note: We hide the old #leftcolumn sidebar here
        graphTemplateString: `
            <div style="width: 100%; height: 100%; overflow: hidden;">
                <style>
                    /* Force canvas container to top-left of the CENTER pane */
                    #zonecentre { top: 0 !important; left: 0 !important; }
                    
                    #overviewzone {
                        top: 50px !important;
                        left: 10px !important;
                        bottom: auto !important;
                        right: auto !important;
                        background: rgba(255,255,255,0.7);
                        border: 1px solid #999;
                    }

                    /* HIDE THE OLD LEGACY SIDEBAR - We use ItemDetailPanel now */
                    #leftcolumn, #unfold {
                        display: none !important;
                    }
                    #titlebar {
                        position: absolute !important;
                        top: 0 !important;
                        left: 0 !important;
                        width: 100% !important;
                        height: 0px !important; /* Don't take up space */
                        
                        margin: 0 !important;
                        padding: 0 !important;
                        
                        /* CRITICAL: Allow children to be seen outside this 0px box */
                        overflow: visible !important;
                        
                        pointer-events: none !important;
                        z-index: 2000 !important; /* Highest layer */
                    }

                    /* Hide Main Title */
                    #maintitle {
                        display: none !important;
                    }
                    /* Search Bar Styling */
                    #recherche {
                        position: absolute !important;
                        top: 20px !important;
                        left: 240px !important;
                        right: auto !important;
                        bottom: auto !important;
                        display: block !important;
                        background: rgba(255,255,255,0.8);
                        padding: 5px;
                        border-radius: 4px;
                        pointer-events: auto !important;
                        z-index: 2001 !important;
                    }

                    #searchinput, #searchsubmit {
                        position: static !important; 
                        float: none !important;
                        top: auto !important; left: auto !important;
                        display: inline-block !important;
                        vertical-align: middle !important;
                        margin: 0 2px !important;
                        pointer-events: auto !important;
                        visibility: visible !important;
                        opacity: 1 !important;
                    }
                </style>
                <div id="zonecentre" class="gradient" style="position: relative; width: 100%; height: 100%;">
                    <canvas id="carte" width="0" height="0"></canvas>
                    <ul id="ctlzoom">
                        <li><a href="#" id="zoomPlusButton"></a></li>
                        <li id="zoomSliderzone"><div id="zoomSlider"></div></li>
                        <li><a href="#" id="zoomMinusButton"></a></li>
                        <li><a href="#" id="lensButton"></a></li>
                        <li><a href="#" id="edgesButton"></a></li>
                    </ul>
                </div>
                <div id="overviewzone" class="gradient">
                    <canvas id="overview" width="0" height="0"></canvas>
                </div>
                <div id="titlebar"><div id="maintitle"></div><form id="recherche"><input id="searchinput" class="grey" autocomplete="off" /><input id="searchsubmit" type="submit" /></form></div>
                <ul id="autocomplete"></ul>
            </div>
        `,

        // Define Actions (copied and adapted from MSATree/GenomeList)
        selectionActions: [
            [
                "ToggleItemDetail",
                "fa icon-chevron-circle-right fa-2x",
                {
                    label: "HIDE",
                    persistent: true,
                    validTypes: ["*"],
                    tooltip: "Toggle Details Pane"
                },
                function(selection, container, button){
                    var children = this.getChildren();
                    if(children.some(function(child){ return this.itemDetailPanel && (child.id == this.itemDetailPanel.id); }, this)){
                        this.removeChild(this.itemDetailPanel);
                        query(".ActionButtonText", button).forEach(function(node){ node.innerHTML = "DETAILS"; });
                        query(".ActionButton", button).forEach(function(node){ domClass.remove(node, "icon-chevron-circle-right"); domClass.add(node, "icon-chevron-circle-left"); });
                    }else{
                        this.addChild(this.itemDetailPanel);
                        query(".ActionButtonText", button).forEach(function(node){ node.innerHTML = "HIDE"; });
                        query(".ActionButton", button).forEach(function(node){ domClass.remove(node, "icon-chevron-circle-left"); domClass.add(node, "icon-chevron-circle-right"); });
                    }
                },
                true
            ],
            [
                "ColorSelection",
                "fa icon-paint-brush fa-2x",
                {
                    label: "PIN",
                    persistent: true,
                    validTypes: ["*"],
                    validContainerTypes:["*"],
                    tooltip: "Color Current Graph Selection",
                    ignoreDataType: true
                },
                function (selection) {
                    // Open the tooltip dialog we built in postCreate
                    popup.open({
                        popup: this.colorMenu,
                        around: this.selectionActionBar._actions.ColorSelection.button,
                        orient: ["above", "below"] // Action bar is on bottom right, "above" works well
                    });
                },
                true
            ],
            [
                "HighlightColor",
                "fa icon-eye fa-2x", // Or any icon you prefer, e.g., icon-magic
                {
                    label: "HIGHLIGHT",
                    persistent: true,
                    validTypes: ["*"],
                    validContainerTypes:["*"],
                    tooltip: "Set Highlight Color Override",
                    ignoreDataType: true
                },
                function (selection) {
                    popup.open({
                        popup: this.hlColorMenu,
                        around: this.selectionActionBar._actions.HighlightColor.button,
                        orient: ["above", "below"]
                    });
                },
                true
            ],
            [
                "ResetColors",
                "fa icon-reset fa-2x",
                {
                    label: "RESET COLORS",
                    validTypes: ["*"],
                    multiple: true, // Allow it to work regardless of selection count
                    tooltip: "Clear all pinned colors",
                    validContainerTypes: ["feature_data", "genome_data"]
                },
                function(selection){
                    if (window.GexfJS && GexfJS.params) {
                        GexfJS.params.pinnedElements = {}; // Clear the object
                        // Force a redraw
                        if (GexfJS.oldParams) delete GexfJS.oldParams.zoomLevel;
                    }
                },
                true
            ],
            [
                "BackgroundColor",
                "fa icon-desktop fa-2x", // Standard icon for background/display 
                {
                    label: "BG COLOR",
                    persistent: true,
                    validTypes: ["*"],
                    validContainerTypes:["*"],
                    tooltip: "Set Graph Background Color",
                    ignoreDataType: true
                },
                function (selection) {
                    popup.open({
                        popup: this.bgColorMenu,
                        around: this.selectionActionBar._actions.BackgroundColor.button,
                        orient: ["above", "below"]
                    });
                },
                true // Enabled by default
            ],
            [
                "ViewFeatureItem",
                "MultiButton fa icon-selection-Feature fa-2x",
                {
                    label: "FEATURE",
                    validTypes: ["*"],
                    multiple: false,
                    tooltip: "Switch to Feature View. Press and Hold for more options.",
                    validContainerTypes: ["feature_data"],
                    pressAndHold: function(selection, button, opts, evt){
                        popup.open({
                            popup: new PerspectiveToolTipDialog({ perspective: "Feature", perspectiveUrl: "/view/Feature/" + selection[0].feature_id }),
                            around: button,
                            orient: ["below"]
                        });
                    }
                },
                function(selection){
                    var sel = selection[0];
                    Topic.publish("/navigate", { href: "/view/Feature/" + sel.patric_id + "#view_tab=overview", target: "blank" });
                },
                false
            ],
            [
                "AddGroup",
                "fa icon-object-group fa-2x",
                {
                    label: "GROUP",
                    ignoreDataType: true,
                    multiple: true,
                    validTypes: ["*"],
                    requireAuth: true,
                    max: 10000,
                    tooltip: "Add selection to a new or existing group",
                    validContainerTypes: ["feature_data", "genome_data"]
                },
                function(selection, containerWidget){
                    // This requires the SelectionToGroup widget (you may need to add it to imports if you use this)
                    // For now, this is a placeholder matching MSATree structure
                    console.log("Add Group clicked", selection);
                    // console.log("Add Items to Group", selection);
                    var dlg = new Dialog({ title: 'Add selected items to group' });
                    var type;

                    if (!containerWidget) {
                        // console.log("Container Widget not setup for addGroup");
                        return;
                    }

                    if (containerWidget.containerType == 'genome_data') {
                        type = 'genome_group';
                    } else if (containerWidget.containerType == 'feature_data') {
                        type = 'feature_group';
                    }

                    if (!type) {
                        console.error('Missing type for AddGroup');
                        return;
                    }
                    var stg = new SelectionToGroup({
                        selection: selection,
                        selectType: true,
                        type: type,
                        inputType: containerWidget.containerType,
                        path: containerWidget.get('path')
                    });
                    on(dlg.domNode, 'dialogAction', function (evt) {
                        dlg.hide();
                        setTimeout(function () {
                        dlg.destroy();
                        }, 2000);
                    });
                    domConstruct.place(stg.domNode, dlg.containerNode, 'first');
                    stg.startup();
                    dlg.startup();
                    dlg.show();

                },
                false
            ]
        ],

        setupActions: function () {
            this.selectionActions.forEach(function (a) {
                this.selectionActionBar.addAction(a[0], a[1], a[2], lang.hitch(this, a[3]), a[4], a[5], a[6], a[7], a[8], a[9], a[10]);
            }, this);
        },

        postCreate: function(){
            this.inherited(arguments); // Calls BorderContainer postCreate
            var colorMenuDiv = domConstruct.create("div", {
                innerHTML: '<div style="padding: 5px;">Select Color: <input type="color" id="gexfColorPicker" value="#ff0000" style="vertical-align: middle;"></div>' +
                           '<div style="text-align:center; margin-top:5px;"><button id="gexfColorApply" style="padding: 3px 10px; cursor: pointer;">Apply</button></div>'
            });

            this.colorMenu = new TooltipDialog({
                content: colorMenuDiv,
                //onMouseLeave: lang.hitch(this, function () {
                //    popup.close(this.colorMenu);
                //})
            });

            // When the Apply button is clicked, trigger the color logic
            on(colorMenuDiv, "#gexfColorApply:click", lang.hitch(this, function() {
                var color = document.getElementById('gexfColorPicker').value;
                this.applyColorToGraph(color);
                popup.close(this.colorMenu);
            }));

            var hlColorMenuDiv = domConstruct.create("div", {
                innerHTML: '<div style="padding: 5px;">Highlight Color: <input type="color" id="gexfHlColorPicker" value="#ff00ff" style="vertical-align: middle;"></div>' +
                           '<div style="text-align:center; margin-top:5px;">' + 
                           '<button id="gexfHlColorApply" style="padding: 3px 10px; cursor: pointer; margin-right: 5px;">Apply</button>' +
                           '<button id="gexfHlColorClear" style="padding: 3px 10px; cursor: pointer;">Clear</button>' +
                           '</div>'
            });

            this.hlColorMenu = new TooltipDialog({
                content: hlColorMenuDiv
                // No onMouseLeave, so the native picker doesn't close it
            });

            // Apply button logic
            on(hlColorMenuDiv, "#gexfHlColorApply:click", lang.hitch(this, function() {
                var color = document.getElementById('gexfHlColorPicker').value;
                if (window.GexfJS && GexfJS.params) {
                    GexfJS.params.highlightColorOverride = color;
                    delete GexfJS.oldParams.zoomLevel; // Force redraw
                }
                popup.close(this.hlColorMenu);
            }));

            // Clear button logic (revert to default colors)
            on(hlColorMenuDiv, "#gexfHlColorClear:click", lang.hitch(this, function() {
                if (window.GexfJS && GexfJS.params) {
                    GexfJS.params.highlightColorOverride = null;
                    delete GexfJS.oldParams.zoomLevel; // Force redraw
                }
                popup.close(this.hlColorMenu);
            }));
            
            var bgColorMenuDiv = domConstruct.create("div", {
                innerHTML: '<div style="padding: 5px;">Background: <input type="color" id="gexfBgColorPicker" value="#ffffff" style="vertical-align: middle;"></div>' +
                           '<div style="text-align:center; margin-top:5px;">' + 
                           '<button id="gexfBgColorApply" style="padding: 3px 10px; cursor: pointer; margin-right: 5px;">Apply</button>' +
                           '<button id="gexfBgColorReset" style="padding: 3px 10px; cursor: pointer;">Reset</button>' +
                           '</div>'
            });

            this.bgColorMenu = new TooltipDialog({
                content: bgColorMenuDiv
            });

            // Apply custom background color
            on(bgColorMenuDiv, "#gexfBgColorApply:click", lang.hitch(this, function() {
                var color = document.getElementById('gexfBgColorPicker').value;
                var zc = document.getElementById('zonecentre');
                var oc = document.getElementById('overviewzone'); // Update mini-map too
                
                if (zc) {
                    domClass.remove(zc, 'gradient');
                    domStyle.set(zc, 'background', color);
                }
                if (oc) {
                    domClass.remove(oc, 'gradient');
                    domStyle.set(oc, 'background', color);
                }
                popup.close(this.bgColorMenu);
            }));

            // Reset back to default gradient
            on(bgColorMenuDiv, "#gexfBgColorReset:click", lang.hitch(this, function() {
                var zc = document.getElementById('zonecentre');
                var oc = document.getElementById('overviewzone');
                
                if (zc) {
                    domStyle.set(zc, 'background', ''); // Clear inline style
                    domClass.add(zc, 'gradient');       // Restore class
                }
                if (oc) {
                    domStyle.set(oc, 'background', '');
                    domClass.add(oc, 'gradient');
                }
                popup.close(this.bgColorMenu);
            }));

            this.viewerPane = new ContentPane({ region: "center", content: this.graphTemplateString, style: "padding:0; overflow:hidden;" });

            // 1. Create the Center Pane (The Graph)
            this.viewerPane = new ContentPane({
                region: "center",
                content: this.graphTemplateString,
                style: "padding:0; overflow:hidden;"
            });
            this.addChild(this.viewerPane);

            // 2. Create the Right Pane (ActionBar)
            this.selectionActionBar = new ActionBar({
                region: "right",
                layoutPriority: 2,
                style: "width:56px; text-align:center;",
                splitter: false,
                currentContainerWidget: this
            });
            this.addChild(this.selectionActionBar);

            // 3. Create the Right Pane (ItemDetailPanel)
            this.itemDetailPanel = new ItemDetailPanel({
                region: "right",
                style: "width:300px",
                splitter: true,
                layoutPriority: 1,
                containerWidget: this
            });
            this.addChild(this.itemDetailPanel);

            this.setupActions();
            this.watch("state", lang.hitch(this, "onSetState"));
        },

        startup: function(){
            if (this._started){ return; }
            this.inherited(arguments);
            
            // Bind resize to the window to handle outer layout changes
            this._resizeHandle = on(window, 'resize', lang.hitch(this, function(){ this.resize(); }));
            
            this.itemDetailPanel.startup();
            this.selectionActionBar.startup();
            
            this.onSetState("state", null, this.state);
        },
        
        destroy: function(){
            if (this._resizeHandle){ this._resizeHandle.remove(); }
            if (window.GexfJS && GexfJS.timeRefresh) { clearInterval(GexfJS.timeRefresh); }
            this.inherited(arguments);
        },

        onSetState: function(attr, oldVal, state){
            if (!state || !state.search) return;
            var params = new URLSearchParams(state.search);
            var workspacePath = params.get('path');
            if (workspacePath) { this.loadAndRender(workspacePath); }
        },

        loadAndRender: function(path) {
            this.path = path;
            loadGexfDependencies(lang.hitch(this, function() {
                // Set content on the viewerPane, not 'this' (which is the BorderContainer)
                this.viewerPane.set("content", "<div>Loading GEXF file...</div>");
                
                WorkspaceManager.getObject(this.path, false).then(lang.hitch(this, function(res){
                    if (res && res.data){
                        // Reset the template into the center pane
                        this.viewerPane.set("content", this.graphTemplateString);
                        setTimeout(lang.hitch(this, function() { this.renderGraph(res.data); }), 50);
                    }
                }));
            }));
        },
        
        renderGraph: function(gexfXMLData){
            if (!window.startGraphViewer || !window.GexfJS) return;

            var originalDisplayNode = window.displayNode;
            
            // --- BRIDGE: Intercept Node Clicks ---
            window.displayNode = lang.hitch(this, function(nodeIndex) {
                if (originalDisplayNode) originalDisplayNode(nodeIndex);

                var node = GexfJS.graph.nodeList[nodeIndex];
                if (!node) return;

                var featureAttrIndex = null;
                if (GexfJS._node_attr_value && GexfJS._node_attr_value["features"]) {
                    featureAttrIndex = GexfJS._node_attr_value["features"];
                }

                // 1. Extract the raw Feature Mapping (JSON) to preserve hierarchy
                var featureMap = null;
                var targetIds = [];

                if (featureAttrIndex !== null && node.attributes[featureAttrIndex]) {
                    try {
                        var rawJson = node.attributes[featureAttrIndex].replace(/""/g, '"');
                        featureMap = JSON.parse(rawJson);
                        
                        // Flatten to get IDs for API query
                        Object.keys(featureMap).forEach(function(genomeId) {
                            var contigs = featureMap[genomeId];
                            Object.keys(contigs).forEach(function(contigId) {
                                var features = contigs[contigId];
                                features.forEach(function(fid) {
                                    targetIds.push(fid);
                                });
                            });
                        });
                    } catch (e) {
                        console.error("Error parsing features JSON:", e);
                    }
                }

                // 2. Pass the full NODE object (added as 3rd arg)
                if (targetIds.length > 0) {
                    this.onGraphSelection(targetIds, featureMap, node);
                } else if (node.label) {
                    this.onGraphSelection([node.label], null, node);
                }
            });

                        // --- NEW: Global Pin Color Function ---
            window.pinColor = lang.hitch(this, function(ids, type, colorValue) {
                if (!window.GexfJS || !GexfJS.params.pinnedElements) return;

                // ids can be a single string or a comma-separated string
                var idList = ids.split(',');

                // 1. Convert HEX color to RGBA string (gexfjs usually prefers rgba)
                // Note: Input type="color" returns Hex (e.g. #ff0000). 
                // We can use it directly if gexfjs accepts hex, which canvas usually does.
                // If opacity issues arise, we might need to convert. 
                // For now, let's use the Hex string directly.
                var finalColor = colorValue;

                idList.forEach(function(targetId) {
                    if (type === 'node') {
                        // Easy: TargetId is the Node ID (e.g. "4748")
                        // Wait, our inputs usually use Labels or Feature IDs. 
                        // We need to look up the internal Node ID.
                        
                        // If targetId is the internal int index:
                        if (GexfJS.graph.nodeList[targetId]) {
                            GexfJS.params.pinnedElements['n_' + targetId] = finalColor;
                        } 
                        // If targetId is a label/feature ID:
                        else if (GexfJS.graph.nodeIndexByLabel && GexfJS.graph.nodeIndexByLabel[targetId] !== undefined) {
                             var idx = GexfJS.graph.nodeIndexByLabel[targetId];
                             GexfJS.params.pinnedElements[idx] = finalColor;
                        }
                    } 
                    else if (type === 'path') {
                        // Harder: TargetId is a Genome/Sequence ID (e.g. "NC_007624")
                        // We need to find all edges associated with this path.
                        
                        // We reuse the logic from displayPath to find the edges
                        var attr_id = GexfJS._edge_attr_value['sequences']; // or 'genomes'
                        if (GexfJS.path_highlights && GexfJS.path_highlights[attr_id]) {
                            
                            // Look up the edges for this path ID
                            // (Remember our quote cleaning logic!)
                            var cleanId = targetId.replace(/"/g, '');
                            var edges = GexfJS.path_highlights[attr_id][cleanId];
                            
                            // If direct lookup fails, try searching cleaned keys (from our previous fix)
                            if (!edges) {
                                for (var key in GexfJS.path_highlights[attr_id]) {
                                    if (key.replace(/"/g, '') === cleanId) {
                                        edges = GexfJS.path_highlights[attr_id][key];
                                        break;
                                    }
                                }
                            }

                            if (edges) {
                                Object.keys(edges).forEach(function(edgeId) {
                                    GexfJS.params.pinnedElements['e_' + edgeId] = finalColor;
                                });
                            }
                        }
                    }
                });
            });
            // --------------------------------------

            // (configuration logic...)
            var graph_params = {
                showEdges : true,
                zoomLevel : 0,
                edgeWidthFactor : 10,
                pathAttr : "sequences",
                colorNodeAttr : "diversity",
                nodeSizeFactor : 2,
                patric_on: true,
                genome_url: 'https://www.bv-brc.org/api/genome?in(genome_id,(GIDSTRING))&select(genome_id,genome_name)&limit(500)&http_accept=application/solr+json',
                location_url: 'https://www.bv-brc.org/api/genome_sequence?in(sequence_id,(SIDSTRING))&select(sequence_id,description)&facet((pivot,(genome_id,genome_name,sequence_id)))&http_accept=application/solr+json',
                replicon_url: 'https://www.bv-brc.org/api/genome_sequence?in(genome_id,(GIDSTRING))&select(sequence_id,description)&facet((pivot,(genome_id,genome_name,sequence_id)))&http_accept=application/solr+json',
                language: false
            };
            setParams(graph_params);

            var originalSetInterval = window.setInterval;
            window.setInterval = function() { return 999; }; 

            var gexf_dom = (new window.DOMParser()).parseFromString(gexfXMLData, "text/xml");
            startGraphViewer(gexf_dom);

            window.setInterval = originalSetInterval;

            this.resize();
            GexfJS.timeRefresh = setInterval(window.traceMap, 60);
        },

        applyColorToGraph: function(color) {
            if (!window.GexfJS || !GexfJS.params) return;
            
            if (!GexfJS.params.pinnedElements) {
                GexfJS.params.pinnedElements = {};
            }
            
            var pinned = GexfJS.params.pinnedElements;
            var applied = false;

            // If paths are currently highlighted in the graph, color those Edges
            if (GexfJS.params.path_active && GexfJS.params.activeEdges) {
                Object.keys(GexfJS.params.activeEdges).forEach(function(edgeId) {
                    pinned['e_' + edgeId] = color;
                    applied = true;
                });
            } 
            // Otherwise, if a specific Node is selected, color that Node
            else if (GexfJS.params.currentNode !== -1) {
                var nodeId = GexfJS.params.currentNode;
                pinned['n_' + nodeId] = color;
                applied = true;
            }

            // Force the graph to redraw to show the new colors
            if (applied) {
                delete GexfJS.oldParams.zoomLevel; 
            }
        },

        // --- UPDATED SELECTION LOGIC ---
        onGraphSelection: function(ids, featureMap, node) {
            if (!ids || ids.length === 0) return;
            
            // Ensure inputs are strings and clean them up
            var cleanIds = ids.map(function(id) { return String(id).replace(/"/g, ''); });
            var isFeature = cleanIds[0].match(/^fig\|\d+\.\d+/);
            
            var query = "";
            var url = "";

            if (isFeature) {
                this.containerType = "feature_data";
                url = PathJoin(window.App.dataAPI, "genome_feature");
                // Get enough fields to display useful info
                query = "in(patric_id,(" + cleanIds.map(encodeURIComponent).join(",") + "))&select(patric_id,genome_name,product)&limit(25000)"; 
            } else {
                this.containerType = "genome_data";
                url = PathJoin(window.App.dataAPI, "genome");
                query = "in(genome_id,(" + cleanIds.map(encodeURIComponent).join(",") + "))&select(genome_id,genome_name)&limit(25000)";
            }

            // Execute the query
            xhr.post(url, {
                headers: {
                    accept: "application/json",
                    "X-Requested-With": null,
                    Authorization: (window.App.authorizationToken || "")
                },
                handleAs: "json",
                data: query
            }).then(lang.hitch(this, function(records) {
                if (records && records.length > 0) {
                    this.updateSelection(records, featureMap, node);
                }
            }));
        },

        updateSelection: function(records, featureMap, node) {
            this.selection = records;
            
            // 1. Update ActionBar
            this.selectionActionBar.set("currentContainerType", this.containerType);
            this.selectionActionBar.set("selection", this.selection);
            this.itemDetailPanel.set("selection", this.selection);

            // --- Helper for Color Input ---
            var colorInput = function(ids, type) {
                // Returns an HTML5 color picker that triggers window.pinColor on change
                return '<input type="color" style="width:20px; height:20px; vertical-align:middle; border:none; padding:0; background:none; cursor:pointer;" onchange="window.pinColor(\'' + ids + '\', \'' + type + '\', this.value)"> ';
            };

            // 2. Prepare Data for HTML Construction
            
            // A. Helper to get attribute names from IDs
            var nodeAttrIdToName = {};
            if (window.GexfJS && GexfJS._node_attr_value) {
                Object.keys(GexfJS._node_attr_value).forEach(function(name){
                    nodeAttrIdToName[GexfJS._node_attr_value[name]] = name;
                });
            }

            // Lookup Edge Attribute IDs for displayPath
            var genomeAttrId = 'genomes';
            var sequenceAttrId = 'sequences';
            
            if (window.GexfJS && GexfJS._edge_attr_value) {
                if (GexfJS._edge_attr_value['genomes']) {
                    genomeAttrId = GexfJS._edge_attr_value['genomes'];
                }
                if (GexfJS._edge_attr_value['sequences']) {
                    sequenceAttrId = GexfJS._edge_attr_value['sequences'];
                }
            }

            // B. Build Attributes HTML
            var attrHtml = '<div style="margin-bottom:10px; font-size:0.9em; color:#555;">';
            attrHtml += '<div><b>Node ID:</b> ' + node.id + '</div>';
            
            if (node.attributes) {
                Object.keys(node.attributes).forEach(function(attrId){
                    var name = nodeAttrIdToName[attrId];
                    if (name && name !== 'features') {
                        attrHtml += '<div><b>' + name + ':</b> ' + node.attributes[attrId] + '</div>';
                    }
                });
            }
            attrHtml += '</div>';

            // C. Build Graph Links
            var linksHtml = '';
            var recordMap = {};
            records.forEach(function(rec) { 
                var key = rec.patric_id || rec.genome_id;
                recordMap[key] = rec; 
            });

            if (featureMap) {
                var allGenomes = Object.keys(featureMap);
                var allSequences = [];
                
                // Build Hierarchy HTML
                var hierarchyHtml = '<div class="graph-links" style="font-size:0.9em;">';
                
                Object.keys(featureMap).forEach(function(genomeId) {
                    var contigs = featureMap[genomeId];
                    var genomeSequences = Object.keys(contigs);
                    allSequences = allSequences.concat(genomeSequences);
                    
                    // --- RESTORED LOGIC: Calculate genomeName ---
                    var genomeName = genomeId; 
                    var features = [];
                    // Flatten features to find a record to get the name from
                    Object.keys(contigs).forEach(function(k){ features = features.concat(contigs[k]); });
                    
                    if(features.length > 0 && recordMap[features[0]] && recordMap[features[0]].genome_name){
                        genomeName = recordMap[features[0]].genome_name;
                    }
                    // ---------------------------------------------

                    hierarchyHtml += '<div style="margin-top:5px;">';
                    // COLOR PICKER: Genome (Edge Group)
                    //hierarchyHtml += colorInput(genomeId, 'path');
                    hierarchyHtml += '<a href="javascript:void(0)" style="font-weight:bold;" onclick="window.displayPath(undefined, \'' + genomeId + '\', \'' + genomeAttrId + '\'); return false;">' + genomeName + '</a>:';
                    hierarchyHtml += '<div style="padding-left:20px;">';

                    Object.keys(contigs).forEach(function(contigId) {
                        hierarchyHtml += '<div>';
                        // COLOR PICKER: Sequence (Edge Group)
                        //hierarchyHtml += colorInput(contigId, 'path');
                        hierarchyHtml += '<a href="javascript:void(0)" onclick="window.displayPath(undefined, \'' + contigId + '\', \'' + sequenceAttrId + '\'); return false;">' + contigId + '</a>:';
                        hierarchyHtml += '</div>';
                        
                        var feats = contigs[contigId];
                        hierarchyHtml += '<div style="padding-left:10px; color:#666;">[' + feats.join(', ') + ']</div>';
                    });
                    hierarchyHtml += '</div></div>';
                });
                hierarchyHtml += '</div>';

                // Summary Header
                var summaryHtml = '<div style="margin-bottom:10px; padding-bottom:5px; border-bottom:1px solid #ccc;">';
                
                // COLOR PICKER: All Genomes
                //summaryHtml += '<div>' + colorInput(allGenomes.join(','), 'path');
                summaryHtml += '<b><a href="javascript:void(0)" onclick="window.displayPath(undefined, \'' + allGenomes.join(',') + '\', \'' + genomeAttrId + '\'); return false;">Genomes[' + allGenomes.length + ']</a></b></div>';
                
                // COLOR PICKER: All Sequences
                //summaryHtml += '<div>' + colorInput(allSequences.join(','), 'path');
                summaryHtml += '<b><a href="javascript:void(0)" onclick="window.displayPath(undefined, \'' + allSequences.join(',') + '\', \'' + sequenceAttrId + '\'); return false;">Sequences[' + allSequences.length + ']</a></b></div>';
                
                summaryHtml += '</div>';

                linksHtml = summaryHtml + hierarchyHtml;
            }

            // 3. Assemble Content
            var content = '<div style="padding:10px;">';
            // COLOR PICKER: Title (Node)
            content += '<div style="margin-bottom:5px;">' + colorInput(node.id, 'node') + '<h3 style="margin:0; display:inline; word-wrap:break-word;">' + node.label + '</h3></div>';
            content += attrHtml;
            content += linksHtml;
            content += '</div>';

            // 4. Update IDP
            if (this.itemDetailPanel.customDisplayNode) {
                // Clear any previous selection logic to prevent conflicts
                //this.itemDetailPanel.set('selection', []); 
                this.itemDetailPanel.customDisplayNode.innerHTML = content;
            } else {
                this.itemDetailPanel.set('content', content);
            }
        },

        resize: function(){
            this.inherited(arguments);
            if (!window.GexfJS) return;

            // We resize based on the viewerPane (Center Region), not the whole widget
            if (!this.viewerPane || !this.viewerPane.domNode) return;

            var box = this.viewerPane.domNode.getBoundingClientRect();
            var footer = query(".WorkspaceController.dijitAlignBottom")[0];
            var footerHeight = footer ? domGeom.getMarginBox(footer).h : 0;
            var availH = window.innerHeight - box.top - footerHeight;

            if (availH > 0) {
                // Resize the DOM Node of the center pane
                domStyle.set(this.viewerPane.domNode, "height", availH + "px");
                
                // Update Canvas
                var carte = document.getElementById("carte");
                if (carte) {
                    carte.width = box.width;
                    carte.height = availH;
                }
                
                // Update GEXF internal state
                GexfJS.graphZone.width = box.width;
                GexfJS.graphZone.height = availH;
                delete GexfJS.oldParams.zoomLevel;
            }
        }
    });
});
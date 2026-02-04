define([
    "dojo/_base/declare", "dijit/layout/BorderContainer", "dijit/layout/ContentPane", 
    "dojo/_base/lang", "dojo/on", "dojo/topic", "dojo/request", "dojo/when",
    "../../WorkspaceManager", "../../util/PathJoin", 
    "dojo/query", "dojo/dom-geometry", "dojo/dom-style", "dojo/dom-construct",
    "../ActionBar", "../ItemDetailPanel", "../PerspectiveToolTip", "dojo/dom-class",
    "../SelectionToGroup", "dijit/Dialog" 

], function(
    declare, BorderContainer, ContentPane, 
    lang, on, Topic, xhr, when,
    WorkspaceManager, PathJoin, 
    query, domGeom, domStyle, domConstruct,
    ActionBar, ItemDetailPanel, PerspectiveToolTipDialog, domClass,
    SelectionToGroup, Dialog
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
            var typeString = (this.containerType === "feature_data") ? "genome_feature" : "genome";
            //records.forEach(function(rec) {
            //    rec.type = typeString; 
            //});
            // 1. Update ActionBar
            this.selectionActionBar.set("currentContainerType", this.containerType);
            this.selectionActionBar.set("selection", this.selection);
            this.itemDetailPanel.set("selection", this.selection);
            // 2. Prepare Data for HTML Construction
            
            // A. Helper to get attribute names from IDs (reverse GexfJS._node_attr_value)
            var nodeAttrIdToName = {};
            if (window.GexfJS && GexfJS._node_attr_value) {
                Object.keys(GexfJS._node_attr_value).forEach(function(name){
                    nodeAttrIdToName[GexfJS._node_attr_value[name]] = name;
                });
            }

            // --- NEW: Lookup Edge Attribute IDs for displayPath ---
            // We need to send the numeric ID (e.g., '5') not the name (e.g., 'genomes')
            var genomeAttrId = 'genomes'; // Default fallback
            var sequenceAttrId = 'sequences'; // Default fallback
            
            if (window.GexfJS && GexfJS._edge_attr_value) {
                if (GexfJS._edge_attr_value['genomes']) {
                    genomeAttrId = GexfJS._edge_attr_value['genomes'];
                }
                if (GexfJS._edge_attr_value['sequences']) {
                    sequenceAttrId = GexfJS._edge_attr_value['sequences'];
                }
            }
            // -----------------------------------------------------

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

            // C. Build Graph Links (Genomes / Sequences)
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
                    
                    // Genome Name Lookup
                    var genomeName = genomeId;
                    // Try to find a real name from the API records
                    var firstSeq = genomeSequences[0];
                    if(firstSeq && contigs[firstSeq][0] && recordMap[contigs[firstSeq][0]]){
                        genomeName = recordMap[contigs[firstSeq][0]].genome_name;
                    }

                    // Genome Link: Uses genomeAttrId (e.g. '5')
                    hierarchyHtml += '<div style="margin-top:5px;">';
                    hierarchyHtml += '<a href="javascript:void(0)" style="font-weight:bold;" onclick="window.displayPath(undefined, \'' + genomeId + '\', \'' + genomeAttrId + '\'); return false;">' + genomeName + '</a>:';
                    hierarchyHtml += '<div style="padding-left:10px;">';

                    Object.keys(contigs).forEach(function(contigId) {
                        // Sequence Link: Uses sequenceAttrId (e.g. '6')
                        hierarchyHtml += '<div><a href="javascript:void(0)" onclick="window.displayPath(undefined, \'' + contigId + '\', \'' + sequenceAttrId + '\'); return false;">' + contigId + '</a>:</div>';
                        
                        var features = contigs[contigId];
                        hierarchyHtml += '<div style="padding-left:10px; color:#666;">[' + features.join(', ') + ']</div>';
                    });
                    hierarchyHtml += '</div></div>';
                });
                hierarchyHtml += '</div>';

                // Summary Header
                var summaryHtml = '<div style="margin-bottom:10px; padding-bottom:5px; border-bottom:1px solid #ccc;">';
                summaryHtml += '<b><a href="javascript:void(0)" onclick="window.displayPath(undefined, \'' + allGenomes.join(',') + '\', \'' + genomeAttrId + '\'); return false;">Genomes[' + allGenomes.length + ']</a></b> ';
                summaryHtml += '<b><a href="javascript:void(0)" onclick="window.displayPath(undefined, \'' + allSequences.join(',') + '\', \'' + sequenceAttrId + '\'); return false;">Sequences[' + allSequences.length + ']</a></b> ';
                summaryHtml += '</div>';

                linksHtml = summaryHtml + hierarchyHtml;
            }

            // D. Neighbors (Optional: replicate "Neighbors" section)
            // This requires iterating edges, which can be expensive on large graphs. 
            // Only implement if strictly necessary.
            
            // 3. Assemble Content
            var content = '<div style="padding:10px;">';
            content += '<h3 style="margin-top:0; word-wrap:break-word;">' + node.label + '</h3>';
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
// In public/js/p3/widget/viewer/GEXFView.js

define([
    "dojo/_base/declare", "dijit/layout/ContentPane", "dojo/_base/lang",
    "dojo/on", "../../WorkspaceManager", "../../util/PathJoin", "dojo/when",
    "dojo/query", "dojo/dom-geometry", "dojo/dom-style"
], function(
    declare, ContentPane, lang,
    on, WorkspaceManager, PathJoin, when,
    query, domGeom, domStyle
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
        
        var scriptsToLoad = [
            '/vendor/gexf-js/js/jquery-2.0.2.min.js',
            '/vendor/gexf-js/js/jquery-ui-1.10.4.custom.min.js', // Reverted to Gexf.js version
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

    return declare([ContentPane], { 
        "baseClass": "GEXFView",
        "path": "",
        "file": null,
        _resizeHandle: null,

        templateString: `
            <div class="\${baseClass}" style="width: 100%; height: 100%; overflow: hidden;">
                <style>
                    /* Reset defaults to move panel to the right */
                    #zonecentre { top: 0 !important; left: 0 !important; }
                    
                    #overviewzone {
                        top: 50px !important;
                        left: 10px !important;
                        bottom: auto !important;
                        right: auto !important;
                        background: rgba(255,255,255,0.7);
                        border: 1px solid #999;
                    }

                    /* --- STRATEGY CHANGE: Neutralize the Titlebar Container --- */
                    /* Make it an invisible wrapper that doesn't restrict its children */
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

                    /* --- Position the Search Form Directly --- */
                    #recherche {
                        /* Anchor to Top Right of the Widget */
                        position: absolute !important;
                        top: 20px !important;
                        right: auto !important;
                        left: 240px !important;   /* Override legacy */
                        bottom: auto !important; /* Override legacy */
                        
                        /* Visuals */
                        display: block !important;
                        background: rgba(255,255,255,0.8); /* Semi-transparent background container */
                        padding: 5px;
                        border-radius: 4px;
                        
                        pointer-events: auto !important;
                        z-index: 2001 !important;
                    }

                    /* --- Force Input Visibility --- */
                    #searchinput, #searchsubmit {
                        /* CRITICAL: Turn off legacy absolute positioning */
                        position: static !important; 
                        float: none !important;
                        
                        /* Reset offsets so they don't fly away */
                        top: auto !important;
                        left: auto !important;
                        right: auto !important;
                        bottom: auto !important;
                        
                        /* Layout: Sit next to each other */
                        display: inline-block !important;
                        vertical-align: middle !important;
                        margin: 0 2px !important; /* Small gap between them */
                        
                        /* Interaction */
                        pointer-events: auto !important;
                        visibility: visible !important;
                        opacity: 1 !important;
                    }

                    /* Side Panel Styling */
                    #leftcolumn {
                        left: auto !important;
                        right: 0px !important;
                        border-right: none !important;
                        border-left: 1px solid #cdcdcd;
                        background-color: #f7f7f7;
                        z-index: 100;
                    }

                    #unfold {
                        left: -12px !important;
                        right: auto !important;
                        border-radius: 4px 0 0 4px;
                        border-right: none !important;
                        border-left: 1px solid #cdcdcd;
                    }
                    
                    #aUnfold { transform: rotate(180deg); }
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
                <div id="leftcolumn">
                    <div id="unfold"><a href="#" id="aUnfold" class="rightarrow"></a></div>
                    <div id="leftcontent"></div>
                </div>
                <div id="titlebar">
                    <div id="maintitle"><h1></h1></div>
                    <form id="recherche"><input id="searchinput" class="grey" autocomplete="off" /><input id="searchsubmit" type="submit" /></form>
                </div>
                <ul id="autocomplete"></ul>
            </div>
        `,

        postCreate: function(){
            this.inherited(arguments);
            this.watch("state", lang.hitch(this, "onSetState"));
        },

        startup: function(){
            if (this._started){ return; }
            this.inherited(arguments);
            this._resizeHandle = on(window, 'resize', lang.hitch(this, function(){ this.resize(); }));
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
                this.set("content", "<div>Loading GEXF file...</div>");
                WorkspaceManager.getObject(this.path, false).then(lang.hitch(this, function(res){
                    if (res && res.data){
                        this.set("content", this.templateString);
                        setTimeout(lang.hitch(this, function() { this.renderGraph(res.data); }), 50);
                    }
                }));
            }));
        },
        
        renderGraph: function(gexfXMLData){
            if (!window.startGraphViewer || !window.GexfJS) return;

            var box = this.domNode.getBoundingClientRect();
            var footer = query(".WorkspaceController.dijitAlignBottom")[0];
            var footerHeight = footer ? domGeom.getMarginBox(footer).h : 0;
            var availH = box.height - footerHeight;

            // Restore original API URLs from Gexf.js
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
            window.setInterval = function() { return 999; }; // Return dummy ID

            var gexf_dom = (new window.DOMParser()).parseFromString(gexfXMLData, "text/xml");
            startGraphViewer(gexf_dom);

            window.setInterval = originalSetInterval;

            // Fix Fold Button Animation for Right Side
            $("#aUnfold").off("click").click(function() {
                var isExpanded = $(this).hasClass("rightarrow");
                $("#leftcolumn").animate({ right: isExpanded ? "-250px" : "0px" }, 500);
                $(this).toggleClass("rightarrow").toggleClass("leftarrow");
                return false;
            });

            this.resize();
            GexfJS.timeRefresh = setInterval(window.traceMap, 60);
        },

resize: function(){
            this.inherited(arguments);
            if (!window.GexfJS) return;

            var box = this.domNode.getBoundingClientRect();
            var footer = query(".WorkspaceController.dijitAlignBottom")[0];
            var footerHeight = footer ? domGeom.getMarginBox(footer).h : 0;

            // --- FIX: Use window.innerHeight to prevent shrinking loop ---
            // Calculate height based on the Viewport, not the current Element height.
            // Window Height - Top of Widget - Footer Height = Exact space available.
            var availH = window.innerHeight - box.top - footerHeight;
            // -------------------------------------------------------------

            if (availH > 0) {
                domStyle.set(this.domNode, "height", availH + "px");
                var carte = document.getElementById("carte");
                if (carte) {
                    carte.width = box.width;
                    carte.height = availH;
                }
                GexfJS.graphZone.width = box.width;
                GexfJS.graphZone.height = availH;
                delete GexfJS.oldParams.zoomLevel;
            }
        }

    });
});
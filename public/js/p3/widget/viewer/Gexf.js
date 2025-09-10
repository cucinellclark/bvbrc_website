// In public/js/p3/widget/viewer/GEXFView.js

define([
    "dojo/_base/declare", "dijit/layout/ContentPane", "dojo/_base/lang",
    "dojo/on", "../../WorkspaceManager", "../../util/PathJoin", "dojo/when"
], function(
    declare, ContentPane, lang,
    on, WorkspaceManager, PathJoin, when
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
            var link = document.createElement('link');
            link.rel = 'stylesheet';
            link.type = 'text/css';
            link.href = href;
            document.getElementsByTagName('head')[0].appendChild(link);
        });
        var scriptsToLoad = [
            '/vendor/gexf-js/js/jquery-2.0.2.min.js',
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

    return declare([ContentPane], { // Extends ContentPane to fill the page
        "baseClass": "GEXFView",
        "path": "",
        "file": null,

        templateString: `
            <div class="\${baseClass}" style="width: 100%; height: 100%; overflow: hidden;">
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
        // --- END TEMPLATE ---


        _updateState: function(attr, oldVal, state){
            // This is our new central controller function.
            // It's called on startup AND on any subsequent state change.

            if (!state || !state.search) {
                console.error("GEXF Viewer: State or search parameters are missing.");
                this.set("content", "<div class='error'>Error: Invalid URL State.</div>");
                return;
            }

            var params = new URLSearchParams(state.search);
            var workspacePath = params.get('path');

            if (workspacePath) {
                // We have a valid path, let's load and render the graph.
                this.loadAndRender(workspacePath);
            } else {
                console.error("GEXF Viewer: 'path' parameter not found in URL.", state.search);
                this.set("content", "<div class='error'>Error: 'path' parameter missing from URL.</div>");
            }
        },
        onSetState: function(attr, oldVal, state){
            // This is the main entry point called by the router.
            // The state object now contains the path in its 'search' property.
            if (!state || !state.search) {
                console.error("GEXF Viewer: State or search parameters are missing.");
                return;
            }

            // Use the standard URLSearchParams API to easily parse the query string.
            // state.search will look like "?&path=/anwarren@...".
            var params = new URLSearchParams(state.search);

            // Get the value of the 'path' parameter we put in the URL.
            var workspacePath = params.get('path');

            if (workspacePath) {
                // Now that we have the clean path, we set it on the widget.
                this.set("path", workspacePath);
            } else {
                console.error("GEXF Viewer: 'path' parameter not found in URL.", state.search);
            }
        },

        _setPath: function(path){
            this.path = path;

            var file_meta = {
                path: this.path,
                name: this.path.split('/').pop()
            };
            this.set("file", file_meta);
        },

        // _setFileAttr is now just a simple setter, not responsible for logic.
        _setFileAttr: function(file){
            this.file = file;
            if (this._started){
                this.loadAndRender();
            }
        },

        loadAndRender: function(path) {
            // Load all scripts, then fetch data and render
            this.path = path; // Set the path for reference

            loadGexfDependencies(lang.hitch(this, function() {
                if (this.path){
                    // Show a temporary loading message
                    this.set("content", "<div>Loading GEXF file...</div>");
                    WorkspaceManager.getObject(this.path, false).then(lang.hitch(this, function(res){
                        if (res && res.data){
                            // Now that data is loaded, replace the loading message with the real viewer template
                            this.set("content", this.templateString);
                            // Call renderGraph after a very short delay to allow the DOM to be created
                            setTimeout(lang.hitch(this, function() {
                                this.renderGraph(res.data);
                            }), 0);
                        } else {
                            this.set("content", "<div class='error'>Error: Could not retrieve GEXF file content.</div>");
                        }
                    }));
                }
            }));
        },

        renderGraph: function(gexfXMLData){
            if (!window.startGraphViewer) { 
                console.error("startGraphViewer() is not available. gexfjs.js may not have loaded correctly.");
                return; 
            }
            var gexf_dom = (new window.DOMParser()).parseFromString(gexfXMLData, "text/xml");
            startGraphViewer(gexf_dom);
        },
        
        postCreate: function(){
            this.inherited(arguments);
            this.watch("state", lang.hitch(this, "onSetState"));
        },

        startup: function(){
            if (this._started){ return; }
            this.inherited(arguments);
            this._updateState(null, null, this.state);
        }
    });
});
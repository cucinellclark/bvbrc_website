define([
    "dojo/_base/declare", "dijit/_WidgetBase", "dijit/_TemplatedMixin",
    "dojo/on", "dojo/_base/lang", "../../WorkspaceManager",
    "dojo/dom-construct", "dojo/dom-style", "dojo/when",
    "../../util/PathJoin", 
    "dojo/text!/vendor/gexf-js/js/gexfjs.js" // Load the script code as text
], function(
    declare, WidgetBase, Templated,
    on, lang, WorkspaceManager,
    domConstruct, domStyle, when,
    PathJoin,
    gexfjsCode // The script is now in this string
){
    // Helper to ensure the legacy script is loaded only once into the global scope
    var gexfLoaded = false;
    var loadGexfJs = function() {
        if (gexfLoaded) { return; }
        try {
            var script = document.createElement('script');
            script.type = 'text/javascript';
            script.text = gexfjsCode;
            document.getElementsByTagName('head')[0].appendChild(script);
            gexfLoaded = true;
        } catch(e) {
            console.error("GEXF-JS loading error:", e);
        }
    };

    return declare([WidgetBase, Templated], {
        baseClass: "GEXFViewer",

        // The HTML template with all the required IDs for gexfjs.js
        templateString: `
            <div class="\${baseClass}" style="width: 100%; height: 100%;">
                <div id="zonecentre" class="gradient" style="position: relative; width: 100%; height: 100%;">
                    <canvas id="carte" data-dojo-attach-point="canvasNode" width="0" height="0"></canvas>
                    <ul id="ctlzoom">
                        <li><a href="#" id="zoomPlusButton"></a></li>
                        <li id="zoomSliderzone"><div id="zoomSlider"></div></li>
                        <li><a href="#" id="zoomMinusButton"></a></li>
                        <li><a href="#" id="lensButton"></a></li>
                        <li><a href="#" id="edgesButton"></a></li>
                    </ul>
                </div>
                <div id="overviewzone" class="gradient">
                    <canvas id="overview" data-dojo-attach-point="overviewNode" width="0" height="0"></canvas>
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
        file: null, // This will be the workspace object for the GEXF file

        postCreate: function(){
            this.inherited(arguments);
            loadGexfJs(); // Ensure the global functions like startGraphViewer are available
        },

        startup: function(){
            if (this._started) { return; }
            this.inherited(arguments);

            // The 'file' property can be a promise, so we use when() to handle it
            when(this.file, lang.hitch(this, function(file_meta){
                if (file_meta && file_meta.path){
                    var fullPath = PathJoin(file_meta.path, file_meta.name);
                    // Use getObject() to fetch the file content directly
                    WorkspaceManager.getObject(fullPath, false).then(lang.hitch(this, function(res){
                        if (res && res.data){
                            this.renderGraph(res.data);
                        } else {
                            console.error("GEXF Viewer: Could not retrieve file content.");
                        }
                    }));
                } else {
                    console.error("GEXF Viewer: File object or path is missing.");
                }
            }));
        },

        renderGraph: function(gexfXMLData){
            // This function is the new entry point that calls the legacy code.
            if (!window.startGraphViewer) {
                console.error("gexfjs.js did not load correctly or startGraphViewer is not global.");
                return;
            }

            // Before calling the viewer, we must ensure the DOM from our template is ready and sized.
            // gexfjs.js directly manipulates DOM elements by ID.
            this.resize();

            // The 'data' parameter for startGraphViewer should be the raw GEXF XML string.
            // The old code did `x=(new window.DOMParser()); res=x.parseFromString(res.graph, "text/xml");`
            // This suggests the API was returning JSON with an XML string inside. Here, res.data IS the XML string.
            var gexf_dom = (new window.DOMParser()).parseFromString(gexfXMLData, "text/xml");

            // Now, call the global function from gexfjs.js with the parsed XML document
            startGraphViewer(gexf_dom);
        },

        resize: function(){
            this.inherited(arguments);
            // gexfjs.js has a function to handle resizing, let's call it.
            if (window.updateWorkspaceBounds){
                updateWorkspaceBounds();
            }
        }
    });
});
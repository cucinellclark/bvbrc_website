define([
  'dojo/_base/declare', './Base', 'dijit/layout/ContentPane', 'dojo/dom-construct', 'dojo/dom-style',
  'dijit/form/Button', 'dojo/on', 'dojo/dom-class', 'dojo/_base/lang', 'dojo/request/xhr'
], function (
  declare, ViewerBase, ContentPane, domConstruct, domStyle,
  Button, on, domClass, lang, xhr
) {

  return declare([ViewerBase], {
    baseClass: 'RadicalPilotViewer',

    postCreate: function () {
      this.inherited(arguments);

      // Create the main container with grid layout
      this.mainContainer = new ContentPane({
        region: 'center',
        style: 'padding: 10px; display: grid; grid-template-rows: auto 1fr; gap: 10px; height: 100%;'
      });

      // Create the top area with Execute button
      this.topArea = new ContentPane({
        style: 'display: flex; align-items: center; justify-content: center; padding: 10px; background-color: #f5f5f5; border-radius: 5px;'
      });

      // Create the Execute button
      this.executeButton = new Button({
        label: 'Execute',
        style: 'font-size: 16px; padding: 10px 20px;',
        onClick: lang.hitch(this, 'onExecute')
      });

      // Create the bottom area for output
      this.bottomArea = new ContentPane({
        style: 'padding: 10px; background-color: #ffffff; border: 1px solid #ddd; border-radius: 5px; overflow-y: auto; font-family: monospace;'
      });

      // Add components to the main container
      this.topArea.addChild(this.executeButton);
      this.mainContainer.addChild(this.topArea);
      this.mainContainer.addChild(this.bottomArea);

      // Add the main container to the viewer
      this.addChild(this.mainContainer);
    },

    onExecute: function () {
      // Clear previous output
      this.bottomArea.set('content', '');

      // Show initial status
      var outputText = 'RadicalPilot Execution Started...\n';
      outputText += 'Timestamp: ' + new Date().toLocaleString() + '\n';
      outputText += 'Status: Initializing workflow...\n';
      outputText += 'URL: https://95.217.193.116:8000/\n\n';

      this.bottomArea.set('content', '<pre>' + outputText + '</pre>');

      // Execute the full RadicalPilot workflow
      this.executeRadicalPilotWorkflow();
    },

    executeRadicalPilotWorkflow: function() {
      var self = this;
      var cid = null;
      var tids = [];
      var baseUrl = 'https://95.217.193.116:8000';

      // Step 1: Register client
      this.appendOutput('Step 1: Registering client...\n');
      xhr(baseUrl + '/register_client', {
        method: 'POST',
        handleAs: 'json',
        timeout: 30000,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      }).then(function(response) {
        cid = response.cid;
        self.appendOutput('register_client -> ' + response.status + ' ' + JSON.stringify(response) + '\n\n');

        // Step 2: GET echo example
        return xhr(baseUrl + '/api/echo/' + cid, {
          method: 'GET',
          handleAs: 'json',
          timeout: 30000,
          query: { q: 'from-client' },
          headers: {
            'Accept': 'application/json'
          }
        });
      }).then(function(response) {
        self.appendOutput('Step 2: Testing echo...\n');
        self.appendOutput('GET /api/echo/' + cid + ' -> ' + response.status + ' ' + JSON.stringify(response) + '\n\n');

        // Step 3: Submit a pilot
        return xhr(baseUrl + '/api/pilot_submit/' + cid, {
          method: 'POST',
          handleAs: 'json',
          timeout: 30000,
          data: JSON.stringify({
            resource: 'local.localhost',
            nodes: 10,
            runtime: 10
          }),
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }
        });
      }).then(function(response) {
        self.appendOutput('Step 3: Submitting pilot...\n');
        self.appendOutput('POST /api/pilot_submit/' + cid + ' -> ' + response.status + ' ' + JSON.stringify(response) + '\n\n');

        // Step 4: Submit tasks
        self.appendOutput('Step 4: Submitting tasks...\n');
        var taskPromises = [];
        for (var i = 0; i < 10; i++) {
          var taskPromise = xhr(baseUrl + '/api/task_submit/' + cid, {
            method: 'POST',
            handleAs: 'json',
            timeout: 30000,
            data: JSON.stringify({
              executable: 'date'
            }),
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            }
          }).then(function(response) {
            var tid = response.tid;
            tids.push(tid);
            self.appendOutput('POST /api/task_submit/' + cid + ' -> ' + response.status + ' ' + JSON.stringify(response) + '\n');
            return tid;
          });
          taskPromises.push(taskPromise);
        }

        return Promise.all(taskPromises);
      }).then(function() {
        self.appendOutput('\nStep 5: Waiting for tasks to complete...\n');

        // Step 5: Wait for tasks
        var waitPromises = tids.map(function(tid) {
          return xhr(baseUrl + '/api/task_wait/' + cid + '/' + tid, {
            method: 'GET',
            handleAs: 'json',
            timeout: 60000,
            headers: {
              'Accept': 'application/json'
            }
          }).then(function(response) {
            var ret = response.task.stdout.trim();
            self.appendOutput('GET /api/task_wait/' + cid + '/' + tid + ' -> ' + response.status + ' ' + ret + '\n');
            return response;
          });
        });

        return Promise.all(waitPromises);
      }).then(function() {
        // Step 6: Unregister client
        self.appendOutput('\nStep 6: Unregistering client...\n');
        return xhr(baseUrl + '/unregister_client/' + cid, {
          method: 'POST',
          handleAs: 'json',
          timeout: 30000,
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          }
        });
      }).then(function(response) {
        self.appendOutput('unregister_client -> ' + response.status + ' ' + JSON.stringify(response) + '\n\n');
        self.appendOutput('RadicalPilot workflow completed successfully!\n');
        self.appendOutput('End Time: ' + new Date().toLocaleString() + '\n');
      }).catch(function(error) {
        self.appendOutput('\nError occurred during workflow execution:\n');
        self.appendOutput('Error: ' + (error.message || error.toString() || error) + '\n');

        // Try to get more error details from XMLHttpRequest
        var status = 'Unknown';
        var errorDetails = [];
        var xhr = null;

        if (error.response) {
          status = error.response.status;
          errorDetails.push('Response status: ' + status);

          // Get the actual XMLHttpRequest object
          if (error.response.xhr) {
            xhr = error.response.xhr;
            errorDetails.push('XHR readyState: ' + xhr.readyState);
            errorDetails.push('XHR status: ' + xhr.status);
            if (xhr.statusText) {
              errorDetails.push('XHR statusText: ' + xhr.statusText);
            }

            // Check for specific error conditions
            if (xhr.status === 0) {
              // Status 0 can mean different things - try to determine which
              if (xhr.readyState === 0) {
                errorDetails.push('Request never sent (readyState 0)');
              } else if (xhr.readyState === 4) {
                errorDetails.push('Request completed but no response (readyState 4, status 0)');
                // This is typically CORS or network error
                self.appendOutput('\n⚠️ DIAGNOSIS: Request reached readyState 4 with status 0\n');
                self.appendOutput('This almost always indicates a CORS (Cross-Origin) issue.\n');
                self.appendOutput('The server at ' + (error.response.url || error.url || 'the server') + '\n');
                self.appendOutput('needs to send CORS headers to allow browser requests.\n\n');
              }
            }
          }

          if (error.response.url) {
            errorDetails.push('URL: ' + error.response.url);
          }
        } else if (error.status !== undefined) {
          status = error.status;
          errorDetails.push('Error status: ' + status);
        }

        if (error.url) {
          errorDetails.push('URL: ' + error.url);
        }

        // Log error details
        if (errorDetails.length > 0) {
          self.appendOutput('Details: ' + errorDetails.join(', ') + '\n');
        }

        self.appendOutput('Status: ' + status + '\n');

        if (status === 0 || status === 'Unknown') {
          self.appendOutput('\nStatus 0 typically indicates:\n');
          self.appendOutput('1. CORS issue - Check server CORS headers (MOST LIKELY)\n');
          self.appendOutput('   The server must send: Access-Control-Allow-Origin header\n');
          self.appendOutput('   Required headers:\n');
          self.appendOutput('     Access-Control-Allow-Origin: * (or your domain)\n');
          self.appendOutput('     Access-Control-Allow-Methods: GET, POST, OPTIONS\n');
          self.appendOutput('     Access-Control-Allow-Headers: Content-Type, Accept\n');
          self.appendOutput('2. SSL certificate not trusted by browser\n');
          self.appendOutput('   Check browser security settings and certificate trust\n');
          self.appendOutput('3. Network/connection error\n');
          self.appendOutput('   Verify the server is accessible from your browser\n');
          self.appendOutput('4. Request blocked by browser security\n');
          self.appendOutput('\nTroubleshooting steps:\n');
          self.appendOutput('1. Open browser Developer Tools (F12)\n');
          self.appendOutput('2. Go to Network tab and look for the failed request\n');
          self.appendOutput('3. Click on the request and check:\n');
          self.appendOutput('   - Request Headers (what was sent)\n');
          self.appendOutput('   - Response Headers (CORS headers present?)\n');
          self.appendOutput('   - Preview/Response tab (any error message?)\n');
          self.appendOutput('4. Check Console tab for CORS error messages\n');
          self.appendOutput('5. Try accessing the URL directly in browser address bar\n');
          self.appendOutput('6. Contact server administrator to add CORS headers\n');
        }
        self.appendOutput('\nPlease check the browser console (F12) for more details.\n');

        // Also log to console for debugging with full xhr details
        console.error('RadicalPilot Error:', error);
        if (error.response) {
          console.error('Response:', error.response);
          if (xhr) {
            console.error('XMLHttpRequest details:', {
              readyState: xhr.readyState,
              status: xhr.status,
              statusText: xhr.statusText,
              responseText: xhr.responseText,
              responseURL: xhr.responseURL,
              withCredentials: xhr.withCredentials
            });
          }
        }
      });
    },

    appendOutput: function(text) {
      var currentContent = this.bottomArea.get('content');
      var newContent = currentContent.replace('<pre>', '').replace('</pre>', '') + text;
      this.bottomArea.set('content', '<pre>' + newContent + '</pre>');
    },

    startup: function () {
      if (this._started) {
        return;
      }
      this.inherited(arguments);
    }
  });
});

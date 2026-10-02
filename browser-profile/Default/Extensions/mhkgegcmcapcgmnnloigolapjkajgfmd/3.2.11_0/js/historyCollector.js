
HistoryCollector = function() {
    this.port = null;
    this.response_listener = this.onResponseStarted.bind(this);
    this.tab_removed_listener = this.onTabRemoved.bind(this);

    this.initialize();
}

// Called when a tab's history should be recorded
HistoryCollector.prototype.recordHistory = function(tabId, url, timeStamp, details) {
    //webHistory for Tab Details
    
     console.log("recordHistory called for tabId: ", tabId, " url: ", url, " timeStamp: ", timeStamp, " details: ", details);
    
    if (tabId != -1 && this.port.webmetering) {
        if (!webHistory[tabId]) {
            webHistory[tabId] = {};
        }

        if (!webHistory[tabId][url]) {
            webHistory[tabId] = {}; 	// for specific functionality
            webHistory[tabId][url] = {
                firstAccessed: timeStamp,
                title: ""
            };

            let datatobepost = {};
            if (webHistory[tabId]) {
                datatobepost = { ...webHistory[tabId] };
                datatobepost.tabId = tabId;
                datatobepost.internalcmd = "Update";    //No I18N
            } else {
                datatobepost.closedTime = Date.now();
                datatobepost.tabId = tabId;
                datatobepost.internalcmd = "Update";    //No I18N
            }

            this.port.posttabWebHistoryUpdate(datatobepost, null);

        } else {
            console.log("webHistory send by onActivated Tab. No need to send again !!!");
        }
    }
    //webHistory for Tab Details END
    
    var historyObject = {};
    var a = new Date(timeStamp);
    historyObject.url = url;
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname ? urlObj.hostname : "";
        const protocol = urlObj.protocol ? urlObj.protocol : "";
        if (hostname && protocol) {
           historyObject.domain = `${protocol}//${hostname}`;
        }
    } catch (err) {

    }
    historyObject.lastVisitTime = a.getTime();
    historyObject.title = "";
    historyObject.tabId = tabId;
    this.port.postHistoryItem(historyObject, null);

    if (details && details.ip){
        historyObject.ip = details.ip;
    }

    if (details && details.statusCode) {
        historyObject.statusCode = details.statusCode;
    }

    // ── Emit OCSF event via EventQueue (unified telemetry) ──
    if (typeof EventQueue === "function") {
        var eq = new EventQueue();

        eq.emitHttpComplete(historyObject);
    }

}

// webRequest.onResponseStarted handler
// Rule 0: preload/speculation requestId (detected by routingLogic.js) → skip
// Rule 1: non-2XX → don't record
// Rule 2: prerender → skip (handled via fromTab path when tabs.onUpdated fires)
// Rule 3: active + 2XX → send to nativehost
HistoryCollector.prototype.onResponseStarted = function(details) {
    
    // Rule 0: Skip requests identified as preload/prefetch/speculation by routingLogic.js
    if (preloadRequestIds[details.requestId]) {
        delete preloadRequestIds[details.requestId];
        return;
    }

    // Non-2XX: don't record
    if (details.statusCode < 200 || details.statusCode >= 300) {
        return;
    }
    
    // Prerender — skip, will be handled via fromTab path
    if (details.documentLifecycle === "prerender") {
        return;
    }

    this.recordHistory(details.tabId, details.url, details.timeStamp, details);
}

// Clean up on tab close
HistoryCollector.prototype.onTabRemoved = function(tabId) {
    delete WebRequestCaptured[tabId];
}

HistoryCollector.prototype.initialize = function() {
    BROWSER.webRequest.onResponseStarted.addListener(
        this.response_listener,
        {urls: ['http://*/*', 'https://*/*'], types: ['main_frame']},	 //No I18N
    );
    BROWSER.tabs.onRemoved.addListener(this.tab_removed_listener);
    this.port = new Port(null, null, 3, this.historyListener.bind(this));
}

HistoryCollector.prototype.historyListener = function(flag) {
    if(flag == true) 
    {
        if (BROWSER.webRequest.onResponseStarted.hasListener(this.response_listener) == false) {
            BROWSER.webRequest.onResponseStarted.addListener(
                this.response_listener,
                {urls: ['http://*/*', 'https://*/*'], types: ['main_frame']}	 //No I18N
            );
        }
        if (BROWSER.tabs.onRemoved.hasListener(this.tab_removed_listener) == false) {
            BROWSER.tabs.onRemoved.addListener(this.tab_removed_listener);
        }
    }
    else
    {
        if (BROWSER.webRequest.onResponseStarted.hasListener(this.response_listener) == true) {
            BROWSER.webRequest.onResponseStarted.removeListener(this.response_listener);
        }
        if (BROWSER.tabs.onRemoved.hasListener(this.tab_removed_listener) == true) {
            BROWSER.tabs.onRemoved.removeListener(this.tab_removed_listener);
        }
    }

    setTitle("This extension tracks your web activity in compliance with your organization's policy.",flag);   //No I18N

}

setTitle = function(title,flag) 
{
    try {
        if(flag)
        {
            BROWSER.action?.setTitle? BROWSER.action.setTitle({ title: title+"\n" })    //No I18N
            : BROWSER.browserAction?.setTitle({ title: title }); //for Firefox
        }
        else
        {
            BROWSER.action?.setTitle? BROWSER.action.setTitle({ title: "" })    //No I18N
            : BROWSER.browserAction?.setTitle({ title: "" });    //No I18N
        }
    } catch(e) { 
        console.error("setTitle error: " + e.message); //No I18N
    }
}

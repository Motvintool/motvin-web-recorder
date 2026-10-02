//cross-platform check using chrome.runtime API
const browserIdentifier = chrome.runtime.getURL("manifest.json") //No I18N
const chromeIndex = browserIdentifier.indexOf("chrome-extension://")
const mozIndex = browserIdentifier.indexOf("moz-extension://")
const extensionId = chrome.runtime.id;

var BROWSER = ""
var BROWSERTYPE = ""
var isBrowserStartup = false

if(chromeIndex != -1)
{
	BROWSER = chrome
}
else if(mozIndex != -1)
{
	BROWSER = browser
}
if (extensionId === "bdgkacbeblomgnaoildjnppjkamgoogc") {
    BROWSERTYPE = "EDGE";	//No I18N
}

var overRidedPageDetails = {}
var preloadRequestIds = {};
var WebRequestCaptured = {};
var webHistory = {};
// Tracks fromTab tabs waiting for model (scrapeAndIgnore) final decision.
// Set by routingLogic when response is scrappageandignore + fromTab,
// consumed when the postDOMContent response arrives.
var fromTabModelPending = {};
// Global reference so routingLogic can call recordHistory() on the fromTab path
var historyCollectorInstance = null;
self.importScripts('data.js', 'zlabs-phishing.min.js','nativePort.js', 'browserSettings.js', 'filenamedetector.js','downloadManager.js', 'contentPort.js', 'historyCollector.js', 'webMetering.js', 'eventQueue.js', 'routingLogic.js');//No I18N
registerListeners();
function registerListeners () {
	var browserRouter = new ExtensionLogic();
	var downloadManager = new DownloadManager();
	historyCollectorInstance = new HistoryCollector();
	var webMetering = new WebMetering();
    var contentPort = new ContentPort();
	var browserSettings = new BrowserSettings();
}

//startup event lisetening
chrome.runtime.onStartup.addListener(function(details){
	isBrowserStartup = true;
})

// ── Ephemeral Session: Extension action (toolbar icon) click ──
function clearBSPIncognitoPopup() {
    chrome.action.setPopup({ popup: "" }); //No I18N
}

function showBSPIncognitoPopup() {
    chrome.action.setPopup({ popup: "bsp_incognito.html" }, function() { //No I18N
        if (!chrome.action.openPopup) {
            clearBSPIncognitoPopup();
            return;
        }

        try {
            var popupResult = chrome.action.openPopup();
            if (popupResult && typeof popupResult.catch === "function") { //No I18N
                popupResult.catch(clearBSPIncognitoPopup);
            }
        } catch (e) {
            clearBSPIncognitoPopup();
        }
    });
}

chrome.action.onClicked.addListener(function() {
	var port = Port.instance;
    if (port && !port.incognitoSessionLaunched) {
        port.getBSPIncognitoEligibility(function(response) {
            if (response && response.success && response.enabled === true) {
                showBSPIncognitoPopup();
            }
        });
    }
});

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (!message || !message.action) {
        return false;
    }

    if (message.action === "clearBSPIncognitoPopup") { //No I18N
        clearBSPIncognitoPopup();
        sendResponse({ success: true });
        return false;
    }

    if (message.action === "getBSPIncognitoEligibility") { //No I18N
        var eligibilityPort = Port.instance;
        if (!eligibilityPort) {
            sendResponse({ success: false, error: "Native host is not connected" }); //No I18N
            return false;
        }
        eligibilityPort.getBSPIncognitoEligibility(function(response) {
            sendResponse(response || { success: false, error: "No native response" }); //No I18N
        });
        return true;
    }

    if (message.action !== "openBSPIncognito") { //No I18N
        return false;
    }

    var port = Port.instance;
    if (!port) {
        sendResponse({ success: false, error: "Native host is not connected" }); //No I18N
        return false;
    }

    port.launchIncognitoSession(function(response) {
        sendResponse(response || { success: false, error: "No native response" }); //No I18N
    });
    return true;
});

//this is chrome only & adding this here
function phishingEngine()
{
	// console.log("Phishing Engine is running")
    var port = Port.instance;
    if(port.PhishingEnabled)
    {
		// console.log("check is phish : ",check_phish)
        let target = "<all_urls>"; //No I18N
        chrome.webNavigation.onErrorOccurred.addListener(errorHandlingFun,{urls: [target]});
        function errorHandlingFun(details)
        {
			// console.log("Error Handling Function is running")
            if(details.error ==='net::ERR_BLOCKED_BY_CLIENT')   //No I18N
            {
				// console.log("Blocked by client")
                chrome.tabs.get(details.tabId,function(tabdetails)
                {
                    if(tabdetails.title === 'Security error')
                    {
						// console.log("Security error")
                        port.postContentBody('SAFEBROWSING', tabdetails.url, details.tabId, Port);  //No I18N
                    }
                });
            }
        }
    }
    else
    {
        if(chrome.webNavigation.onErrorOccurred.hasListeners())
        {
            chrome.webNavigation.onErrorOccurred.removeListener(errorHandlingFun);
        }
    }
}



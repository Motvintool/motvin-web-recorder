ContentPort = function() {
	this.contentPort = {};
	this.tabID = null;
	this.port = null;
	this.requestdata = {};
	this.initialize();
}

ContentPort.prototype.connectCallback = function(contentScriptPort){

	if(contentScriptPort.sender.tab){
		this.tabID = contentScriptPort.sender.tab.id;
		this.contentPort[this.tabID] = contentScriptPort;

        if (messageToTab[this.tabID]) {
            if (messageToTab[this.tabID].action !== undefined) {
				BROWSER.tabs.sendMessage(this.tabID, messageToTab);
            }
        }

		contentScriptPort.onDisconnect.addListener(this.disconnectContentScript.bind(this, this.tabID));
	}
}

ContentPort.prototype.contentFilterCallback = function(request, sender, sendResponse)	
{	
	if (request && request.action && (request.action === "openBSPIncognito" || request.action === "clearBSPIncognitoPopup" || request.action === "getBSPIncognitoEligibility")) { //No I18N
		return false;
	}

	//Send True only if the domain is GENAI, else return false
	if (request.Request === "GenAIPIIBlockerConfig") {                     //No I18N
		var genaiConfig = { policyMode: -1 };
		if (this.port && typeof this.port.genaiDlpProtection !== "undefined") {
			if (this.port.genaiDlpProtection !== -1)
			{
				var url = sender.url;
				const hostname = new URL(url).hostname;
				let domainToVerify = hostname.startsWith("www.") //No I18N
					? hostname.slice(4)
					: hostname;

				if (this.port.GenAIDomains.includes(domainToVerify))
				{
					genaiConfig.policyMode = this.port.genaiDlpProtection;
				}
			}

		}
	
		sendResponse(genaiConfig);
	}

	// ── GenAI PII Blocker: content script reports a PII violation ──
	else if (request.Request === "GenAIPIIViolation") {                         //No I18N
		// Notify the native host for audit logging
		if (this.port) {
			this.port.postGenAIPIIViolation(request, sender.url);
		}
	}

	// ── ClickFix / PasteJack / Clickjacking detection ──
	else if (request.Request === "ClickFixDetection") {                         //No I18N
		// 1. Emit OCSF Security Finding event via EventQueue (BDR report)
		if (typeof EventQueue === "function") {
			var eq = new EventQueue();
			eq.emitClickFixDetection(request);
		}

		// Audit data for ClickFix violations
		// if (this.port) {
		// 	this.port.postClickFixViolation(request, sender.url);
		// } 

		sendResponse({ received: true, threat_type: request.threat_type });
	}
	else if (request.Request === "ClickFixCopiedData") {                        //No I18N
		if (typeof EventQueue === "function") {
			var eq = new EventQueue();
			if (typeof eq.emitClickFixCopiedData === "function") {
			    eq.emitClickFixCopiedData(request);
			}
		}

		//Audit data for ClickFix copied data
		// if (this.port && typeof this.port.postClickFixCopiedData === "function") {
		// 	this.port.postClickFixCopiedData(request, sender.url);
		// } 
		sendResponse({ received: true });
	}
	else if (request.Request === "EmailCaptureConfig") {                        //No I18N // ── Email capture: content script asks for enterprise domain config ──
		var domains = [];
		if (typeof EventQueue === "function") {
			var eq = new EventQueue();
			domains = eq.getEnterpriseDomains();
		} else if (typeof _enterpriseDomains !== "undefined" && _enterpriseDomains.length > 0) {
			domains = _enterpriseDomains;
		}
		sendResponse({ domains: domains });
		return;
	}

	// ── Email capture: content script reports captured enterprise emails ──
	else if (request.Request === "EmailCaptured") {                         //No I18N
		if (typeof EventQueue === "function") {
			var eq = new EventQueue();
			eq.emitEmailCapture(request);
		} else if (this.port) {
			this.port.postEmailCapture(request);
		}
		sendResponse({ success: true });
		return;
	}

	//worst case handle. Need to define Request Type & handle all type of request accordingly
	else if (request.actiontype === "UploadBlock") {
        if (sender.tab && sender.tab.id) {
			this.requestdata = request;
            this.sendMessage(sender.tab.id);
			this.port.postBlockedUploadData(request, sender.tab.id, sender.url, null);
        } 

		// ── Emit OCSF event: Upload Blocked ──
		if (typeof EventQueue === "function") {
			var eq = new EventQueue();
			eq.emitUploadBlocked(request, sender.url);
		}

        sendResponse({ success: true });
    }
	else{
		if(request.Request != undefined && request.Request == "UploadCheck")	//No I18N
		{
			sendResponse({
				"s": this.port.check_upload,	//No I18N
				"rule_json" : this.port.ruleJSON	//No I18N
			});
		}
		else if(request.Request != undefined && request.Request == "overridepage"){
			this.port.postOverRideDetails(request.overriddenDetails, null)
			overRidedPageDetails[request.overriddenDetails.tabId] = request.overriddenDetails
			BROWSER.tabs.update(request.overriddenDetails.tabId, {url: request.overriddenDetails.url});
		}
		else if(request.Request != undefined && request.Request == "FFAgreeStatus")
		{
			//console.log("Handled in ConsentHandler by Firefox Background JS");
			return;
		}
		else{
			this.port.postUploadData(request, sender.tab.id, sender.url, null);

			// ── Emit OCSF event via EventQueue (unified telemetry) ──
			if (typeof EventQueue === "function") {
				var eq = new EventQueue();
				eq.emitUploadActivity(request, sender.url);
			}
		}
	}
}

ContentPort.prototype.disconnectContentScript = function(id){
	delete this.contentPort[id];
}

ContentPort.prototype.initialize = function(){
	this.port = new Port();
	BROWSER.runtime.onConnect.addListener(this.connectCallback.bind(this));
	BROWSER.runtime.onMessage.addListener(this.contentFilterCallback.bind(this));
}

ContentPort.prototype.sendMessage = function(id){
	var message = this.requestdata;
	message.actiontype = "Upload"; //No I18N

	BROWSER.tabs.query({active: true, currentWindow: true}, function(tabs) {
		BROWSER.tabs.sendMessage(id, {action:"cancelUpload",message:message});	//No I18N
	});
}

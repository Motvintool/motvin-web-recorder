/**
 * eventQueue.js — OCSF 1.3.0 Event Formatter + FastQ Transport Layer
 *
 * This module does NOT register its own browser API listeners.
 * Instead, the existing BSP handlers (routingLogic.js) call the
 * emit*() methods below to produce OCSF-compliant JSON, which is
 * batched and sent to the native host for FastQ persistence.
 *
 * ─── OCSF class mapping ───────────────────────────────────────
 *  emitHttpComplete()         → HTTP Activity        (4002) — website accessed
 *  emitWebFilterBlocked()     → HTTP Activity        (4002) — webfilter blocked
 *  emitDownloadActivity()     → HTTP Activity        (4002) — file download
 *  emitDownloadBlocked()      → HTTP Activity        (4002) — download blocked
 *  emitUploadActivity()       → HTTP Activity        (4002) — upload done
 *  emitUploadBlocked()        → HTTP Activity        (4002) — upload blocked
 *  emitExtensionLifecycle()   → Application Lifecycle(6002)
 *  emitEmailCapture()         → Web Resources Act.   (6001)
 * ──────────────────────────────────────────────────────────────
 *
 * Usage:
 *   self.importScripts('eventQueue.js');
 *   var eq = new EventQueue();
 *   eq.setPort(port);
 *   eq.setEnabled(true);
 *   // from existing handlers:
 *   eq.emitHttpComplete(details);
 *   eq.emitTabUpdate(tabId, changeInfo, tab);
 */

// ── OCSF constants ────────────────────────────────────────────
var OCSF_VERSION         = "1.3.0";                              //No I18N
var OCSF_PRODUCT_NAME    = "Browser Security Plus";              //No I18N
var OCSF_PRODUCT_VENDOR  = "ManageEngine";                       //No I18N
var OCSF_PRODUCT_VERSION = "2.30";                               //No I18N

// class_uid values
var OCSF_HTTP_ACTIVITY           = 4002;
var OCSF_WEB_RESOURCES_ACTIVITY  = 6001;
var OCSF_APP_LIFECYCLE           = 6002;

// category_uid values
var OCSF_CAT_NETWORK     = 4;
var OCSF_CAT_APPLICATION = 6;

// activity_id for HTTP Activity: 0=Unknown,1=Open,2=Close,3=Connect,99=Other
// activity_id for Web Resources Activity: 0=Unknown,1=Access,2=Create,3=Update,4=Delete,99=Other
// activity_id for Application Lifecycle: 0=Unknown,1=Install,2=Remove,3=Start,4=Stop,99=Other

// severity_id
var OCSF_SEV_INFO = 1;

// status_id
var OCSF_STATUS_SUCCESS = 1;
var OCSF_STATUS_UNKNOWN = 0;

//email capture const
let EMAIL_CAPTURE_EVENT = "enterprise_email_capture"; //No I18N

// ---------------------------------------------------------------------------
// OCSF URL parser helper
// ---------------------------------------------------------------------------
function parseUrlToOcsf(rawUrl) {
    var obj = {
        url_string: rawUrl || ""                                    
    };
    try {
        var u = new URL(rawUrl);
        obj.scheme    = u.protocol.replace(":", "");                //No I18N
        obj.hostname  = u.hostname;                                 
        obj.port      = u.port ? parseInt(u.port, 10) : (u.protocol === "https:" ? 443 : 80); //No I18N
        obj.path      = u.pathname;                                 
        obj.domain    = u.hostname.split(".").slice(-2).join(".");  //No I18N
        if (u.search) { obj.query_string = u.search.substring(1); }  
        if (u.hostname !== obj.domain) {
            obj.subdomain = u.hostname.slice(0, u.hostname.length - obj.domain.length - 1); 
        }
    } catch (e) { /* malformed URL — url_string is still set */ }
    return obj;
}

// ---------------------------------------------------------------------------
// OCSF Metadata builder
// ---------------------------------------------------------------------------
function buildMetadata(seq) {
    return {
        version: OCSF_VERSION,                                      
        product: {                                                  
            name:        OCSF_PRODUCT_NAME,                         
            vendor_name: OCSF_PRODUCT_VENDOR,                       
            version:     OCSF_PRODUCT_VERSION                       
        },
        sequence: seq,                                              
        original_time: Date.now()                                     
    };
}

// ---------------------------------------------------------------------------
// EventQueue constructor — singleton
// ---------------------------------------------------------------------------
EventQueue = function () {
    if (typeof EventQueue.instance === "object") {
        return EventQueue.instance;
    }

    this.port = null;               // Port singleton (set on init)
    this.enabled = false;           // master switch from native host
    this.batchBuffer = [];          // in-memory buffer for batching
    this.batchSize = 10;            // flush after N events
    this.flushIntervalMs = 5000;    // flush every 5 s at minimum
    this.flushTimer = null;
    this.eventSeq = 0;              // monotonically increasing sequence
    this.enterpriseDomains = [];    // enterprise email domains from config

    EventQueue.instance = this;
    this.initialize();
};

// ---------------------------------------------------------------------------
// initialize — start the periodic flush timer (NO browser listeners here)
// ---------------------------------------------------------------------------
EventQueue.prototype.initialize = function () {
    var self = this;

    // Periodic flush — the only thing initialize needs to do
    this.flushTimer = setInterval(function () {
        self.flush();
    }, this.flushIntervalMs);

    // [EventQueue] initialized — ready for emit calls
};

// ---------------------------------------------------------------------------
// emitHttpComplete — called from historyCollector.historyVisitListener
//   OCSF HTTP Activity (class_uid 4002) — Website Accessed
// ---------------------------------------------------------------------------
EventQueue.prototype.emitHttpComplete = function (details) {
    var url = parseUrlToOcsf(details.url);

    var evt = {
        class_uid:     OCSF_HTTP_ACTIVITY,                              
        class_name:    "HTTP Activity",                                 //No I18N
        category_uid:  OCSF_CAT_NETWORK,                               
        category_name: "Network Activity",                              //No I18N
        activity_id:   1,                                                
        activity_name: "Open",                                          //No I18N
        severity_id:   OCSF_SEV_INFO,                                  
        severity:      "Informational",                                 //No I18N
        status_id:     OCSF_STATUS_SUCCESS,                             
        status:        "Success",                                       //No I18N

        http_request: {                                                 
            url: url                                                    
        },

        http_response: {
            code: details.statusCode || 0
        },

        user_agent:navigator.userAgent || "",

        unmapped: {                                                     
            action:    "WebsiteAccessed",                               //No I18N
            domain:    url.domain || url.hostname || "",                //No I18N
            file_name: "",                                              //No I18N
            file_size: 0,                                               
            file_type: "",                                              //No I18N
            category:  "",                                              //No I18N
            referrer:  ""                                               //No I18N
        }
    };

    // dst_endpoint — server IP from webRequest.onResponseStarted
    if (details.ip) {
        evt.dst_endpoint = {
            ip:       details.ip,                                      
            hostname: url.hostname || "",                               //No I18N
            port:     url.port || 0
        };
    }

    this.enqueue(evt);
};

// ---------------------------------------------------------------------------
// emitWebFilterBlocked — called from routingLogic.responseMessageHandler
//   OCSF HTTP Activity (class_uid 4002) — Website Blocked by web filter
// ---------------------------------------------------------------------------
EventQueue.prototype.emitWebFilterBlocked = function (message) {
    var rawUrl = message.url || message.domain || "";
    var url    = parseUrlToOcsf(rawUrl);

    this.enqueue({
        class_uid:     OCSF_HTTP_ACTIVITY,                              
        class_name:    "HTTP Activity",                                 //No I18N
        category_uid:  OCSF_CAT_NETWORK,                               
        category_name: "Network Activity",                              //No I18N
        activity_id:   1,                                               
        activity_name: "Open",                                          //No I18N
        severity_id:   OCSF_SEV_INFO,                                 
        severity:      "Informational",                                 //No I18N
        status_id:     2,                                              
        status:        "Failure",                                       //No I18N

        http_request: {                                                 
            url: url                                                   
        },

        unmapped: {
            action:    "WebFilterBlocked",                              //No I18N
            domain:    message.domain || "",                            //No I18N
            file_name: "",                                              //No I18N
            file_size: 0,                                               
            file_type: "",                                              //No I18N
            category:  message.BlockedCategory || "",                   //No I18N
            referrer:  ""                                               //No I18N
        }
    });
};

// ---------------------------------------------------------------------------
// emitDownloadActivity — called from downloadManager.createListener
//   OCSF HTTP Activity (class_uid 4002) — File Download
// ---------------------------------------------------------------------------
EventQueue.prototype.emitDownloadActivity = function (downloadItem) {
    var dlUrl = downloadItem.url || downloadItem.finalUrl || "";
    var url   = parseUrlToOcsf(dlUrl);

    this.enqueue({
        class_uid:     OCSF_HTTP_ACTIVITY,
        class_name:    "HTTP Activity",                                 //No I18N
        category_uid:  OCSF_CAT_NETWORK,
        category_name: "Network Activity",                              //No I18N
        activity_id:   2,                                               
        activity_name: "Close",                                         //No I18N
        severity_id:   OCSF_SEV_INFO,                                  
        severity:      "Informational",                                 //No I18N
        status_id:     OCSF_STATUS_SUCCESS,                             
        status:        "Success",                                       //No I18N

        http_request: {                                                 
            url: url                                                    
        },

        unmapped: {                                                     
            action:    "Download",                                      //No I18N
            domain:    url.domain || url.hostname || "",                //No I18N
            file_name: downloadItem.filename || "",                     //No I18N
            file_size: downloadItem.fileSize || downloadItem.totalBytes || 0, 
            file_type: downloadItem.mime || "",                         //No I18N
            category:  "",                                              //No I18N
            referrer:  downloadItem.referrer || ""                      //No I18N
        }
    });
};

// ---------------------------------------------------------------------------
// emitDownloadBlocked — called from downloadManager.responseHandler
//   OCSF HTTP Activity (class_uid 4002) — Download Blocked by policy
// ---------------------------------------------------------------------------
EventQueue.prototype.emitDownloadBlocked = function (message) {
    this.enqueue({
        class_uid:     OCSF_HTTP_ACTIVITY,                              
        class_name:    "HTTP Activity",                                 //No I18N
        category_uid:  OCSF_CAT_NETWORK,                               
        category_name: "Network Activity",                              //No I18N
        activity_id:   2,                                                //Close
        activity_name: "Close",                                         //No I18N
        severity_id:   OCSF_SEV_INFO,                                  
        severity:      "Informational",                                 //No I18N
        status_id:     2,                                                //Failure
        status:        "Failure",                                       //No I18N

        unmapped: {                                                     
            action:    "DownloadBlocked",                               //No I18N
            domain:    message.domain || "",                            //No I18N
            file_name: "",                                              //No I18N
            file_size: parseInt(message.filesize, 10) || 0,            
            file_type: message.filetype || "",                          //No I18N
            category:  "",                                              //No I18N
            referrer:  ""                                               //No I18N
        }
    });
};

// ---------------------------------------------------------------------------
// emitUploadActivity — called from contentPort.contentFilterCallback
//   OCSF HTTP Activity (class_uid 4002) — Upload Done
// ---------------------------------------------------------------------------
EventQueue.prototype.emitUploadActivity = function (files, pageUrl) {
    var url    = parseUrlToOcsf(pageUrl || "");
    var domain = url.domain || url.hostname || "";
    var list   = Array.isArray(files) ? files : [];

    // Emit one event per file so unmapped keys stay flat and common
    if (list.length === 0) {
        this.enqueue({
            class_uid:     OCSF_HTTP_ACTIVITY,                          
            class_name:    "HTTP Activity",                             //No I18N
            category_uid:  OCSF_CAT_NETWORK,                           
            category_name: "Network Activity",                          //No I18N
            activity_id:   99,                                          // Other
            activity_name: "Upload",                                    //No I18N
            severity_id:   OCSF_SEV_INFO,                              
            severity:      "Informational",                             //No I18N
            status_id:     OCSF_STATUS_SUCCESS,                         
            status:        "Success",                                   //No I18N
            http_request: { url: url },                                 
            unmapped: {                                                 
                action:    "Upload",                                    //No I18N
                domain:    domain,                                      
                file_name: "",                                          //No I18N
                file_size: 0,                                           
                file_type: "",                                          //No I18N
                category:  "",                                          //No I18N
                referrer:  ""                                           //No I18N
            }
        });
    } else {
        for (var i = 0; i < list.length; i++) {
            this.enqueue({
                class_uid:     OCSF_HTTP_ACTIVITY,                      
                class_name:    "HTTP Activity",                         //No I18N
                category_uid:  OCSF_CAT_NETWORK,                       
                category_name: "Network Activity",                      //No I18N
                activity_id:   99,                                       //— Other
                activity_name: "Upload",                                //No I18N
                severity_id:   OCSF_SEV_INFO,                          
                severity:      "Informational",                         //No I18N
                status_id:     OCSF_STATUS_SUCCESS,                     
                status:        "Success",                               //No I18N
                http_request: { url: url },                             
                unmapped: {                                             
                    action:    "Upload",                                //No I18N
                    domain:    domain,                                  
                    file_name: list[i].filename || "",                  //No I18N
                    file_size: list[i].fileSize || 0,                   
                    file_type: list[i].mime || "",                      //No I18N
                    category:  "",                                      //No I18N
                    referrer:  ""                                       //No I18N
                }
            });
        }
    }
};

// ---------------------------------------------------------------------------
// emitUploadBlocked — called from contentPort.contentFilterCallback (UploadBlock)
//   OCSF HTTP Activity (class_uid 4002) — Upload Blocked by policy
// ---------------------------------------------------------------------------
EventQueue.prototype.emitUploadBlocked = function (request, senderUrl) {
    var url = parseUrlToOcsf(senderUrl || "");

    this.enqueue({
        class_uid:     OCSF_HTTP_ACTIVITY,                              
        class_name:    "HTTP Activity",                                 //No I18N
        category_uid:  OCSF_CAT_NETWORK,                               
        category_name: "Network Activity",                              //No I18N
        activity_id:   99,
        activity_name: "Upload",                                        //No I18N
        severity_id:   OCSF_SEV_INFO,
        severity:      "Informational",                                 //No I18N
        status_id:     2,
        status:        "Failure",                                       //No I18N

        http_request: {
            url: url
        },

        unmapped: {
            action:    "UploadBlocked",                                 //No I18N
            domain:    url.domain || url.hostname || "",                //No I18N
            file_name: "",                                              //No I18N
            file_size: 0,
            file_type: "",                                              //No I18N
            category:  "",                                              //No I18N
            referrer:  ""                                               //No I18N
        }
    });
};

// ---------------------------------------------------------------------------
// emitExtensionLifecycle — called from routingLogic updateExtensionInventory
//   OCSF Application Lifecycle (class_uid 6002)
//   status: "Install", "Uninstall", "Enable", "Disable"
// ---------------------------------------------------------------------------
EventQueue.prototype.emitExtensionLifecycle = function (status, extInfo) {
    // Uninstall only provides the extension ID as a string
    if (typeof extInfo === "string") {
        this.enqueue({
            class_uid:     OCSF_APP_LIFECYCLE,
            class_name:    "Application Lifecycle",                     //No I18N
            category_uid:  OCSF_CAT_APPLICATION,
            category_name: "Application Activity",                      //No I18N
            activity_id:   2,
            activity_name: "Remove",                                    //No I18N
            severity_id:   OCSF_SEV_INFO,
            severity:      "Informational",                             //No I18N

            app: {
                uid:  extInfo,
                type: "Browser Extension"                               //No I18N
            },
            status_id: OCSF_STATUS_SUCCESS,
            status:    "Success",                                       //No I18N

            message: "Extension uninstalled: " + extInfo,               //No I18N

            unmapped: {
                ext_event: "Uninstall",                                 //No I18N
                ext_id:    extInfo
            }
        });
        return;
    }

    // Install / Enable / Disable — full ExtensionInfo object available
    var activityId, activityName;
    if (status === "Install") {                                         //No I18N
        activityId = 1; activityName = "Install";                       //No I18N
    } else if (status === "Uninstall") {                                //No I18N
        activityId = 2; activityName = "Remove";                        //No I18N
    } else {
        activityId = 99; activityName = "Other";                        //No I18N
    }

    this.enqueue(this.buildExtensionEvent(extInfo, activityId, activityName, status,
        "Extension " + status.toLowerCase() + ": " + (extInfo.name || ""))); //No I18N
};

// ---------------------------------------------------------------------------
// emitEmailCapture — called from contentPort when emailCapture.js reports
//   an enterprise email being entered on a web page.
//   OCSF Web Resources Activity (class_uid 6001, Access)
//
//   data = { emails, url, title, field_type, field_name, timestamp }
// ---------------------------------------------------------------------------
EventQueue.prototype.emitEmailCapture = function (data) {
    var emails = data.emails || [];
    if (emails.length === 0) { return; }

    var url = parseUrlToOcsf(data.url || "");

    this.enqueue({
        class_uid:     OCSF_WEB_RESOURCES_ACTIVITY,
        class_name:    "Web Resources Activity",                        //No I18N
        category_uid:  OCSF_CAT_APPLICATION,
        category_name: "Application Activity",                          //No I18N
        activity_id:   1,
        activity_name: "Access",                                        //No I18N
        severity_id:   OCSF_SEV_INFO,
        severity:      "Informational",                                 //No I18N

        web_resources: [{
            name:       data.title || "",                               //No I18N
            type:       "Web Page",                                     //No I18N
            url_string: data.url || "",                                 //No I18N
            uid:        ""                                              //No I18N
        }],
        http_request: {
            url: url
        },
        status_id: OCSF_STATUS_SUCCESS,
        status:    "Success",                                           //No I18N

        message: "Enterprise email entered: " + emails.join(", "),      //No I18N

        unmapped: {
            email_event:    "enterprise_email_capture",                  //No I18N
            emails:         emails,
            field_type:     data.field_type || "",                       //No I18N
            field_name:     data.field_name || "",                       //No I18N
            page_url:       data.url || "",                             //No I18N
            page_title:     data.title || "",                           //No I18N
            capture_time:   data.timestamp || Date.now()
        }
    });
};

// ---------------------------------------------------------------------------
// OCSF class_uid for Security Finding (used by ClickFix/PasteJack/Clickjacking)
// ---------------------------------------------------------------------------
var OCSF_SECURITY_FINDING = 2001;
var OCSF_CAT_FINDINGS     = 2;

// ---------------------------------------------------------------------------
// emitClickFixDetection — called from contentPort when clickfixDetector.js
//   reports a ClickFix, PasteJack, or Clickjacking detection.
//   OCSF Security Finding (class_uid 2001)
//
//   data = { threat_type, scores, threats[], url, title, severity_id, severity, timestamp }
// ---------------------------------------------------------------------------
EventQueue.prototype.emitClickFixDetection = function (data) {
    if (!data || !data.threat_type) { return; }

    var url = parseUrlToOcsf(data.url || "");

    // Map threat_type to OCSF activity_id
    // 1=Create, 2=Update, 3=Close, 99=Other
    var activityId   = 1;
    var activityName = "Create";                                        //No I18N

    // Build finding_info with individual signals as analytic steps
    var analyticSteps = [];
    var threatList = data.threats || [];
    for (var i = 0; i < threatList.length; i++) {
        var t = threatList[i];
        analyticSteps.push({
            name:        t.signalKey || "",                             //No I18N
            description: t.name || "",                                  //No I18N
            data:        t.detail || "",                                //No I18N
            version:     t.tier || ""                                   //No I18N
        });
    }

    var findingInfo = {
        title:       "Browser Threat Detected: " + (data.threat_type || "unknown"), //No I18N
        uid:         data.threat_type + "_" + (data.timestamp || Date.now()),       //No I18N
        types:       [data.threat_type],
        analytic: {
            type:  "Rule",                                              //No I18N
            name:  "BSP ClickFix Detector",                             //No I18N
            uid:   "bsp-clickfix-detector-v1",                          //No I18N
            data_sources: ["Browser DOM", "Clipboard API", "Content Analysis"] //No I18N
        }
    };

    this.enqueue({
        class_uid:     OCSF_SECURITY_FINDING,
        class_name:    "Security Finding",                              //No I18N
        category_uid:  OCSF_CAT_FINDINGS,
        category_name: "Findings",                                      //No I18N
        activity_id:   activityId,
        activity_name: activityName,
        severity_id:   data.severity_id || OCSF_SEV_INFO,
        severity:      data.severity || "Informational",                //No I18N
        status_id:     OCSF_STATUS_SUCCESS,
        status:        "Success",                                       //No I18N

        finding_info: findingInfo,

        http_request: {
            url: url
        },

        message: "ClickFix/PasteJack/Clickjacking detection: " + data.threat_type//No I18N
                 + " (score: " + (data.scores ? (data.scores[data.threat_type] || 0) : 0) + ")", //No I18N

        unmapped: {
            action:         "ClickFixDetection",                        //No I18N
            threat_type:    data.threat_type || "",                      //No I18N
            score_clickjacking: (data.scores && data.scores.clickjacking) || 0,
            score_pastejacking: (data.scores && data.scores.pastejacking) || 0,
            score_clickfix:     (data.scores && data.scores.clickfix) || 0,
            threat_count:   threatList.length,
            page_title:     data.title || "",                           //No I18N
            page_url:       data.url || "",                             //No I18N
            detection_time: data.timestamp || Date.now(),
            analytic_steps: analyticSteps,
            domain:         url.domain || url.hostname || ""            //No I18N
        }
    });
};

// ---------------------------------------------------------------------------
// emitClickFixCopiedData — called from contentPort when clickfixDetector.js
//   reports copied clipboard data.
// ---------------------------------------------------------------------------
EventQueue.prototype.emitClickFixCopiedData = function (data) {
    if (!data || !data.copied_command) { return; }

    var url = parseUrlToOcsf(data.url || "");

    this.enqueue({
        class_uid:     OCSF_SECURITY_FINDING,
        class_name:    "Security Finding",                              //No I18N
        category_uid:  OCSF_CAT_FINDINGS,
        category_name: "Findings",                                      //No I18N
        activity_id:   99,
        activity_name: "Other",                                         //No I18N
        severity_id:   OCSF_SEV_INFO,
        severity:      "Informational",                                 //No I18N
        status_id:     OCSF_STATUS_SUCCESS,
        status:        "Success",                                       //No I18N
        
        finding_info: {
            title:       "Browser Threat Copied Data: " + (data.threat_type || "unknown"), //No I18N
            uid:         "copied_data_" + (data.timestamp || Date.now()),   //No I18N
            types:       ["Copied Data"]
        },
        http_request: {
            url: url
        },
        message: "Copied data observed during threat detection.",       //No I18N
        unmapped: {
            action:         "ClickFixCopiedData",                       //No I18N
            threat_type:    data.threat_type || "",                     //No I18N
            copied_command: data.copied_command,
            page_title:     data.title || "",                           //No I18N
            page_url:       data.url || "",                             //No I18N
            detection_time: data.timestamp || Date.now(),
            domain:         url.domain || url.hostname || ""            //No I18N
        }
    });
};

// ---------------------------------------------------------------------------
// Enterprise domain config — stored here, served to content scripts
// ---------------------------------------------------------------------------
EventQueue.prototype.setEnterpriseDomains = function (domains) {
    this.enterpriseDomains = domains || [];
    // [EventQueue] enterprise domains set
};

EventQueue.prototype.getEnterpriseDomains = function () {
    return this.enterpriseDomains || [];
};

// ---------------------------------------------------------------------------
// buildExtensionEvent — OCSF Application Lifecycle for extension lifecycle
// ---------------------------------------------------------------------------
EventQueue.prototype.buildExtensionEvent = function (extInfo, activityId, activityName, status, msg) {
    var extState = extInfo.enabled ? "Enabled" : "Disabled";            //No I18N
    var disabledReason = extInfo.disabledReason || "";                   //No I18N
    if (extInfo.mayEnable === false) {
        disabledReason = "disabled_due_to_policy";                      //No I18N
    }

    return {
        class_uid:     OCSF_APP_LIFECYCLE,
        class_name:    "Application Lifecycle",                         //No I18N
        category_uid:  OCSF_CAT_APPLICATION,
        category_name: "Application Activity",                          //No I18N
        activity_id:   activityId,
        activity_name: activityName,
        severity_id:   OCSF_SEV_INFO,
        severity:      "Informational",                                 //No I18N

        app: {
            name:        extInfo.name || "",                            //No I18N
            uid:         extInfo.id || "",                              //No I18N
            version:     extInfo.version || "",                         //No I18N
            vendor_name: "",                                            //No I18N
            url_string:  extInfo.homepageUrl || ""                      //No I18N
        },
        status_id: OCSF_STATUS_SUCCESS,
        status:    "Success",                                           //No I18N

        message: msg,

        unmapped: {
            ext_event:        status,
            ext_id:           extInfo.id || "",                         //No I18N
            ext_state:        extState,
            ext_type:         extInfo.type || "",                       //No I18N
            ext_install_type: extInfo.installType || "",                //No I18N
            ext_may_disable:  extInfo.mayDisable,
            ext_permissions:  extInfo.permissions || [],
            ext_host_perms:   extInfo.hostPermissions || [],
            ext_disabled_reason: disabledReason,
            ext_update_url:   extInfo.updateUrl || "",                  //No I18N
            ext_offline:      extInfo.offlineEnabled || false
        }
    };
};

// ---------------------------------------------------------------------------
// enqueue — stamp with OCSF envelope fields, buffer, flush when full
// ---------------------------------------------------------------------------
EventQueue.prototype.enqueue = function (eventData) {
    
    if (!this.enabled && !(this.enterpriseDomains.length > 0 && eventData.unmapped && eventData.unmapped.email_event === EMAIL_CAPTURE_EVENT)) { return; }

    var seq = ++this.eventSeq;
    var now = Date.now();

    // ── Required OCSF envelope ──
    eventData.time            = now;
    eventData.timezone_offset = -(new Date().getTimezoneOffset());
    eventData.metadata        = buildMetadata(seq);

    // type_uid = class_uid * 100 + activity_id
    eventData.type_uid  = (eventData.class_uid || 0) * 100 + (eventData.activity_id || 0);
    eventData.type_name = (eventData.class_name || "Unknown") + ": " + (eventData.activity_name || "Unknown"); //No I18N

    // ── Source endpoint (the browser) ──
    if (!eventData.src_endpoint) {
        eventData.src_endpoint = {
            hostname: this.processName || "CHROME",                           //No I18N
            name:     OCSF_PRODUCT_NAME
        };
    }

    // ── Stamp process_id and process_time into unmapped ──
    if (!eventData.unmapped) { eventData.unmapped = {}; }
    if (this.processId !== undefined)   { eventData.unmapped.process_id   = this.processId; }
    if (this.processTime !== undefined) { eventData.unmapped.process_time = this.processTime; }

    this.batchBuffer.push(eventData);

    if (this.batchBuffer.length >= this.batchSize) {
        this.flush();
    }
};

// ---------------------------------------------------------------------------
// flush — send the buffered batch to the native host
// ---------------------------------------------------------------------------
EventQueue.prototype.flush = function () {
    if (this.batchBuffer.length === 0) { return; }

    var batch = this.batchBuffer.splice(0);         // drain the buffer

    this.postToNativeHost(batch);
};

// ---------------------------------------------------------------------------
// postToNativeHost — send a batch of events through the native Port
// ---------------------------------------------------------------------------
EventQueue.prototype.postToNativeHost = function (events) {
    if (!this.port) {
        // Port not yet available — re-buffer so nothing is lost
        this.batchBuffer = events.concat(this.batchBuffer);
        return;
    }
    if (!this.port.checkPortState(null)) {
        this.batchBuffer = events.concat(this.batchBuffer);
        return;
    }

    this.port.port.postMessage({
        id: 0,
        command: "fastq_event_batch",                   //No I18N
        events: events
    });
};

// ---------------------------------------------------------------------------
// setPort — called after the Port singleton is ready
// ---------------------------------------------------------------------------
EventQueue.prototype.setPort = function (portInstance) {
    this.port = portInstance;
    // [EventQueue] native port attached
    // flush anything that was buffered before the port connected
    this.flush();
};

// ---------------------------------------------------------------------------
// enable / disable — controlled from native host PolicyRefresh
// ---------------------------------------------------------------------------
EventQueue.prototype.setEnabled = function (flag) {
    this.enabled = !!flag;
    // [EventQueue] enabled toggle
    if (!this.enabled && this.enterpriseDomains.length === 0) {
        this.batchBuffer = [];      // discard pending events when disabled
    }
};

// ---------------------------------------------------------------------------
// configure — update batch parameters at runtime
// ---------------------------------------------------------------------------
EventQueue.prototype.configure = function (opts) {
    if (opts.batchSize !== undefined) { this.batchSize = opts.batchSize; }
    if (opts.flushIntervalMs !== undefined) {
        this.flushIntervalMs = opts.flushIntervalMs;
        clearInterval(this.flushTimer);
        var self = this;
        this.flushTimer = setInterval(function () { self.flush(); }, this.flushIntervalMs);
    }
};

// ---------------------------------------------------------------------------
// destroy — teardown (called on extension unload / upgrade)
// ---------------------------------------------------------------------------
EventQueue.prototype.destroy = function () {
    clearInterval(this.flushTimer);
    this.flush();       // final drain
    this.enabled = false;
    this.port = null;
    EventQueue.instance = null;
};

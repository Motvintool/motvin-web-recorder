"use strict";   //No I18N
let z = []
let whitelisted = false;
let currentTabUrl = null;
let isUploadBlocked = false;
let violationData = {};
let matchedPolicy = null;

//Preprocess Upload check (old single-policy format only)
let preUrlMatchCheck = false;
let sitesExcludeMatch = false;
let preGenAIUrlMatchCheck = false;
let preMatchedDomain = null;
let excludeMatchedDomain = null;

function preprocessUploadCheck(ruleJSON) {
    //Use live URL for SPA sites where URL changes without page reload.
    currentTabUrl = getCurrentUrl();

    if(ruleJSON !== undefined && Object.keys(ruleJSON).length > 0){

        // For old format (non-stacked), uploadFilter is a single object or array with one entry.
        // Precompute URL matches for performance (checked on every upload event).
        let uploadFilter = Array.isArray(ruleJSON.uploadFilter) ? ruleJSON.uploadFilter[0] : ruleJSON.uploadFilter;
        if (!uploadFilter) return;

        var blocklist = uploadFilter.blocklist || {};
        let excludeList = uploadFilter.excludeList || {};

        var data = {
            url: currentTabUrl,
        }

        if(blocklist.hasOwnProperty('sites') && blocklist.sites.length > 0){
            preUrlMatchCheck = matchRules("sites", blocklist.sites, data)   //No I18N
            preMatchedDomain = violationData["domain"] || null;
            violationData = {};
        }

        if(excludeList.hasOwnProperty('sites') && excludeList.sites.length > 0){
            sitesExcludeMatch = matchRules("sites", excludeList.sites, data);   //No I18N
            excludeMatchedDomain = violationData["domain"] || null;
            violationData = {};
        }

        let genAIDomains = (uploadFilter.hasOwnProperty('genAIDomains') && uploadFilter.genAIDomains.length > 0) ? uploadFilter.genAIDomains    //No I18N
            : (ruleJSON.hasOwnProperty('GenAIDomains') && ruleJSON.GenAIDomains.length > 0) ? ruleJSON.GenAIDomains : null;  //No I18N
        if (genAIDomains) {
            preGenAIUrlMatchCheck = matchRules("sites", genAIDomains, data);   //No I18N
            violationData = {};
        }
    }
}

//Helper: Get the current live URL (handles iframes and SPA navigation)
function getCurrentUrl() {
    return (window.location != window.parent.location) ? document.referrer : document.location.href;
}


function e(e) {
    chrome.runtime.sendMessage(e)
    z = [];
}

var custom_message = undefined;
var sendData = {};

function buildViolationRemarks() {
    let remarks = [];
    // RuleId 1 = Time, RuleId 2 = Url, RuleId 3 = File Type, RuleId 4 = File Size
    if (violationData.hasOwnProperty("time")) {
        remarks.push({ "RuleId": 1, "Value": String(Date.now())});
    }
    if (violationData.hasOwnProperty("domain")) {
        remarks.push({ "RuleId": 2, "Value": violationData["domain"] });
    }
    if (violationData.hasOwnProperty("filetype")) {
        remarks.push({ "RuleId": 3, "Value": violationData["filetype"] });
    }
    if (violationData.hasOwnProperty("filesize")) {
        remarks.push({ "RuleId": 4, "Value": convertToMBEx(violationData["filesize"]) });
    }
    return remarks;
}

function convertToMBEx(bytes) {
    if (bytes < 1024) {
        return `${bytes} B`;
    } else if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(6)} KB`;
    } else {
        return `${(bytes / (1024 * 1024)).toFixed(6)} MB`;
    }
}

function uploadBlockPost(e) {
    
    // Use matched policy for custom messages (stacked policies),
    // fall back to uploadFilter for old single-policy format.
    let policySource = matchedPolicy || ruleJSON.uploadFilter;
    if (Array.isArray(policySource)) {
        policySource = policySource[0] || {};
    }

    if(policySource.hasOwnProperty('custom_message') && (policySource.custom_message !== "" || policySource.custom_message !== null)){
        custom_message = policySource.custom_message;
    }
    if(policySource.hasOwnProperty("custom_logo") && (policySource.custom_logo !== "" || policySource.custom_logo !== null)){
        var logoUrl = policySource.custom_logo;
    }
    if(policySource.hasOwnProperty("custom_mail_id") && (policySource.custom_mail_id !== "" || policySource.custom_mail_id !== null)){
        var mailId = policySource.custom_mail_id;
    }

    let violationDetails = {
        "ViolationTime": Date.now(), //No I18N
        "Remarks": buildViolationRemarks() //No I18N
    };

    sendData["actiontype"] = "UploadBlock"  //No I18N
    sendData["data"] = e    //No I18N
    sendData["custom_message"] = custom_message  //No I18N
    sendData["custom_logo"] = logoUrl    //No I18N
    sendData["custom_mail_id"] = mailId //No I18N
    sendData["violationDetails"] = violationDetails  //No I18N

    // Include collectionId if present (stacked policy)
    if (matchedPolicy && matchedPolicy.hasOwnProperty("collectionId")) {
        sendData["collectionId"] = matchedPolicy.collectionId;  //No I18N
    }

    chrome.runtime.sendMessage(sendData);
    //showDownloadRestrictionModal(sendData);
    sendData = {};
    violationData = {};
    matchedPolicy = null;
    z = [];
}

function uploadblock(eventType, event, data) {
    // z = [];
    isUploadBlocked = true;
    switch (eventType) {
        case 0:
            // console.log("Upload Block Event : " + event);   //No I18N
            event.target.value = '';    //No I18N
            uploadBlockPost("Blocked"); //No I18N
            break;
        case 1:
            // console.log("Upload Block Event : " + event);    //No I18N
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            //Fake Event
            const fakeDropEvent = new Event('dragleave', {   //No I18N
                bubbles: true,
                cancelable: true
            });
            event.target.dispatchEvent(fakeDropEvent);
            uploadBlockPost("Blocked");  //No I18N
            break;
        case 2:
            // console.log("Upload Block Event : " + event);   //No I18N
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            //Fake Event -> Incase if needed Remove below commentout code
            // const fakePasteEvent = new Event('paste', {   //No I18N
            //     bubbles: true,
            //     cancelable: true
            // });
            // event.target.dispatchEvent(fakePasteEvent);
            uploadBlockPost("Blocked");   //No I18N
            break;
    }
}
function t(n) {
    var e = new Date(),
        t = null;
    do {
        t = new Date()
    } while (t - e < n)
}

function i(n, event,trigEvent) {
    try {
        let pendingMimes = 0;
        let completedMimes = 0;

        for (let i of n) {
            //folder
            let isDir = false;
            isDir = checkisDir(i,trigEvent);
            //folder
            const n = String(i.name);
            if (n) {
                let h = {};
                h.isDirectory = isDir;
                h.filename = isDir ? "folder" : n;  //No I18N
                h.fileSize = i.size;
                h.fileLastModified = i.lastModified;
                h.mime = i.type;
                h.UploadTime = Date.now();
                h.url = getCurrentUrl();
                event.isFile = !0;
                z.push(h);

                pendingMimes++;
                // Async MIME detection
                getAccurateMime(i).then(accurateMime => {
                    // h.rawFileBytes = (accurateMime !== "unknown/unknown") ? accurateMime : i.type; //No I18N
                    if (accurateMime !== "unknown/unknown") {
                        h.rawFileBytes = accurateMime; // Only add if valid
                    }
                    completedMimes++;

                    if (completedMimes === pendingMimes) {
                        if (!isUploadBlocked) {
                            e(z); //post to nativehost
                        }
                        isUploadBlocked = false;
                    }
                });
            }
        }
    } catch (n) {
        event.isFile = !1, t = ""   //No I18N
    }
}

function a(event) {
    if(event.isTrusted === false){return;}
    if (event.target.files && event.target.files.length > 0) {
        z = [];
        sendData = {};
        let o = { isFile: !1 };
        i(event.target.files, o,"change");  //No I18N
        let match = evaluateRuleJSON(z);
        if (match) {
            uploadblock(0, event, 0);
        } else {
            //Below code is commented out to avoid sending data instead of we post in function (i & o)
            // if (o.isFile) {
            //     z.length > 0 && (e(z), t(500));
            // }
        }
    }
}

function evaluateSinglePolicy(policy, uploadData, genAIMatch) {
    // Evaluates a single policy against the upload data.
    // Returns true if the upload matches this policy's conditions (raw match).
    // Does NOT apply whitelist inversion — the caller handles that for old format.
    let match = false;
    violationData = {};

    let blocklist = policy.blocklist || {};
    let excludeList = policy.excludeList || {};
    let all_condition_match = policy.all_condition_match;
    let folderAllow = policy.folder;

    // Compute URL match for this policy
    let urlMatchCheck = false;
    let policyMatchedDomain = null;
    let excludeMatch = false;
    let policyExcludeDomain = null;

    let data = { url: currentTabUrl };

    if (blocklist.hasOwnProperty('sites') && blocklist.sites.length > 0) {
        urlMatchCheck = matchRules("sites", blocklist.sites, data);   //No I18N
        policyMatchedDomain = violationData["domain"] || null;
        violationData = {};
    }

    if (excludeList.hasOwnProperty('sites') && excludeList.sites.length > 0) {
        excludeMatch = matchRules("sites", excludeList.sites, data);   //No I18N
        policyExcludeDomain = violationData["domain"] || null;
        violationData = {};
    }

    // Block all uploads
    if (policy.block_all_uploads === "1") {
        return true;
    }

    // GenAI domain block: bypass file type/size/time but respect excludeList
    // Only apply if this specific policy has BLOCK_ON_GENAI_SITES enabled
    let policyGenAIEnabled = policy.hasOwnProperty('BLOCK_ON_GENAI_SITES') && policy.BLOCK_ON_GENAI_SITES === "1";  //No I18N
    if (genAIMatch && policyGenAIEnabled && !excludeMatch) {
        violationData["domain"] = currentTabUrl;
        return true;
    }

    // Resolve fields: stacked format puts file_types/file_size/range at policy root,
    // old format keeps them inside blocklist. Check both locations.
    let fileTypes = policy.file_types || blocklist.file_types;
    let fileSize = policy.file_size || blocklist.file_size;
    let range = policy.range || blocklist.range;

    // Create a local copy of file_types to avoid mutating ruleJSON on every call.
    let blocklistFileTypes = fileTypes ? [...fileTypes] : undefined;

    uploadData.some(fileData => {

        if (blocklistFileTypes && policy.hasOwnProperty('folder') && (!blocklistFileTypes.some(item => typeof item === 'object' && 'folderAllow' in item))) {    //No I18N
            blocklistFileTypes.push({ folderAllow: folderAllow == "true" ? true : false });  //No I18N
        }

        if (!excludeMatch) {

            if (all_condition_match) {
                var Conditions = [
                    range != undefined ? matchRules("range", range, fileData) : true,   //No I18N
                    blocklist.hasOwnProperty('sites') && blocklist.sites.length > 0 ? urlMatchCheck : true, //No I18N
                    blocklistFileTypes != undefined ? matchRules("file_types", blocklistFileTypes, fileData) : true,    //No I18N
                    fileSize != undefined && !fileData.isDirectory ? matchRules("file_size", fileSize, fileData) : true    //No I18N
                ];

                match = Conditions.every(condition => condition === true);
            }
            else {
                var Conditions = [
                    range != undefined ? matchRules("range", range, fileData) : false,  //No I18N
                    blocklist.hasOwnProperty('sites') && blocklist.sites.length > 0 ? urlMatchCheck : false, //No I18N
                    blocklistFileTypes != undefined ? matchRules("file_types", blocklistFileTypes, fileData) : false,   //No I18N
                    fileSize != undefined && !fileData.isDirectory ? matchRules("file_size", fileSize, fileData) : false   //No I18N
                ];

                match = Conditions.some(condition => condition === true);
            }
        }

        // Record domain from URL match if it contributed to the match
        if (!excludeMatch && match && blocklist.hasOwnProperty('sites') && blocklist.sites.length > 0 && urlMatchCheck && policyMatchedDomain) {
            violationData["domain"] = policyMatchedDomain;
        }

        // Clear violation data if upload is not blocked
        if (!match) {
            violationData = {};
        }
    });

    return match;
}

function evaluateRuleJSON(uploadData) {
    let match = false;
    violationData = {};
    matchedPolicy = null;

    if (!uploadData.length)
    {
        return false;
    }

    if(ruleJSON == undefined || Object.keys(ruleJSON).length === 0){
        // console.log("No rules defined, allowing upload by default.");  //No I18N
        return match; // No rules defined, allow upload by default
    }

    // Normalize uploadFilter: support both old (single object) and new (array) formats
    let uploadFilter = ruleJSON.uploadFilter;

    // Determine stacked vs old format
    let isStacked = ruleJSON.hasOwnProperty("policyType");  //No I18N
    let policyType = isStacked ? ruleJSON.policyType : null;

    if (isStacked) {
        // ── Stacked policies: iterate all policies, compute URL match per-policy ──
        currentTabUrl = getCurrentUrl();

        // Check GenAI domains
        let genAIMatch = false;
        if (ruleJSON && ruleJSON.hasOwnProperty('GenAIDomains') && ruleJSON.GenAIDomains.length > 0) {
            genAIMatch = matchRules("sites", ruleJSON.GenAIDomains, { url: currentTabUrl });   //No I18N
            violationData = {};
        }

        let policies = Array.isArray(uploadFilter) ? uploadFilter : [uploadFilter];

        if (policyType === "WHITELIST") {
            // WHITELIST mode: allow on first matching policy, block if no policy matches
            whitelisted = true;
            let allowed = false;
            for (let idx = 0; idx < policies.length; idx++) {
                let policy = policies[idx];
                violationData = {};
                if (evaluateSinglePolicy(policy, uploadData, genAIMatch)) {
                    allowed = true;
                    matchedPolicy = policy;
                    break;
                }
            }
            if (!allowed) {
                match = true;
                matchedPolicy = { collectionId: -1 };
                violationData["domain"] = currentTabUrl;
            }
        } else {
            // BLOCKLIST mode: block on first matching policy
            whitelisted = false;
            for (let idx = 0; idx < policies.length; idx++) {
                let policy = policies[idx];
                violationData = {};
                if (evaluateSinglePolicy(policy, uploadData, genAIMatch)) {
                    matchedPolicy = policy;
                    match = true;
                    break;
                }
            }
        }
    } else {
        // ── Old format (no policyType): single policy, use precomputed URL matches ──
        let policy = Array.isArray(uploadFilter) ? uploadFilter[0] : uploadFilter;

        //Re-evaluate URL match on every upload for SPA sites where URL changes
        //without page reload. Previously preUrlMatchCheck was computed only at initialization.
        refreshUrlMatchForSPA(ruleJSON);

        //Block All Uploads
        if (policy.block_all_uploads === "1") {
            return true; // Block all uploads
        }

        // GenAI domain block: block upload unconditionally (bypass file type/size/time),
        // but still respect exclude_sites.
        if (preGenAIUrlMatchCheck && !sitesExcludeMatch) {
            violationData["domain"] = currentTabUrl;
            return true;
        }

        let blocklist = policy.blocklist;
        let folderAllow = policy.folder;
        let excludeList = policy.excludeList;
        let whitelist = policy.whitelist;
        whitelisted = whitelist;
        let all_condition_match = policy.all_condition_match;

        //Create a local copy of file_types to avoid mutating ruleJSON on every call.
        var blocklistFileTypes = undefined;
        if (blocklist.hasOwnProperty('file_types') && blocklist.file_types != undefined) {
            blocklistFileTypes = [...blocklist.file_types];
        }else if (policy.hasOwnProperty('file_types') && policy.file_types != undefined) { //No I18N
            blocklistFileTypes = [...policy.file_types];
        }
       // let blocklistFileTypes = policy.hasOwnProperty('file_types') ? [...blocklist.file_types] : undefined;

        uploadData.some(data => {

            if (blocklistFileTypes && policy.hasOwnProperty('folder') && (!blocklistFileTypes.some(item => typeof item === 'object' && 'folderAllow' in item))) {    //No I18N
                blocklistFileTypes.push({ folderAllow: folderAllow == "true" ? true : false });  //No I18N
            }

            if(!sitesExcludeMatch) {

                if (all_condition_match) {
                    var Conditions = [
                        blocklist.hasOwnProperty('range') && blocklist.range != undefined ? matchRules("range", blocklist.range, data) : true,   //No I18N
                        blocklist.hasOwnProperty('sites') && blocklist.sites.length > 0 ? preUrlMatchCheck : true,  //No I18N
                        blocklistFileTypes != undefined ? matchRules("file_types", blocklistFileTypes, data) : true,    //No I18N
                        blocklist.hasOwnProperty('file_size') && blocklist.file_size != undefined && !data.isDirectory ? matchRules("file_size", blocklist.file_size, data) : true    //No I18N
                    ];

                    match = Conditions.every(condition => condition === true);
                }
                else {
                    var Conditions = [
                        blocklist.hasOwnProperty('range') && blocklist.range != undefined ? matchRules("range", blocklist.range, data) : false,  //No I18N
                        blocklist.hasOwnProperty('sites') && blocklist.sites.length > 0 ? preUrlMatchCheck : false, //No I18N
                        blocklistFileTypes != undefined ? matchRules("file_types", blocklistFileTypes, data) : false,   //No I18N
                        blocklist.hasOwnProperty('file_size') && blocklist.file_size != undefined && !data.isDirectory ? matchRules("file_size", blocklist.file_size, data) : false   //No I18N
                    ];

                    match = Conditions.some(condition => condition === true);
                }
            }

            // Record domain from precomputed URL match if it contributed to the block
            if (!sitesExcludeMatch && match && blocklist.hasOwnProperty('sites') && blocklist.sites.length > 0 && preUrlMatchCheck && preMatchedDomain) {
                violationData["domain"] = preMatchedDomain;
            }

            if(whitelist){
                match = !match;
            }

            // Handle special case: blocked by exclude sites in whitelist mode
            if (match && sitesExcludeMatch && excludeMatchedDomain) {
                violationData["domain"] = excludeMatchedDomain;
            }

            // Clear violation data if upload is not blocked
            if (!match) {
                violationData = {};
            }
        });

        if (match) {
            matchedPolicy = policy;
        }
    }

    if (!match) {
        violationData = {};
        matchedPolicy = null;
    }

    return match;

}

function matchRules(rulename, rule, uploadData) {

    switch (rulename) {
        case 'range':   //No I18N
            return checkTime(rule);
        case 'sites':   //No I18N
            return checkUrl(rule);
        case 'file_types':  //No I18N
            return checkFileType(rule);
        case 'file_size':   //No I18N
            return checkFileSize(rule);
        default:
            return false;
    }


    function checkTime(rule) {
        const currentTime = new Date().toTimeString().split(' ')[0];
        const [startTime, endTime] = rule;
        // alert(currentTime+" == "+startTime);
        var value = currentTime >= startTime && currentTime <= endTime;
        // console.log("Time Match : " + value);   //No I18N
        if(value){
            violationData["time"] = `${startTime} to ${endTime}`;
        }
        return currentTime >= startTime && currentTime <= endTime;
    }

    function checkUrl(rule) {
        let urlMatch = false;
        rule.some(site => {
            //Return Match if any of the URL matches
            // urlMatch = uploadData.tabURL.includes(site) || uploadData.referrer.includes(site) || uploadData.url.includes(site) || uploadData.finalUrl.includes(site);
            urlMatch =  uploadData.url.includes(site);
            if (urlMatch) {
                // console.log("URL Match : " + urlMatch); //No I18N
                violationData["domain"] = site;
                return urlMatch;
            }
        });
        return urlMatch;
    }

    function checkFileType(rule) {
        let actualFileType = getFileType(uploadData.filename);
        //if rule contains . at last remove it
        rule.forEach((fileName, index) => {
            const dotIndex = fileName.lastIndexOf('.');

            rule[index] = dotIndex > -1
                ? fileName.substring(dotIndex + 1)
                : fileName;
        });
        let fileTypeMatch = rule.includes(actualFileType);
        if(fileTypeMatch){
            violationData["filetype"] = actualFileType
        }

        let folderAllow = rule.find(item => typeof item === 'object' && 'folderAllow' in item)?.folderAllow;

        if (folderAllow != undefined) {

            if((!folderAllow && uploadData.isDirectory) || (folderAllow && uploadData.isDirectory && whitelisted)){
                fileTypeMatch = true;
                violationData["filetype"] = "folder" //No I18N
            }
        }
        return fileTypeMatch;
    }

    function checkFileSize(rule) {
        const { size, greater } = rule;
        let fileSize = uploadData.fileSize;

        if (greater) {
            // console.log("File Size Match : " + (fileSize > size));  //No I18N
            if(fileSize > size){
                violationData["filesize"] = fileSize;
            }
            return fileSize > size;
        } else {
            if(fileSize < size){
                violationData["filesize"] = fileSize
            }
            return fileSize < size;
        }
    }



    function getFileType(file) {
        let filetype = file.split('.').pop();
        return filetype;
    }

}

function checkisDir(item,event)
{
    let isDir = false;
    if(event==="change")    //No I18N
    {
        if (item.webkitRelativePath && item.webkitRelativePath.includes("/")) { //No I18N
            isDir = true;
        }
    }

    if(event==="drop")
    {
        let webkitdata;
        if (item instanceof DataTransferItem) {
            webkitdata = item.webkitGetAsEntry();
        } else {
            webkitdata = item;
        }
        if (webkitdata) {
            if(webkitdata.isDirectory){
                isDir = true;
            }
        }
    }

    if (event === "filefolderpicker") {   // showOpenFilePicker
        // Always files, no directory support here
        if(item.hasOwnProperty("type") && item.type === "folder")
        {
            isDir = true;
        } else{
            isDir = false;
        }
    }
    return isDir;
}


function o(items) {

    let pendingMimes = 0;
    let completedMimes = 0;

    for (let t = 0; t < items.length; t++) {
        let item = items[t];
        let isDir = false;
        isDir = checkisDir(item,"drop");    //No I18N

        if (item.kind === "file" || isDir) {    //No I18N
            let file = item.getAsFile();
            if (file) {

                let h = {
                    isDirectory: isDir,
                    filename: file.name,
                    fileSize: file.size,
                    fileLastModified: file.lastModified,
                    mime: file.type,
                    UploadTime: Date.now(),
                    url: getCurrentUrl()
                };
                z.push(h);

                pendingMimes++;
                // Async MIME detection
                getAccurateMime(file).then(accurateMime => {
                    // h.rawFileBytes = (accurateMime !== "unknown/unknown") ? accurateMime : file.type;   //No I18N
                    if (accurateMime !== "unknown/unknown") {
                        h.rawFileBytes = accurateMime; // Only add if valid
                    }
                    completedMimes++;

                    if (completedMimes === pendingMimes) {
                        if (!isUploadBlocked) {
                            e(z);
                        }
                        isUploadBlocked = false;
                    }
                });
            }
        }
    }
    // console.log("Items Processed: ", z);  //No I18N

    return null;
}

function getFileFromEntry(fileEntry) {  //async function
    return new Promise((resolve, reject) => {
        fileEntry.file(resolve, reject);
    });
}

function r(event) {
    if(event.isTrusted === false){return;}
    try {
        z = [];
        sendData = {};
        const items = event.dataTransfer.items;
        o(items);

        let match = evaluateRuleJSON(z);
        if (match) {
            uploadblock(1, event, 0);
        } else {
            if (z.length > 0) {
                // e(z);
            }
        }
    }
    catch (e) {
        // console.log("Error in Drag Event : " + e);  //No I18N
    }
}

function p(event) {
    if(event.isTrusted === false){return;}
    if (event.clipboardData.files && event.clipboardData.files.length > 0) {
        z = [];
        sendData = {};
        let o = {
            isFile: !1
        };
        i(event.clipboardData.files, o,"paste");    //No I18N
        let match = evaluateRuleJSON(z);
        if (match) {
            uploadblock(2, event, 0);
        }
        // else {
        // if (o.isFile) {
        //     z.length > 0 && (e(z), t(500));
        // }
        // }
    }
}

//MIME Type POC

function getAccurateMime(file) {
    return new Promise((resolve) => {
        try {
            const safeFile = new Blob([file]);
            const reader = new FileReader();

            reader.onloadend = function (e) {
                try {
                    if (!e.target.result) {
                        return resolve("unknown/unknown");   //No I18N
                    }

                    const arr = new Uint8Array(e.target.result).subarray(0, 16);
                    let hexArray = [];
                    for (let i = 0; i < arr.length; i++) {
                        hexArray.push("0x" + arr[i].toString(16).padStart(2, "0").toUpperCase());
                    }

                    resolve(hexArray.length > 0 ? hexArray.join(", ") : "unknown/unknown"); //No I18N
                } catch (err) {
                    resolve("unknown/unknown"); // fallback  //No I18N
                }
            };

            reader.onerror = function (err) {
                resolve("unknown/unknown");  //No I18N
            };

            reader.readAsArrayBuffer(safeFile.slice(0, 16));
        } catch (err) {
            console.error("Permission denied or invalid file access:", err); //No I18N
            resolve("unknown/unknown");  //No I18N
        }
    });
}

var ruleJSON = {};
var uploadTracking = false;

function s(rules_json) {
    ruleJSON = rules_json;
    attachListeners();
    filefolderListener();
    ShadowDomListener();
}

function attachListeners() {
    window.addEventListener("change", a, true); //No I18N
    window.addEventListener("drop", r, true);    //No I18N
    window.addEventListener("paste", p, true);   //No I18N
}

function ShadowDomListener() {
    const processedRoots = new WeakSet();
    const observedRoots = new WeakSet();

    // Attach a MutationObserver inside each shadow root so we catch
    // child web-components that are created asynchronously (e.g. Lit/Polymer rendering).
    // Without this, scanShadowRoots runs once and misses children rendered after a delay.
    const observeShadowRoot = (shadowRoot) => {
        if (observedRoots.has(shadowRoot)) return;
        observedRoots.add(shadowRoot);

        const shadowObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType !== Node.ELEMENT_NODE) return;
                    try {
                        scanShadowRoots(node);
                    } catch (e) {
                        // Silently handle errors
                    }
                });
            });
        });

        shadowObserver.observe(shadowRoot, {
            childList: true,
            subtree: true
        });
    };

    //Listen for synchronous DOM events from closed shadow roots intercepted by shadowhook.js.
    //shadowhook.js (MAIN world) writes file metadata to data-bsp-req, dispatches 'bsp-shadow-eval',
    //and we write the decision to data-bsp-dec. Since dispatchEvent is synchronous, the decision
    //is available to shadowhook.js in the SAME event tick — before any page handler fires.
    //uploadmanager.js remains the sole decision maker (no duplicated rule logic).
    document.documentElement.addEventListener('bsp-shadow-eval', () => {   //No I18N
        try {
            var root = document.documentElement;
            var raw = root.getAttribute('data-bsp-req');   //No I18N
            if (!raw) return;

            var req = JSON.parse(raw);
            z = [];
            sendData = {};
            const fakeFiles = req.files.map(f => ({
                name: f.name,
                size: f.size,
                type: f.type,
                lastModified: f.lastModified,
                webkitRelativePath: ''  //No I18N
            }));
            let o = { isFile: false };
            i(fakeFiles, o, "change");  //No I18N
            let match = evaluateRuleJSON(z);

            // Write decision to DOM attribute — shadowhook.js reads this synchronously
            root.setAttribute('data-bsp-dec', match ? 'block' : 'allow');   //No I18N

            if (match) {
                uploadBlockPost("Blocked");  //No I18N
            }
        } catch (e) {
            // On error, write allow so the file isn't silently eaten
            try {
                document.documentElement.setAttribute('data-bsp-dec', 'allow');   //No I18N
            } catch(e2) {}
        }
    });

    // No maxDepth — recurse as deep as shadow roots exist
    const scanShadowRoots = (node) => {
        if (!node) return;
        try {
            let shadow = node.shadowRoot;
            if (shadow && !processedRoots.has(shadow)) {
                processedRoots.add(shadow);

                shadow.addEventListener("change", a, true);  //No I18N
                shadow.addEventListener("drop", r, true);    //No I18N
                shadow.addEventListener("paste", p, true);   //No I18N

                // Watch this shadow root for future child additions (async rendering)
                observeShadowRoot(shadow);

                // Recurse into shadow root children
                shadow.querySelectorAll('*').forEach(el => scanShadowRoots(el));
            }
            // Recurse into regular children to find nested shadow roots
            if (node.children) {
                for (let child of node.children) {
                    scanShadowRoots(child);
                }
            }
        } catch (e) {
            // Silently handle errors
        }
    };

    // Initial scan of existing DOM
    try {
        scanShadowRoots(document.body);
    } catch (e) {
        // Silently handle errors
    }

    // Single unified MutationObserver for the light DOM
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType !== Node.ELEMENT_NODE) return;
                try {
                    // Handle iframes
                    if (node.contentDocument !== undefined) {
                        node.addEventListener('load', () => {

                            let doc = node.contentDocument;

                            if (!doc) {
                                // wrapped in try/catch because contentWindow.document throws SecurityError on cross-origin
                                try {
                                    doc = node.contentWindow && node.contentWindow.document;
                                } catch (e) {
                                    // Cannot access cross-origin iframe
                                }
                            }

                            if (doc) {
                                attachListeners(doc);
                                if (doc.body) scanShadowRoots(doc.body);
                            }
                        });
                    }
                    // Scan for shadow roots in the newly added node
                    scanShadowRoots(node);
                } catch (e) {
                    // Silently handle cross-origin errors
                }
            });
        });
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
}

function filefolderListener(){
    // Listen for messages from page script
    window.addEventListener("message", (event) => {
        if (event.source !== window) return;
        const msg = event.data;

        if (msg && msg.source === "file-picker-hook") { //No I18N

            z = [];
            sendData = {};
            const fakeFileList = msg.files.map(f => ({
                name: f.name,
                size: f.size,
                type: f.type,
                lastModified: f.lastModified
            }));

            let o = { isFile: false };
            i(fakeFileList, o, "filefolderpicker"); //No I18N
            let match = evaluateRuleJSON(z);

            // Always reply with decision
            window.postMessage({
                source: "file-picker-decision", //No I18N
                requestId: msg.requestId,
                block: match
            }, currentTabUrl);

            if (match) {
                uploadblock(0, event, 0);
            }
        }
    }, false);
}


// Re-evaluate URL-based rules on every upload event for SPA sites.
//On SPAs the URL changes via History API without page reload, so the initial
//preUrlMatchCheck / sitesExcludeMatch may become stale.
//Used only for old (non-stacked) format where precomputed checks are used.
function refreshUrlMatchForSPA(ruleJSON) {
    var liveUrl = getCurrentUrl();
    if (liveUrl !== currentTabUrl) {
        currentTabUrl = liveUrl;
        preUrlMatchCheck = false;
        sitesExcludeMatch = false;

        let uploadFilter = Array.isArray(ruleJSON.uploadFilter) ? ruleJSON.uploadFilter[0] : ruleJSON.uploadFilter;
        var blocklist = uploadFilter.blocklist || {};
        var excludeList = uploadFilter.excludeList || {};
        var data = { url: currentTabUrl };

        if (blocklist.hasOwnProperty('sites') && blocklist.sites.length > 0) {
            preUrlMatchCheck = matchRules("sites", blocklist.sites, data);   //No I18N
            preMatchedDomain = violationData["domain"] || null;
            violationData = {};
        }
        if (excludeList.hasOwnProperty('sites') && excludeList.sites.length > 0) {
            sitesExcludeMatch = matchRules("sites", excludeList.sites, data);   //No I18N
            excludeMatchedDomain = violationData["domain"] || null;
            violationData = {};
        }

        preGenAIUrlMatchCheck = false;
        let genAIDomains = (uploadFilter.hasOwnProperty('genAIDomains') && uploadFilter.genAIDomains.length > 0) ? uploadFilter.genAIDomains    //No I18N
            : (ruleJSON.hasOwnProperty('GenAIDomains') && ruleJSON.GenAIDomains.length > 0) ? ruleJSON.GenAIDomains : null;  //No I18N
        if (genAIDomains) {
            preGenAIUrlMatchCheck = matchRules("sites", genAIDomains, data);   //No I18N
            violationData = {};
        }
    }
}

// Initialize content script
browser.runtime.sendMessage({
    "Request": "UploadCheck"    //No I18N
}, function (e) {
    uploadTracking = e.s;
    if (Object.keys(e.rule_json).length > 0 || uploadTracking) {
        preprocessUploadCheck(e.rule_json);
        s(e.rule_json);
    }
});

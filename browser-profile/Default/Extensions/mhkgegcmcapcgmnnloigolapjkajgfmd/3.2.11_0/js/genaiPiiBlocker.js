/**
 * genaiPiiBlocker.js — Content Script for GenAI DLP Protection
 *
 * Blocks or audits PII data input (typing / copy-pasting) on
 * Generative AI websites when the GenAI DLP Protection policy
 * is enabled.
 *
 * Detection flow:
 *   1. Ask service worker for GenAI DLP config (policyMode)
 *   2. If policy is active and is enabled, send a
 *      "GenAICheckCategory" trigger with the page URL to the service worker.
 *   3. The service worker forwards the URL to the native host which performs
 *      a DB-based domain lookup (webcategory.db) — no ML model used.
 *   4. The native host returns "GenAICategoryResult" with isGenAISite flag.
 *   5. If isGenAISite is true, PII monitoring is enabled on text input fields only.
 *
 * Upload/download restrictions on GenAI sites are handled by the existing
 * upload/download filter framework (default restriction popup) — this script
 * only handles PII text entry detection.
 *
 * Policy modes (from native host via service worker):
 *   0  → Block   — prevent PII input and show warning
 *   1  → Audit   — allow input but report violation
 *  -1  → Not Configured (disabled)
 *
 * Communicates with the service worker via chrome.runtime.sendMessage():
 *   - Request: "GenAIPIIBlockerConfig"  → get config
 *   - Request: "GenAICheckCategory"     → send URL for DB-based category check
 *   - Request: "GenAIPIIViolation"      → report violation
 *
 * Listens for service worker messages via chrome.runtime.onMessage:
 *   - action: "GenAICategoryResult"     → category result from native host
 *
 * Runs at document_idle on <all_urls>, all_frames: true.
 * Category check is only performed at tab load (mainframe/iframe), not
 * for sub-HTTP-requests.
 */
"use strict";  //No I18N

(function () {
    // ── State ─────────────────────────────────────────────────
    var policyMode = -1;     // -1 = not configured, 0 = block, 1 = audit
    var enabled = false;
    // ── PII detection patterns ────────────────────────────────
    // Note: email pattern is skipped on login/account pages (see isLoginPage)
    var PII_PATTERNS = [
        // Email addresses
        /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/,
        // SSN (US)
        /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/,
        // Credit card numbers (basic Luhn-eligible 13-19 digit sequences)
        /\b(?:\d[ \-]*?){13,19}\b/,
        // Phone numbers (international / US)
        /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}\b/,
        // IP addresses (IPv4)
        /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
        // API keys / tokens (long hex or base64 strings)
        /\b[A-Za-z0-9_\-]{32,}\b/,
        // Passport numbers (generic alphanumeric 6-9 chars)
        /\b[A-Z]{1,2}\d{6,8}\b/i
    ];

    var PII_TYPE_NAMES = [
        "Email",                                                          //No I18N
        "SSN",                                                            //No I18N
        "Credit Card",                                                    //No I18N
        "Phone Number",                                                   //No I18N
        "IP Address",                                                     //No I18N
        "API Key",                                                        //No I18N
        "Passport"                                                        //No I18N
    ];

    // Minimum text length before we start PII scanning (avoid false positives)
    var MIN_TEXT_LENGTH = 5;

    // ── Login page detection ──────────────────────────────────
    // Skip email validation on login / account / email login pages
    var LOGIN_PAGE_INDICATORS = [
        /login/i, /signin/i, /sign-in/i, /sign_in/i,
        /account/i, /auth/i, /oauth/i, /sso/i,
        /password/i, /credential/i
    ];

    /**
     * Detect if the current page is a login / account / email login page.
     * Checks URL path and common form attributes.
     */
    function isLoginPage() {
        var href = window.location.href.toLowerCase();
        for (var i = 0; i < LOGIN_PAGE_INDICATORS.length; i++) {
            if (LOGIN_PAGE_INDICATORS[i].test(href)) { return true; }
        }
        // Check for login form elements in the DOM
        var loginForms = document.querySelectorAll(
            'form[action*="login"], form[action*="signin"], form[action*="auth"], ' +  //No I18N
            'input[name="password"], input[type="password"], ' +                        //No I18N
            '[data-testid*="login"], [data-testid*="signin"]'                           //No I18N
        );
        return loginForms.length > 0;
    }

    /**
     * Detect if an element is inside a login / account / email login container.
     */
    function isInLoginContext(el) {
        var node = el;
        while (node && node !== document.body) {
            var id = (node.id || "").toLowerCase();
            var cls = (node.className || "");
            if (typeof cls !== "string") { cls = ""; }
            cls = cls.toLowerCase();
            var role = (node.getAttribute && node.getAttribute("role") || "").toLowerCase();  //No I18N
            var combined = id + " " + cls + " " + role;
            if (/login|signin|sign-in|sign_in|account|auth|email-login|email_login/.test(combined)) {
                return true;
            }
            node = node.parentElement;
        }
        return false;
    }

    // ── Bootstrap: Ask service worker for GenAI DLP config ────
    // Category check is only triggered at tab/iframe load time (document_idle).
    // No check is done for sub-HTTP-requests.
    try {
        chrome.runtime.sendMessage(
            { Request: "GenAIPIIBlockerConfig" },                            //No I18N
            function (response) {
                if (chrome.runtime.lastError) { return; }
                if (response && typeof response.policyMode !== "undefined") {
                    policyMode = response.policyMode;
                    if (policyMode !== -1) {
                        enabled = true;
                        attachListeners();
                    }
                }
            }
        );
    } catch (e) {
        // Extension context invalidated — silently exit
        return;
    }

    // ── Helpers ───────────────────────────────────────────────

    /**
     * Check if a text string contains PII data.
     * Returns the first matched PII type or null.
     * Skips email detection on login pages / login context elements.
     */
    function detectPII(text, sourceElement) {
        if (!text || typeof text !== "string") { return null; }
        if (text.length < MIN_TEXT_LENGTH) { return null; }

        var skipEmail = (sourceElement && isLoginContext(sourceElement));
        
		if (skipEmail){return null;}
		
        for (var i = 0; i < PII_PATTERNS.length; i++) {
            // Skip email pattern (index 0) on login / account pages
            //if (i === 0 && skipEmail) { continue; }
            if (PII_PATTERNS[i].test(text)) {
                return PII_TYPE_NAMES[i] || "unknown";                    //No I18N
            }
        }
        return null;
    }
    const isLoginContext = (target) => {
        const attrs = [
            target.getAttribute('type'),
            target.getAttribute('name'),
            target.getAttribute('id'),
            target.getAttribute('autocomplete'),
            target.placeholder,
            target.className
        ].map(a => (a || "").toLowerCase());

        const loginKeywords = ['email', 'login', 'signin', 'signup', 'user', 'pass', 'auth', 'company'];  //No I18N


        // Check attributes of the input itself
        const hasLoginAttr = attrs.some(a => loginKeywords.some(k => a.includes(k)));

        // Check parent form or container for context
        const parent = target.closest('form') || target.closest('[class="login"], [id="login"]'); //No I18N
        var hasLoginParent = false;
        if (parent) {
            const text = parent.innerText.toLowerCase();
            hasLoginParent = /log in|sign in|create account|password|identity/i.test(text);
        }

        const result = hasLoginAttr || hasLoginParent;
		// console.log(result)
       // console.log([PII Shield] Identified as Login Field: ${ result });
        return result;
    };





    /**
     * Redact all PII occurrences in a text string.
     * Replaces each matched PII pattern with "****".
     * Returns the redacted string.
     */
    function redactPII(text, sourceElement) {
        if (!text || typeof text !== "string") { return text; }
        var redacted = text;
        for (var i = 0; i < PII_PATTERNS.length; i++) {
            // Use global flag to replace ALL occurrences of each pattern
            var globalPattern = new RegExp(PII_PATTERNS[i].source, "gi");  //No I18N
            redacted = redacted.replace(globalPattern, "****");            //No I18N
        }
        return redacted;
    }

    /**
     * Show a visual warning overlay on the input element.
     * Displays BSP logo, warning message, and the detected PII type.
     */
    function showBlockWarning(el, piiType) {
        // Avoid duplicates
        if (el.dataset.genaiPiiBlocked) { return; }
        el.dataset.genaiPiiBlocked = "true";                              //No I18N

        var bspLogoUrl = "";                                              //No I18N
        try {
            bspLogoUrl = chrome.runtime.getURL("bsplogo.png");            //No I18N
        } catch (e) { /* extension context invalidated */ }

        var piiLabel = piiType ? piiType.replace(/_/g, " ").toUpperCase() : "UNKNOWN";  //No I18N

        // Inject stylesheet once
        if (!document.getElementById("genai-pii-styles-2")) {            //No I18N
            var sheet = document.createElement("style");                  //No I18N
            sheet.id = "genai-pii-styles-2";                              //No I18N
            sheet.textContent =
                "@keyframes genaiPiiFadeIn{from{opacity:0;transform:translate(-50%,-50%) translateY(-10px)}to{opacity:1;transform:translate(-50%,-50%)}}" +  //No I18N
                "@keyframes genaiPiiFadeOut{from{opacity:1;transform:translate(-50%,-50%)}to{opacity:0;transform:translate(-50%,-50%) translateY(-10px)}}" +  //No I18N
                "@keyframes genaiPiiOverlayIn{from{opacity:0}to{opacity:1}}" +  //No I18N
                ".gpii-card{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483647;" +  //No I18N
                "background:#fff;color:#333;padding:0;border-radius:12px;" +  //No I18N
                "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +  //No I18N
                "box-shadow:0 10px 40px rgba(0,0,0,0.18),0 2px 8px rgba(0,0,0,0.08);" +  //No I18N
                "border:1px solid #e0e0e0;min-width:380px;max-width:440px;" +  //No I18N
                "overflow:hidden;animation:genaiPiiFadeIn 0.3s ease forwards;" +  //No I18N
                "text-align:center;}" +                               //No I18N
                ".gpii-card--exit{animation:genaiPiiFadeOut 0.25s ease forwards;}" +  //No I18N
                ".gpii-overlay{position:fixed;top:0;left:0;width:100%;height:100%;" +  //No I18N
                "background:rgba(0,0,0,0.45);z-index:2147483646;" +   //No I18N
                "animation:genaiPiiOverlayIn 0.2s ease forwards;}" +  //No I18N
                ".gpii-close{position:absolute;top:10px;right:14px;background:none;border:none;" +  //No I18N
                "font-size:20px;color:#999;cursor:pointer;padding:4px 8px;line-height:1;" +  //No I18N
                "font-family:Arial,sans-serif;}" +                    //No I18N
                ".gpii-close:hover{color:#333;}" +                        //No I18N
                ".gpii-body{padding:28px 28px 18px;}" +                  //No I18N
                ".gpii-icon-wrap{display:flex;justify-content:center;margin-bottom:14px;}" +  //No I18N
                ".gpii-block-title{font-size:16px;font-weight:700;color:#d32f2f;margin-bottom:14px;}" +  //No I18N
                ".gpii-desc{font-size:13px;color:#555;line-height:1.6;margin-bottom:0;}" +  //No I18N
                ".gpii-pii-type{font-weight:700;color:#333;}" +           //No I18N
                ".gpii-footer{display:flex;align-items:center;justify-content:flex-end;" +  //No I18N
                "padding:10px 20px;border-top:1px solid #eee;background:#fafafa;}" +  //No I18N
                ".gpii-footer-logo{height:20px;width:auto;flex-shrink:0;background:none;}" +  //No I18N
                "@media(max-width:480px){" +                              //No I18N
                ".gpii-card{min-width:0;left:8px;right:8px;max-width:none;" +  //No I18N
                "transform:translateY(-50%);}" +                      //No I18N
                ".gpii-body{padding:20px 18px 14px;}}";              //No I18N
            document.head.appendChild(sheet);
        }

        // Overlay backdrop
        var overlay = document.createElement("div");                      //No I18N
        overlay.className = "gpii-overlay";                               //No I18N
        overlay.addEventListener("click", function () {                   //No I18N
            dismissWarning();
        });

        // Card container
        var card = document.createElement("div");                         //No I18N
        card.className = "gpii-card";                                    //No I18N

        // Close button
        var closeBtn = document.createElement("button");                  //No I18N
        closeBtn.className = "gpii-close";                                //No I18N
        closeBtn.textContent = "\u00D7";                                  //No I18N
        closeBtn.setAttribute("aria-label", "Close");                     //No I18N
        closeBtn.addEventListener("click", function () {                  //No I18N
            dismissWarning();
        });
        card.appendChild(closeBtn);

        // Body
        var body = document.createElement("div");                         //No I18N
        body.className = "gpii-body";                                    //No I18N

        // Centered blocked icon (shield with slash)
        var iconWrap = document.createElement("div");                     //No I18N
        iconWrap.className = "gpii-icon-wrap";                            //No I18N

        var blockSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");  //No I18N
        blockSvg.setAttribute("viewBox", "0 0 512 512");                  //No I18N
        blockSvg.setAttribute("width", "52");                             //No I18N
        blockSvg.setAttribute("height", "52");                            //No I18N

        var path1 = document.createElementNS("http://www.w3.org/2000/svg", "path");  //No I18N
        path1.setAttribute("d", "M152.43,153.96c-7.12,0-12.89,5.76-12.89,12.89s5.76,12.89,12.89,12.89h102.76c7.12,0,12.89-5.76,12.89-12.89s-5.76-12.89-12.89-12.89h-102.76Z");  //No I18N
        blockSvg.appendChild(path1);

        var path2 = document.createElementNS("http://www.w3.org/2000/svg", "path");  //No I18N
        path2.setAttribute("d", "M187.57,436.44h-19.66c-30.38,0-45.64,0-55.28-4.92-8.56-4.37-15.38-11.19-19.74-19.71-4.91-9.65-4.91-24.9-4.91-55.28v-201.07c0-30.38,0-45.63,4.91-55.27,4.35-8.53,11.18-15.36,19.71-19.71,9.67-4.92,24.92-4.92,55.31-4.92h123.73c30.38,0,45.64,0,55.28,4.92,8.53,4.34,15.36,11.16,19.71,19.72,4.08,7.98,4.81,19.85,4.91,43.41.03,7.1,5.79,12.84,12.89,12.84,7.2.98,12.91-5.8,12.89-12.94-.1-25.03-.68-41.23-7.73-55.03-6.85-13.43-17.57-24.15-30.96-30.98-15.15-7.73-32.47-7.73-66.99-7.73h-123.73c-34.51,0-51.83,0-67.01,7.73-13.42,6.85-24.14,17.56-30.96,30.98-7.73,15.15-7.73,32.47-7.73,66.97v201.07c0,34.5,0,51.82,7.73,66.99,6.82,13.4,17.55,24.1,30.96,30.96,15.18,7.74,32.5,7.74,67.01,7.74h19.66c7.12,0,12.89-5.76,12.89-12.89s-5.76-12.89-12.89-12.89Z");  //No I18N
        blockSvg.appendChild(path2);

        var path3 = document.createElementNS("http://www.w3.org/2000/svg", "path");  //No I18N
        path3.setAttribute("d", "M204.01,231.29h-51.58c-7.12,0-12.89,5.76-12.89,12.89s5.76,12.89,12.89,12.89h51.58c7.12,0,12.89-5.76,12.89-12.89s-5.76-12.89-12.89-12.89Z");  //No I18N
        blockSvg.appendChild(path3);

        var path4 = document.createElementNS("http://www.w3.org/2000/svg", "path");  //No I18N
        path4.setAttribute("d", "M348.38,249.65c-56.01,0-101.4,45.41-101.4,101.42s45.39,101.41,101.4,101.41,101.42-45.41,101.42-101.42-45.41-101.42-101.42-101.42ZM348.38,427.12c-42,0-76.06-34.05-76.06-76.06,0-16.42,5.32-31.54,14.18-43.96l105.84,105.84c-12.43,8.85-27.54,14.17-43.97,14.17ZM410.27,395.03l-105.84-105.85c12.43-8.84,27.53-14.17,43.95-14.17,42.01,0,76.06,34.05,76.06,76.06,0,16.42-5.32,31.53-14.17,43.96Z");  //No I18N
        blockSvg.appendChild(path4);

        iconWrap.appendChild(blockSvg);
        body.appendChild(iconWrap);

        // Red title
        var blockTitle = document.createElement("div");                   //No I18N
        blockTitle.className = "gpii-block-title";                        //No I18N
        blockTitle.textContent = "PII Input Blocked";                     //No I18N
        body.appendChild(blockTitle);

        // Description with bold PII type
        var desc = document.createElement("div");                         //No I18N
        desc.className = "gpii-desc";                                     //No I18N

        var descPre = document.createTextNode("The input of type ");      //No I18N
        var descBold = document.createElement("strong");                  //No I18N
        descBold.className = "gpii-pii-type";                             //No I18N
        descBold.textContent = piiLabel;
        var descPost = document.createTextNode(" has been blocked by your administrator.");  //No I18N

        desc.appendChild(descPre);
        desc.appendChild(descBold);
        desc.appendChild(descPost);
        body.appendChild(desc);

        card.appendChild(body);

        // Footer with branding
        var footer = document.createElement("div");                       //No I18N
        footer.className = "gpii-footer";                                 //No I18N

        var fLogo = document.createElement("img");                        //No I18N
        fLogo.src = bspLogoUrl || "bsplogo.png";                          //No I18N
        fLogo.alt = "Browser Security Plus";                              //No I18N
        fLogo.className = "gpii-footer-logo";                             //No I18N
        footer.appendChild(fLogo);

        card.appendChild(footer);
        (document.body || document.documentElement).appendChild(overlay);
        (document.body || document.documentElement).appendChild(card);

        // Dismiss helper
        function dismissWarning() {
            card.className = "gpii-card gpii-card--exit";                //No I18N
            overlay.style.opacity = "0";                                  //No I18N
            overlay.style.transition = "opacity 0.25s ease";              //No I18N
            setTimeout(function () {
                if (card.parentNode) { card.parentNode.removeChild(card); }
                if (overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
                delete el.dataset.genaiPiiBlocked;
            }, 250);
        }

    }
    function isLexicalEditor(el) {
        return el && el.closest('[data-lexical-editor="true"]');
    }
    /**
     * Report a GenAI PII violation to the service worker.
     * Rule type 10 is used for audit violations.
     */
    function reportViolation(piiType, action, sourceElement) {
        var pageUrl = window.location.href;
        var pageTitle = document.title || "";

        try {
            chrome.runtime.sendMessage({
                Request: "GenAIPIIViolation",                          //No I18N
                pii_type: piiType,
                action: action,
                url: pageUrl,
                title: pageTitle,
                rule_type: 10,
                field_type: sourceElement ? (sourceElement.type || sourceElement.tagName || "unknown") : "unknown",  //No I18N
                field_name: sourceElement ? (sourceElement.name || sourceElement.id || "") : "",                     //No I18N
                timestamp: Date.now()
            });
        } catch (e) {
            // Extension context invalidated
        }
    }

    // ── Input Monitoring ──────────────────────────────────────
    // PII detection runs only on text entry (typing / copy-paste).
    // Image uploads and file attachments are NOT validated here —
    // upload/download restrictions use the default upload/download
    // filter framework instead.

    /**
     * Debounce helper.
     */
    function debounce(fn, delay) {
        var timer = null;
        return function () {
            var context = this;
            var args = arguments;
            clearTimeout(timer);
            timer = setTimeout(function () {
                fn.apply(context, args);
            }, delay);
        };
    }

    /**
     * Check an element's value for PII and block/audit.
     * Only runs on text input — not on file inputs or image uploads.
     */
    function handlePIICheck(el) {
        if (!enabled) { return; }

        // Skip file inputs — upload restriction is handled by the
        // default upload/download filter framework
        if (el.tagName === "INPUT" && el.type === "file") { return; }

        var value = "";
        var root = el;  // Will be overridden for contentEditable
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            value = el.value || "";
        } else if (el.isContentEditable) {
            // Get the [contenteditable="true"] root — el may be a child
            // <span> or <p> that only has partial text (e.g. pasted fragment)
            root = el.closest('[contenteditable="true"]') || el;
            value = root.textContent || root.innerText || "";
        }

        var piiType = detectPII(value, el);
        if (!piiType) { return; }

        if (policyMode === 0) {
            // BLOCK mode — redact PII with **** and show warning
            var redacted = redactPII(value, el);
            
            if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
                // Must use the correct prototype matching the element type
                var nativeProto = el.tagName === "TEXTAREA" //No I18N
                    ? window.HTMLTextAreaElement.prototype
                    : window.HTMLInputElement.prototype;
                var nativeInputValueSetter = Object.getOwnPropertyDescriptor(nativeProto, 'value'); //No I18N
                if (nativeInputValueSetter && nativeInputValueSetter.set) {
                    nativeInputValueSetter.set.call(el, redacted);
                } else {
                    el.value = redacted;
                }
                // Dispatch input event so React/Vue/Angular picks up the change
                el.dispatchEvent(new Event('input', { bubbles: true })); //No I18N
                el.dispatchEvent(new Event('change', { bubbles: true })); //No I18N
            } else if (el.isContentEditable) {
                //console.log("ContentEditable redaction:", value, redacted)
                if (isLexicalEditor(root)) {
                    try {
                        root.focus();

                        var sel = window.getSelection();
                        if (sel) {
                            var range = document.createRange();
                            range.selectNodeContents(root);
                            sel.removeAllRanges();
                            sel.addRange(range);
                        }

                        root.dispatchEvent(new InputEvent("beforeinput", {  //No I18N
                            inputType: "insertReplacementText",           //No I18N
                            data: redacted,
                            bubbles: true,
                            cancelable: true,
                            composed: true
                        }));

                    } catch (e) {
                        root.textContent = redacted;
                    }
                } else {
                    root.textContent = redacted;
                }

            }
            showBlockWarning(el, piiType);
            reportViolation(piiType, "blocked", el);                      //No I18N
        } else if (policyMode === 1) {
            // AUDIT mode — allow input but report violation
            reportViolation(piiType, "audited", el);                      //No I18N
        }
    }

    /**
     * Debounced handler for input/change events (400ms).
     * Only processes text input elements — file inputs are ignored.
     */
    var debouncedPIICheck = debounce(function (evt) {
        var target = evt.target;
        if (!target) { return; }
        // Skip file inputs — handled by upload filter framework
        if (target.tagName === "INPUT" && target.type === "file") { return; }
        var tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
            handlePIICheck(target);
        }
    }, 400);

    /**
     * Handler for paste events — block PII immediately on paste.
     * Only processes text paste — not file/image paste.
     */
    function onPaste(evt) {
        if (!enabled) { return; }
        var target = evt.target;
        if (!target) { return; }
        // Skip file inputs — handled by upload filter framework
        if (target.tagName === "INPUT" && target.type === "file") { return; }
        var tag = target.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA" && !target.isContentEditable) { return; }

        // Let the paste happen natively, then check the full value
        // after it's applied to the DOM. handlePIICheck will read
        // the complete text, redact PII, and set it back.
        setTimeout(function () { handlePIICheck(target); }, 0);
    }

    /**
     * Handler for keydown — immediate PII check when Enter is pressed.
     * Bypasses the 400ms debounce so PII cannot slip through on submit.
     */
    function onKeyDown(evt) {
        if (!enabled) { return; }
        if (evt.key !== "Enter" && evt.keyCode !== 13) { return; }        //No I18N
        var target = evt.target;
        if (!target) { return; }
        if (target.tagName === "INPUT" && target.type === "file") { return; }
        var tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
            var value = "";
            if (tag === "INPUT" || tag === "TEXTAREA") {
                value = target.value || "";
            } else if (target.isContentEditable) {
                value = target.textContent || target.innerText || "";
            }
            var piiType = detectPII(value, target);
            if (piiType && policyMode === 0) {
                evt.preventDefault();
                evt.stopImmediatePropagation();
                // Redact PII before the Enter submits
                handlePIICheck(target);
            }
        }
    }

    /**
     * Handler for beforeinput — catches Enter (insertParagraph) on
     * contentEditable elements that don't always fire keydown.
     */
    function onBeforeInput(evt) {
        if (!enabled) { return; }
        if (evt.inputType !== "insertParagraph" && evt.inputType !== "insertLineBreak") { return; }  //No I18N
        var target = evt.target;
        if (!target || !target.isContentEditable) { return; }
        var value = target.textContent || target.innerText || "";
        var piiType = detectPII(value, target);
        if (piiType && policyMode === 0) {
            evt.preventDefault();
            evt.stopImmediatePropagation();
            handlePIICheck(target);
        }
    }

    // ── MutationObserver: watch for dynamically added inputs ──

    var observer = null;

    function onMutations(mutations) {
        for (var i = 0; i < mutations.length; i++) {
            var added = mutations[i].addedNodes;
            if (!added) { continue; }
            for (var j = 0; j < added.length; j++) {
                var node = added[j];
                if (node.nodeType !== Node.ELEMENT_NODE) { continue; }
                if (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.isContentEditable) {
                    // Skip file inputs — handled by upload filter
                    if (!(node.tagName === "INPUT" && node.type === "file")) {
                        node.addEventListener("input", debouncedPIICheck, { passive: true });   //No I18N
                        node.addEventListener("paste", onPaste);                                //No I18N
                        node.addEventListener("keydown", onKeyDown, true);                      //No I18N
                        node.addEventListener("beforeinput", onBeforeInput, true);              //No I18N
                    }
                }
                var childInputs = node.querySelectorAll
                    ? node.querySelectorAll('input[type="text"], input[type="email"], input:not([type]), textarea, [contenteditable="true"]')  //No I18N
                    : [];
                for (var k = 0; k < childInputs.length; k++) {
                    // Skip file inputs
                    if (childInputs[k].tagName === "INPUT" && childInputs[k].type === "file") { continue; }
                    childInputs[k].addEventListener("input", debouncedPIICheck, { passive: true });   //No I18N
                    childInputs[k].addEventListener("paste", onPaste);                                //No I18N
                    childInputs[k].addEventListener("keydown", onKeyDown, true);                      //No I18N
                    childInputs[k].addEventListener("beforeinput", onBeforeInput, true);              //No I18N
                }
            }
        }
    }

    // ── Main attach ───────────────────────────────────────────

    function attachListeners() {
        var inputs = document.querySelectorAll(
            'input[type="text"], input[type="email"], input:not([type]), textarea, [contenteditable="true"]'  //No I18N
        );
        for (var i = 0; i < inputs.length; i++) {
            // Skip file inputs — handled by upload filter framework
            if (inputs[i].tagName === "INPUT" && inputs[i].type === "file") { continue; }
            inputs[i].addEventListener("input", debouncedPIICheck, { passive: true });   //No I18N
            inputs[i].addEventListener("paste", onPaste);                                //No I18N
            inputs[i].addEventListener("keydown", onKeyDown, true);                      //No I18N
            inputs[i].addEventListener("beforeinput", onBeforeInput, true);              //No I18N
        }

        // Event delegation
        document.addEventListener("input", debouncedPIICheck, { passive: true });        //No I18N
        document.addEventListener("paste", onPaste, true);                               //No I18N
        document.addEventListener("keydown", onKeyDown, true);                           //No I18N
        document.addEventListener("beforeinput", onBeforeInput, true);                   //No I18N

        // MutationObserver for SPAs
        observer = new MutationObserver(onMutations);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    // ── Cleanup on navigation ─────────────────────────────────
    window.addEventListener("beforeunload", function () {                //No I18N
        if (observer) {
            observer.disconnect();
            observer = null;
        }
    });

})();

/**
 * emailCapture.js — Content Script for Enterprise Email Detection
 *
 * Monitors all input fields (text, email, hidden, and contenteditable)
 * for email addresses matching enterprise domains loaded from the
 * native host config (bmagent/data/enterprise_domain.json).
 *
 * Communicates captured emails back to the service worker via
 * chrome.runtime.sendMessage().
 *
 * Runs at document_idle on <all_urls>, all_frames: true.
 */
"use strict";  //No I18N

(function () {

    // ── State ─────────────────────────────────────────────────
    var enterpriseDomains = [];                 // ["sample.com", ...]
    var capturedEmails    = {};                 // de-dup: email → true
    var enabled           = false;
    var EMAIL_REGEX       = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

    // ── Bootstrap: Ask service worker for enterprise domains ──
    try {
        chrome.runtime.sendMessage(
            { Request: "EmailCaptureConfig" },  //No I18N
            function (response) {
                if (chrome.runtime.lastError) { return; }
                if (response && response.domains && response.domains.length > 0) {
                    enterpriseDomains = response.domains.map(function (d) {
                        return d.toLowerCase();
                    });
                    enabled = true;
                    attachListeners();
                }
            }
        );
    } catch (e) {
        // Extension context invalidated — silently exit
        return;
    }

    // ── Helpers ───────────────────────────────────────────────

    /**
     * Check if an email address belongs to one of the enterprise domains.
     */
    function isEnterpriseDomain(email) {
        var atIndex = email.lastIndexOf("@");
        if (atIndex === -1) { return false; }
        var domain = email.substring(atIndex + 1).toLowerCase();
        for (var i = 0; i < enterpriseDomains.length; i++) {
            if (domain === enterpriseDomains[i]) { return true; }
        }
        return false;
    }

    /**
     * Extract all enterprise-matching emails from a given string value.
     */
    function extractEnterpriseEmails(value) {
        if (!value || typeof value !== "string") { return []; }
        var matches = value.match(EMAIL_REGEX);
        if (!matches) { return []; }
        var result = [];
        for (var i = 0; i < matches.length; i++) {
            if (isEnterpriseDomain(matches[i]) && !capturedEmails[matches[i].toLowerCase()]) {
                result.push(matches[i].toLowerCase());
            }
        }
        return result;
    }

    /**
     * Report captured emails to the service worker.
     */
    function reportEmails(emails, sourceElement) {
        if (emails.length === 0) { return; }
        for (var i = 0; i < emails.length; i++) {
            capturedEmails[emails[i]] = true;
        }

        var pageUrl = window.location.href;
        var pageTitle = document.title || "";

        try {
            chrome.runtime.sendMessage({
                Request: "EmailCaptured",                       //No I18N
                emails:  emails,
                url:     pageUrl,
                title:   pageTitle,
                field_type: sourceElement ? (sourceElement.type || sourceElement.tagName || "unknown") : "unknown",  //No I18N
                field_name: sourceElement ? (sourceElement.name || sourceElement.id || "") : "",                     //No I18N
                timestamp: Date.now()
            });
        } catch (e) {
            // Extension context invalidated
        }
    }

    // ── Input Monitoring ──────────────────────────────────────

    /**
     * Process a single input/textarea element for enterprise emails.
     */
    function checkElement(el) {
        if (!enabled) { return; }
        var value = "";
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
            value = el.value || "";
        } else if (el.isContentEditable) {
            value = el.textContent || el.innerText || "";
        }
        var emails = extractEnterpriseEmails(value);
        if (emails.length > 0) {
            reportEmails(emails, el);
        }
    }

    /**
     * Debounce helper to avoid excessive processing on fast typing.
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
     * Handler for input/change events — debounced at 500ms.
     */
    var debouncedCheck = debounce(function (evt) {
        var target = evt.target;
        if (!target) { return; }
        var tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) {
            checkElement(target);
        }
    }, 500);

    /**
     * Handler for paste events — checks the clipboard data immediately
     * so pasted enterprise emails are captured without waiting for the
     * debounced input cycle.  Also re-checks the element after a short
     * delay so autofill / JS-modified paste values are caught.
     */
    function onPaste(evt) {
        if (!enabled) { return; }
        var target = evt.target;
        if (!target) { return; }
        var tag = target.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA" && !target.isContentEditable) { return; }

        // 1. Check the raw clipboard text (available synchronously)
        var clipboardData = evt.clipboardData || (window.clipboardData);
        if (clipboardData) {
            var pasted = clipboardData.getData("text") || "";            //No I18N
            var emails = extractEnterpriseEmails(pasted);
            if (emails.length > 0) {
                reportEmails(emails, target);
            }
        }

        // 2. Re-check the field after the paste has been applied to the DOM
        setTimeout(function () { checkElement(target); }, 50);
    }

    /**
     * Scan all existing input/textarea elements on the page.
     */
    function scanExistingFields() {
        var inputs = document.querySelectorAll(
            'input[type="email"], input[type="text"], input[type="hidden"], input:not([type]), textarea, [contenteditable="true"]'  //No I18N
        );
        for (var i = 0; i < inputs.length; i++) {
            checkElement(inputs[i]);
        }
    }

    /**
     * Also capture form submissions — some emails are populated
     * by autofill just before submit and don't trigger input events.
     */
    function onFormSubmit(evt) {
        if (!enabled) { return; }
        var form = evt.target;
        if (!form || form.tagName !== "FORM") { return; }
        var inputs = form.querySelectorAll(
            'input[type="email"], input[type="text"], input[type="hidden"], input:not([type]), textarea'  //No I18N
        );
        for (var i = 0; i < inputs.length; i++) {
            checkElement(inputs[i]);
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
                    // Attach listener to newly added input
                    node.addEventListener("input", debouncedCheck, { passive: true });      //No I18N
                    node.addEventListener("change", debouncedCheck, { passive: true });     //No I18N
                    node.addEventListener("paste", onPaste);                                //No I18N
                }
                // Also check descendants
                var childInputs = node.querySelectorAll
                    ? node.querySelectorAll('input[type="email"], input[type="text"], input:not([type]), textarea, [contenteditable="true"]')  //No I18N
                    : [];
                for (var k = 0; k < childInputs.length; k++) {
                    childInputs[k].addEventListener("input", debouncedCheck, { passive: true });   //No I18N
                    childInputs[k].addEventListener("change", debouncedCheck, { passive: true });  //No I18N
                    childInputs[k].addEventListener("paste", onPaste);                             //No I18N
                }
            }
        }
    }

    // ── Main attach ───────────────────────────────────────────

    function attachListeners() {
        // Listen on all existing inputs
        var inputs = document.querySelectorAll(
            'input[type="email"], input[type="text"], input[type="hidden"], input:not([type]), textarea, [contenteditable="true"]'  //No I18N
        );
        for (var i = 0; i < inputs.length; i++) {
            inputs[i].addEventListener("input", debouncedCheck, { passive: true });      //No I18N
            inputs[i].addEventListener("change", debouncedCheck, { passive: true });     //No I18N
            inputs[i].addEventListener("paste", onPaste);                                //No I18N
        }

        // Event delegation on document for bubbling input/change/paste events
        document.addEventListener("input", debouncedCheck, { passive: true });           //No I18N
        document.addEventListener("change", debouncedCheck, { passive: true });          //No I18N
        document.addEventListener("paste", onPaste);                                    //No I18N

        // Capture form submissions
        document.addEventListener("submit", onFormSubmit, true);                         //No I18N

        // Watch for dynamically added DOM nodes (SPAs, lazy-loaded forms)
        observer = new MutationObserver(onMutations);
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        // One initial scan for pre-populated fields (autofill, SSR)
        scanExistingFields();
    }

    // ── Cleanup on navigation ─────────────────────────────────
    window.addEventListener("beforeunload", function () {             //No I18N
        if (observer) {
            observer.disconnect();
            observer = null;
        }
    });

})();

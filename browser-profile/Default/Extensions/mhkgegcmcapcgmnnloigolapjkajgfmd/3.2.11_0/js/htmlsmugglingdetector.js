/**
 * htmlsmugglingdetector.js — HTML Smuggling Detector
 *
 * Content script for Browser Security Plus.
 * Injected via scripting.executeScript into MAIN world, all frames.
 */
(() => {
  "use strict"; //No I18N

  if (window.__bsp_html_smuggling_detector__) { return; }
  window.__bsp_html_smuggling_detector__ = true;

  var _reported = false;

  // Coalesce MutationObserver bursts into one scan instead of one per batch.
  var SCAN_DEBOUNCE_MS = 750;

  function describeEl(el) {
    if (!el) { return null; }
    var tag = (el.tagName || "?").toLowerCase();
    var id  = el.id ? "#" + el.id : "";               //No I18N
    var cls = "";
    if (el.className && typeof el.className === "string") {
      cls = "." + el.className.trim().split(/\s+/).join(".");  //No I18N
    }
    return tag + id + cls;
  }

  function reportSmuggling(detail, payloadStr, element, mitreIds) {
    if (_reported) { return; }
    _reported = true;

    var threat = {
      name:      "html_smuggling", //No I18N
      severity:  "critical",       //No I18N
      detail:    detail,
      element:   describeEl(element),
      timestamp: Date.now(),
      category:  "html_smuggling", //No I18N
      signalKey: "html_smuggling", //No I18N
      weight:    60,
      tier:      "T3:Content",     //No I18N
      mitreIds:  mitreIds || ["T1027", "T1566"], //No I18N
      ruleIds:   [],
      payload:   payloadStr || ""
    };

    var report = {
      Request: "ClickFixDetection", //No I18N
      threat_type: "html_smuggling", //No I18N
      scores: { html_smuggling: 60 },
      threats: [threat],
      url: window.location.href,
      title: document.title || "",
      severity_id: 1, // Critical
      severity: "critical", //No I18N
      timestamp: Date.now()
    };

    try {
      window.postMessage({
        source: "__bsp_clickfix_report__", //No I18N
        report: report
      }, "*"); //No I18N
    } catch(e) {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TIER 1 — DOWNLOAD INTERCEPTION
  // ═══════════════════════════════════════════════════════════════════════════

  function monitorDownloadTriggers() {
    var originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.href && (this.href.startsWith("data:") || this.href.startsWith("blob:"))) { //No I18N
        var dlAttr = this.getAttribute("download"); //No I18N
        if (dlAttr && /\.(iso|zip|exe|dll|cpl)$/i.test(dlAttr)) {
          reportSmuggling("HTML Smuggling: Programmatic click on Data/Blob URI with executable download", "file=" + dlAttr, this, ["T1027", "T1566"]); //No I18N
        }
      }
      return originalClick.apply(this, arguments);
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TIER 2 — DOM STRUCTURAL ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════

  function analyzeDOM() {
    // ── data: / blob: URIs ──
    var suspiciousLinks = document.querySelectorAll("a[href^='data:'], a[href^='blob:']"); //No I18N
    if (suspiciousLinks.length > 0) {
      for (var sl = 0; sl < suspiciousLinks.length; sl++) {
        var dlAttr = suspiciousLinks[sl].getAttribute("download"); //No I18N
        if (dlAttr && /\.(iso|zip|exe|dll|cpl)$/i.test(dlAttr)) {
          reportSmuggling("HTML Smuggling: Data/Blob URI with executable download", "file=" + dlAttr, suspiciousLinks[sl], ["T1027", "T1566"]); //No I18N
        }
      }
    }
  }

  function init() {
    monitorDownloadTriggers();

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        analyzeDOM();
      });
    } else {
      analyzeDOM();
    }

    if (typeof MutationObserver === "function") {
      var observer   = null;
      var scanTimer  = null;

      var stopObserver = function () {
        if (observer) { observer.disconnect(); observer = null; }
        if (scanTimer !== null) { clearTimeout(scanTimer); scanTimer = null; }
      };

      observer = new MutationObserver(function (mutations) {
        // Once reported, nothing further is sent — stop observing entirely.
        if (_reported) { stopObserver(); return; }
        if (scanTimer !== null) { return; }

        var needsCheck = false;
        for (var i = 0; i < mutations.length && !needsCheck; i++) {
          var added = mutations[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            // Text-node churn cannot introduce an <a href="data:"> link.
            if (added[j].nodeType === 1) { needsCheck = true; break; }
          }
        }
        if (!needsCheck) { return; }

        // Coalesce mutation bursts instead of re-scanning per batch.
        scanTimer = setTimeout(function () {
          scanTimer = null;
          if (_reported) { stopObserver(); return; }
          analyzeDOM();
          if (_reported) { stopObserver(); }
        }, SCAN_DEBOUNCE_MS);
      });

      observer.observe(document, { childList: true, subtree: true });
    }
  }

  init();

})();

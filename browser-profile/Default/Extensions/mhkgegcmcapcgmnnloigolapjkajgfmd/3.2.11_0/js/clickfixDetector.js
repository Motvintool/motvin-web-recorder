/**
 * clickfixDetector.js — ClickFix / PasteJack / Clickjacking Detector
 *
 * Content script for Browser Security Plus.
 * Injected via scripting.executeScript into MAIN world, all frames.
 *
 * Detection hierarchy:
 *   TIER 1 — Behavioral API monitoring (hardest to evade)
 *   TIER 2 — DOM structural analysis (language-independent)
 *   TIER 3 — Content analysis: entropy, Base64, deobfuscation, command syntax
 *   Clickjacking & PasteJacking remain as separate category detectors.
 *
 * Reports detected threats to contentScript.js via window.postMessage
 * (since chrome.runtime is not available in MAIN world).
 * contentScript.js relays the report to the service-worker.
 */

(() => {
  "use strict"; //No I18N

  if (window.__bsp_clickfix_detector__) { return; }
  window.__bsp_clickfix_detector__ = true;

  // ═══════════════════════════════════════════════════════════════════════════
  //  SCORING ENGINE
  // ═══════════════════════════════════════════════════════════════════════════

  var threats = [];
  var scoreBoard = { clickjacking: 0, pastejacking: 0, clickfix: 0 };
  var _commandDetected = false;

  // ── Performance guards ────────────────────────────────────────────────────
  // The DOM/content scan is expensive (forced layout via getComputedStyle,
  // ~80 regexes plus brute-force atob() per text block). It used to run in full
  // on every MutationObserver batch, which on any dynamic page means constantly.
  // These caps + caches keep re-scans bounded and skip work already done.
  // A pass now costs time proportional to what changed, not to page size, so a
  // short debounce is affordable and no cap on the number of passes is needed.
  var SCAN_DEBOUNCE_MS          = 250;   // coalesce mutation bursts
  var BACKLOG_DELAY_MS          = 25;    // yield between start-up sweep chunks
  var MAX_STYLE_CHECKS_PER_PASS = 400;   // new elements style-checked per pass
  var MAX_PENDING_ROOTS         = 100;   // beyond this, one sweep beats many visits
  var MAX_BODY_TEXT             = 50000; // chars of text scanned for Base64
  var MAX_THREATS               = 200;   // cap the threats array

  var _scanScheduled   = false;
  var _scanningDone    = false;
  var _scanTimer       = null;
  var _observer        = null;
  var _lastBodyText    = null;
  var _initialScanDone = false;
  var _styleBacklog    = false;   // style budget hit; more elements still to check
  var _pendingFull     = false;   // next pass sweeps the whole document
  var _pendingRoots    = new Set();

  // Per-scan-site element tracking. Separate sets per call site: a single shared
  // set would let the first loop that touches an element suppress the unrelated
  // checks the other loops perform on it.
  var _styledIframes   = new WeakSet();  // style-checked once; style churn is not worth a relayout
  var _styledDivs      = new WeakSet();
  var _styledModals    = new WeakSet();
  var _scriptsSeen     = new WeakSet();
  var _hiddenTextSeen  = new WeakMap();  // el -> text length, so content changes re-trigger
  var _overlaysSeen    = new WeakMap();
  var _codeBlocksSeen  = new WeakMap();

  var SCORE_THRESHOLDS = {
    clickjacking: 75,
    pastejacking: 40,
    clickfix: 55
  };

  // ── Signal weights by tier ─────────────────────────────────────────────────
  var SIGNAL_WEIGHTS = {
    // ── Clickjacking ──
    page_in_iframe:            30,
    hidden_iframe:             50,
    fullscreen_overlay_iframe: 40,
    pointer_passthrough:       35,
    invisible_overlay_div:     35,
    missing_xfo_csp:           15,

    // ── PasteJacking ──
    oncopy_handler:            35,
    hidden_text_payload:       45,
    hidden_shell_text:         50,
    clipboard_write_api:       30,
    execcommand_copy:          25,
    clipboard_data_overwrite:  50,
    clipboard_dangerous_payload: 60,

    // ── TIER 1: Behavioral (ClickFix) ──
    clipboard_no_gesture:      60,
    clipboard_command_content: 60,
    clipboard_early_write:     45,
    keyboard_intercept:        40,
    paste_event_intercept:     35,
    focus_trap:                30,
    drag_and_drop_command:     60,
    iframe_clipboard_command:  60,
    visible_command_copy:      20,

    // ── TIER 2: Structural (ClickFix) ──
    dom_overlay_with_steps:    50,
    dom_overlay_with_code:     45,
    dom_overlay_with_action:   40,
    dom_structure_combo:       55,
    fake_captcha_no_provider:  45,
    suspicious_modal_elements: 35,

    // ── TIER 3: Content Analysis (ClickFix) ──
    code_block_high_entropy:   40,
    base64_malicious_payload:  55,
    deobfuscated_malicious:    50,
    command_syntax_detected:   50,
    data_blob_uri:             15
  };

  var _seenSignals = {};
  var _threatKeys  = {};

  function addSignal(category, signalKey, name, detail, element, mitreIds, ruleIds, payload) {
    var weight = SIGNAL_WEIGHTS[signalKey] || 20;
    
    // Prevent the same signal from heavily inflating the score repeatedly
    if (!_seenSignals[signalKey]) {
      _seenSignals[signalKey] = true;
      scoreBoard[category] = (scoreBoard[category] || 0) + weight;
    }

    var severity;
    if (weight >= 50) { severity = "critical"; }          //No I18N
    else if (weight >= 35) { severity = "high"; }         //No I18N
    else if (weight >= 20) { severity = "medium"; }       //No I18N
    else { severity = "low"; }                            //No I18N

    var tier;
    if (["clipboard_no_gesture", "clipboard_command_content", "clipboard_early_write", //No I18N
         "keyboard_intercept", "paste_event_intercept", "focus_trap", //No I18N
         "drag_and_drop_command", "iframe_clipboard_command", "visible_command_copy"].indexOf(signalKey) !== -1) { //No I18N
      tier = "T1:Behavioral";                         //No I18N
    } else if (["dom_overlay_with_steps", "dom_overlay_with_code", "dom_overlay_with_action", //No I18N
              "dom_structure_combo", "fake_captcha_no_provider", "suspicious_modal_elements"].indexOf(signalKey) !== -1) { //No I18N
      tier = "T2:Structural";                         //No I18N
    } else if (["code_block_high_entropy", "base64_malicious_payload", "deobfuscated_malicious", //No I18N
              "command_syntax_detected", "data_blob_uri"].indexOf(signalKey) !== -1) { //No I18N
      tier = "T3:Content";                            //No I18N
    } else {
      tier = "Detection";                             //No I18N
    }

    // Bound the threats array: without this it grows unbounded across re-scans
    // and adds GC pressure for no added detection value.
    var elDesc     = describeEl(element);
    var payloadStr = payload || "";
    var dedupeKey  = signalKey + "|" + (detail || "") + "|" + (elDesc || "") +
                     "|" + payloadStr.substring(0, 200);                        //No I18N
    if (_threatKeys[dedupeKey]) { return; }
    if (threats.length >= MAX_THREATS) { return; }
    _threatKeys[dedupeKey] = true;

    threats.push({
      name:      name,
      severity:  severity,
      detail:    detail,
      element:   elDesc,
      timestamp: Date.now(),
      category:  category,
      signalKey: signalKey,
      weight:    weight,
      tier:      tier,
      mitreIds:  mitreIds || [],
      ruleIds:   ruleIds || [],
      payload:   payloadStr
    });
  }

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

  // ═══════════════════════════════════════════════════════════════════════════
  //  UTILITY — USER GESTURE TRACKING
  // ═══════════════════════════════════════════════════════════════════════════

  var _insideUserGesture   = false;
  var _lastUserGestureTime = 0;

  function trackUserGestures() {
    var gestureEvents = ["click", "mousedown", "keydown", "keypress", "touchstart", "pointerdown"]; //No I18N
    var gestureHandler = function () {
      _insideUserGesture   = true;
      _lastUserGestureTime = performance.now();
      Promise.resolve().then(function () { _insideUserGesture = false; });
    };
    for (var i = 0; i < gestureEvents.length; i++) {
      document.addEventListener(gestureEvents[i], gestureHandler, true);
    }
  }

  function isInsideUserGesture() {
    return _insideUserGesture || (performance.now() - _lastUserGestureTime < 1000);
  }

  function isTextVisiblyDisplayed(text) {
    if (!text) { return false; }
    try {
      var sel = window.getSelection();
      if (sel && sel.toString().trim() !== "") {
        var selStr = sel.toString().replace(/\s+/g, "");
        var txtStr = text.replace(/\s+/g, "");
        if (selStr.indexOf(txtStr) !== -1 || txtStr.indexOf(selStr) !== -1) { return true; }
      }
      if (document.body && document.body.innerText) {
        var bodyStr = document.body.innerText.replace(/\s+/g, "");
        var cleanTxt = text.replace(/\s+/g, "");
        if (cleanTxt.length > 5 && bodyStr.indexOf(cleanTxt) !== -1) { return true; }
      }
    } catch (e) {}
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  UTILITY — COMMAND SYNTAX CLASSIFIER (no keywords — pure syntax)
  // ═══════════════════════════════════════════════════════════════════════════

  var _cmdCache             = new Map();
  var MAX_CMD_CACHE         = 400;
  var MAX_CMD_CACHE_KEY_LEN = 8192;

  var EMPTY_CLASSIFICATION = { isCommand: false, score: 0, reasons: [], mitreIds: [], ruleIds: [] };

  // Memoized front-end for the classifier. The same <pre>/<code>/script text and
  // body content is re-examined on every scan pass and always yields the same
  // answer, so cache it. The _commandDetected side effect stays in the wrapper so
  // cache hits behave exactly like fresh computations.
  // Returned objects are treated as read-only by all callers.
  function classifyAsCommand(text, isDecoded) {
    if (!text || text.length < 5) { return EMPTY_CLASSIFICATION; }

    var key = null;
    if (text.length <= MAX_CMD_CACHE_KEY_LEN) {
      key = (isDecoded ? "1:" : "0:") + text;                                  //No I18N
      var hit = _cmdCache.get(key);
      if (hit) {
        if (hit.isCommand) { _commandDetected = true; }
        return hit;
      }
    }

    var result = computeCommandClassification(text, isDecoded);

    if (key !== null) {
      if (_cmdCache.size >= MAX_CMD_CACHE) { _cmdCache.clear(); }
      _cmdCache.set(key, result);
    }
    if (result.isCommand) { _commandDetected = true; }
    return result;
  }

  function computeCommandClassification(text, isDecoded) {
    var t       = text.trim();
    var score   = 0;
    var reasons = [];
    var mitreIds = ["T1204.002"]; // User Execution
    var ruleIds  = [];

    if (!isDecoded) {
      // Check for base64 encoded payloads in PowerShell commands (-enc, -encodedcommand, etc)
      var encMatch = t.match(/-(?:encodedcommand|enc|ec|e)\s+([A-Za-z0-9+/]{20,}={0,2})/i);
      if (encMatch) {
        try {
          // PowerShell Base64 commands are UTF-16LE, so we decode and strip null bytes
          var decoded = atob(encMatch[1]).replace(/\x00/g, '');
          // Recursively evaluate the decoded payload
          var subResult = classifyAsCommand("powershell.exe " + decoded, true); // prepend proc for recursive match //No I18N
          if (subResult.isCommand) {
            score += subResult.score;
            reasons.push("Decoded encoded-command payload matched: " + subResult.reasons.join(", ")); //No I18N
            mitreIds.push.apply(mitreIds, subResult.mitreIds);
            ruleIds.push.apply(ruleIds, subResult.ruleIds);
          }
        } catch (e) {
          // ignore bad base64
        }
      } else {
          // Fallback: check if the string itself contains a large base64 block
          var b64Match = t.match(/[A-Za-z0-9+/]{20,}={0,2}/g);
          if (b64Match) {
              for (var k = 0; k < b64Match.length; k++) {
                  try {
                      var decodedObj = atob(b64Match[k]).replace(/\x00/g, '');
                      // Filter out mostly-binary strings (random base64 collisions)
                      if (/[\x01-\x08\x0E-\x1F]/.test(decodedObj)) { continue; }
                      var subCheck = classifyAsCommand("powershell.exe " + decodedObj, true); //No I18N
                      if (subCheck.isCommand) {
                          score += subCheck.score;
                          reasons.push("Decoded Base64 string matched: " + subCheck.reasons.join(", ")); //No I18N
                          mitreIds.push.apply(mitreIds, subCheck.mitreIds);
                          ruleIds.push.apply(ruleIds, subCheck.ruleIds);
                          break;
                      }
                  } catch(e) {}
              }
          }
      }
    }

    var clickfixRules = [
      { proc: /(?:powershell\.exe|powershell|pwsh\.exe|pwsh)/i,
        mitre: ["T1059.001", "T1564.003"], ruleId: [90802, 90810],
        pats: [ /-windowstyle.*hidden/i, /-w hidden/i, /-w\.hidden/i, /-w 1/i, /-w\.1/i, / -win h/i, /-enc /i, /-encodedcommand/i, /-ec /i, /-e /i, /-ep bypass/i, /-executionpolicy bypass/i, /IEX/i, /Invoke-Expression/i, /DownloadString/i, /DownloadFile/i, /WebClient/i, /Net\.WebClient/i, /Invoke-WebRequest/i, /iwr /i, /FromBase64/i, /BitsTransfer/i ] },
      { proc: /(?:cmd\.exe|cmd)/i,
        mitre: ["T1059.003"], ruleId: [90803, 90811],
        pats: [ /\/b/i, /start \/b/i, /start \/min/i, /\/c.*curl/i, /\/c.*certutil/i, /\/c.*bitsadmin/i, /\/c.*powershell/i, /\/c.*pwsh/i, /\/c.*mshta/i, /\/c.*wscript/i, /\/c.*cscript/i, /\/c.*%TEMP%/i, /\/c.*\\Users\\Public\\/i, /\/c.*\\ProgramData\\/i, /\/c.*http/i, /\/c.*&&/i ] },
      { proc: /(?:conhost\.exe|conhost)/i,
        mitre: ["T1059"], ruleId: [90812],
        pats: [ /--headless/i, /powershell/i, /pwsh/i, /cmd/i ] },
      { proc: /(?:mshta\.exe|mshta)/i,
        mitre: ["T1218.005"], ruleId: [90804, 90813],
        pats: [ /http/i, /https/i, /javascript/i, /vbscript/i, /about:/i, /file:/i ] },
      { proc: /(?:wscript\.exe|wscript|cscript\.exe|cscript)/i,
        mitre: ["T1059"], ruleId: [90805, 90814],
        pats: [ /http/i, /https/i, /%TEMP%/i, /\\Users\\Public\\/i, /\\ProgramData\\/i, /\/\/e:jscript/i, /\/\/e:vbscript/i ] },
      { proc: /(?:curl\.exe|curl)/i,
        mitre: ["T1105"], ruleId: [90806, 90815],
        pats: [ /-o /i, /--output /i, /http/i, /https/i, /%TEMP%/i, /\\Users\\Public\\/i, /\\ProgramData\\/i ] },
      { proc: /(?:certutil\.exe|certutil)/i,
        mitre: ["T1105"], ruleId: [90806, 90816],
        pats: [ /-urlcache/i, /-split/i, /http/i, /https/i, /-decode/i, /-encode/i ] },
      { proc: /(?:bitsadmin\.exe|bitsadmin)/i,
        mitre: ["T1197"], ruleId: [90806, 90817],
        pats: [ /\/transfer/i, /http/i, /https/i, /\/download/i, /\/create/i, /\/addfile/i ] },
      { proc: /(?:msiexec\.exe|msiexec)/i,
        mitre: ["T1218.007"], ruleId: [90807, 90818],
        pats: [ /\/i .*http/i, /\/i .*https/i, /\/q.*http/i, /\/quiet.*http/i, /\/passive.*http/i ] },
      { proc: /(?:rundll32\.exe|rundll32)/i,
        mitre: ["T1218.011"], ruleId: [90808, 90819, 90645, 90646, 90647, 90648],
        pats: [ /http/i, /https/i, /javascript/i, /shell32.*ShellExec_RunDLL/i, /url\.dll.*FileProtocolHandler/i, /%TEMP%/i, /\\Users\\Public\\/i, /\\ProgramData\\/i, /\\\\.*@80\\/i, /,#/i, /davclnt\.dll.*DavSetCookie/i ] },
      { proc: /(?:schtasks\.exe|schtasks)/i,
        mitre: ["T1053.005"], ruleId: [90809, 90820],
        pats: [ /\/create/i, /\/run/i, /powershell/i, /cmd/i, /http/i ] }
    ];

    for (var i = 0; i < clickfixRules.length; i++) {
      var rule = clickfixRules[i];
      if (rule.proc.test(t)) {
        for (var j = 0; j < rule.pats.length; j++) {
          if (rule.pats[j].test(t)) {
            score += 60;
            reasons.push("ClickFix Rule matched: " + rule.proc + " -> " + rule.pats[j]); //No I18N
            mitreIds.push.apply(mitreIds, rule.mitre);
            ruleIds.push.apply(ruleIds, rule.ruleId);
            break;
          }
        }
      }
      if (score >= 40) {
        break;
      }
    }

    var unique = function(arr) { return arr.filter(function(v, i, a) { return a.indexOf(v) === i; }); };

    var isCmd = score >= 40;
    return { isCommand: isCmd, score: score, reasons: reasons, mitreIds: unique(mitreIds), ruleIds: unique(ruleIds) };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  UTILITY — ENTROPY CALCULATOR (Shannon entropy in bits per char)
  // ═══════════════════════════════════════════════════════════════════════════

  function shannonEntropy(s) {
    if (!s) { return 0; }
    var freq = {};
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      freq[c] = (freq[c] || 0) + 1;
    }
    var entropy = 0;
    var len     = s.length;
    for (var ch in freq) {
      var p = freq[ch] / len;
      entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  UTILITY — BASE64 DETECTOR / DECODER
  // ═══════════════════════════════════════════════════════════════════════════

  var BASE64_RE = /[A-Za-z0-9+\/]{20,}={0,2}/g;

  function findBase64(text) {
    var matches = text.match(BASE64_RE);
    if (!matches) { return []; }
    var results = [];
    for (var i = 0; i < matches.length; i++) {
      try {
        var decoded = atob(matches[i]);
        if (/[\x00-\x08\x0E-\x1F]/.test(decoded)) { continue; }
        results.push({ encoded: matches[i], decoded: decoded });
      } catch (e) { /* not valid base64 */ }
    }
    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  UTILITY — STRING DEOBFUSCATOR
  // ═══════════════════════════════════════════════════════════════════════════

  function deobfuscate(src) {
    var results = [];
    // char-code concatenation: String.fromCharCode(72,101,...)
    var ccMatch = src.match(/String\.fromCharCode\(([0-9, ]+)\)/g);
    if (ccMatch) {
      for (var i = 0; i < ccMatch.length; i++) {
        try {
          var nums = ccMatch[i].match(/\d+/g).map(Number);
          var str  = String.fromCharCode.apply(null, nums);
          results.push(str);
        } catch (e) {}
      }
    }
    // hex string: "\x48\x65\x6c\x6c\x6f"
    var hexDecoder = function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    };
    var hexMatch = src.match(/((?:\\x[0-9a-fA-F]{2}){4,})/g);
    if (hexMatch) {
      for (var j = 0; j < hexMatch.length; j++) {
        try {
          var decoded = hexMatch[j].replace(/\\x([0-9a-fA-F]{2})/g, hexDecoder);
          results.push(decoded);
        } catch (e) {}
      }
    }
    // unicode escapes: "\u0048\u0065"
    var uniDecoder = function (_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    };
    var uniMatch = src.match(/((?:\\u[0-9a-fA-F]{4}){3,})/g);
    if (uniMatch) {
      for (var k = 0; k < uniMatch.length; k++) {
        try {
          var decoded2 = uniMatch[k].replace(/\\u([0-9a-fA-F]{4})/g, uniDecoder);
          results.push(decoded2);
        } catch (e) {}
      }
    }
    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TIER 1 — BEHAVIORAL API MONITORING
  // ═══════════════════════════════════════════════════════════════════════════

  function monitorClipboardAPI() {
    // ── navigator.clipboard.writeText ──
    if (navigator.clipboard && navigator.clipboard.writeText) {
      var originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = function (text) {
        var outsideGesture = !isInsideUserGesture();
        var cmd            = classifyAsCommand(text);
        var earlyWrite     = performance.now() < 5000;

        if (outsideGesture) {
          addSignal("clickfix", "clipboard_no_gesture", //No I18N
            "Clipboard write without user gesture",                          //No I18N
            "Length=" + text.length + " earlyWrite=" + earlyWrite);          //No I18N
        }
        if (cmd.isCommand) {
          if (!outsideGesture && isTextVisiblyDisplayed(text)) {
            addSignal("clickfix", "visible_command_copy", //No I18N
              "Visible command-like content explicitly copied by user",        //No I18N
              "Score=" + cmd.score, null, cmd.mitreIds, cmd.ruleIds, text);    //No I18N
          } else {
            addSignal("clickfix", "clipboard_command_content", //No I18N
              "Command-like content written to clipboard",                     //No I18N
              "Score=" + cmd.score + " reasons=" + cmd.reasons.join(","),      //No I18N
              null, cmd.mitreIds, cmd.ruleIds, text);
          }
          sendCopiedDataReport(text, "clickfix"); //No I18N
        }
        if (earlyWrite) {
          addSignal("clickfix", "clipboard_early_write", //No I18N
            "Clipboard write within 5s of page load",                        //No I18N
            "time=" + Math.round(performance.now()) + "ms");                 //No I18N
        }

        reportIfThreshold();
        return originalWriteText(text);
      };
    }

    // ── document.execCommand('copy') ──
    var originalExecCommand = document.execCommand.bind(document);
    document.execCommand = function (cmd) {
      if (cmd === "copy") {
        var sel = window.getSelection();
        if (sel) {
          var selText = sel.toString();
          if (selText) {
            var cmdResult = classifyAsCommand(selText);
            if (cmdResult.isCommand) {
              if (isTextVisiblyDisplayed(selText)) {
                addSignal("pastejacking", "visible_command_copy", //No I18N
                  "Visible command payload in copy event",                      //No I18N
                  "cmdScore=" + cmdResult.score, null, cmdResult.mitreIds, cmdResult.ruleIds); //No I18N
              } else {
                addSignal("pastejacking", "execcommand_copy", //No I18N
                  "execCommand(copy) with command-like selection",             //No I18N
                  "score=" + cmdResult.score, null, cmdResult.mitreIds, cmdResult.ruleIds); //No I18N
              }
              sendCopiedDataReport(selText, "pastejacking"); //No I18N
            }
          }
        }
        reportIfThreshold();
      }
      return originalExecCommand.apply(document, arguments);
    };
  }

  function monitorCopyEvent() {
    document.addEventListener("copy", function (e) {
      if (e.clipboardData) {
        // Heuristic: page is setting clipboardData, likely pastejacking
        var origSetData = e.clipboardData.setData.bind(e.clipboardData);
        e.clipboardData.setData = function (type, data) {
          addSignal("pastejacking", "clipboard_data_overwrite", //No I18N
            "Copy event: clipboardData.setData called",                      //No I18N
            "type=" + type + " len=" + data.length);                         //No I18N

          var cmd = classifyAsCommand(data);
          if (cmd.isCommand) {
            if (isInsideUserGesture() && isTextVisiblyDisplayed(data)) {
              addSignal("pastejacking", "visible_command_copy", //No I18N
                "Visible command payload in copy event",                      //No I18N
                "cmdScore=" + cmd.score, null, cmd.mitreIds, cmd.ruleIds);    //No I18N
            } else {
              addSignal("pastejacking", "clipboard_dangerous_payload", //No I18N
                "Dangerous payload injected via copy event",                  //No I18N
                "cmdScore=" + cmd.score, null, cmd.mitreIds, cmd.ruleIds);    //No I18N
            }
            sendCopiedDataReport(data, "pastejacking"); //No I18N
          }
          reportIfThreshold();
          return origSetData(type, data);
        };
      }
    }, true);
  }

  function monitorKeyboard() {
    document.addEventListener("keydown", function (e) {
      // Detect listeners intercepting Win+R or Ctrl+V sequences outside textarea/input
      var target = e.target;
      var isInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" //No I18N
                    || target.isContentEditable);
      if (!isInput) {
        // Win+R interception pattern
        if ((e.metaKey || e.key === "Meta") && e.key === "r") { //No I18N
          addSignal("clickfix", "keyboard_intercept", //No I18N
            "Keydown intercepting Win+R outside input",                      //No I18N
            "key=" + e.key);                                                 //No I18N
          reportIfThreshold();
        }
      }
    }, true);

    document.addEventListener("paste", function (e) {
      var target = e.target;
      var isInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" //No I18N
                    || target.isContentEditable);
      if (!isInput) {
        addSignal("clickfix", "paste_event_intercept", //No I18N
          "Paste event on non-input element",                                //No I18N
          "target=" + describeEl(target));                                    //No I18N
        reportIfThreshold();
      }
    }, true);
  }

  function monitorFocusTrap() {
    var blurCount = 0;
    window.addEventListener("blur", function () {
      blurCount++;
      setTimeout(function () {
        if (document.hasFocus()) {
          if (blurCount >= 2) {
            addSignal("clickfix", "focus_trap", //No I18N
              "Window re-focuses after blur (focus trap)",                    //No I18N
              "blurCount=" + blurCount);                                      //No I18N
            reportIfThreshold();
          }
        }
      }, 200);
    });
  }

  function monitorDragAndDrop() {
    document.addEventListener("dragstart", function (e) {
      if (e.dataTransfer) {
        var text = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text");//No I18N
        if (text) {
          var cmd = classifyAsCommand(text);
          if (cmd.isCommand) {
            if (isTextVisiblyDisplayed(text)) {
              addSignal("clickfix", "visible_command_copy", //No I18N
                "Visible command payload in drag-and-drop",  //No I18N
                "cmdScore=" + cmd.score, null, cmd.mitreIds, cmd.ruleIds, text); //No I18N
            } else {
              addSignal("clickfix", "drag_and_drop_command", //No I18N
                "Command-like payload in drag-and-drop event", //No I18N
                "cmdScore=" + cmd.score, null, cmd.mitreIds, cmd.ruleIds, text); //No I18N
            }
            sendCopiedDataReport(text, "clickfix"); //No I18N
            reportIfThreshold();
          }
        }
      }
    }, true);
  }

  var _hookedIframes   = new WeakSet();
  var _iframeLoadBound = new WeakSet();

  // Returns true once the iframe's clipboard API is actually wrapped, so a
  // failed attempt (contentWindow not ready, cross-origin) can be retried later
  // instead of being permanently marked as done.
  function hookIframeClipboard(win) {
    try {
      if (win && win.navigator && win.navigator.clipboard && win.navigator.clipboard.writeText) {
        if (win.navigator.clipboard.writeText.__bsp_hooked) { return true; }
        var originalWrite = win.navigator.clipboard.writeText.bind(win.navigator.clipboard);
        win.navigator.clipboard.writeText = function (text) {
          var cmd = classifyAsCommand(text);
          if (cmd.isCommand) {
            if (isInsideUserGesture() && isTextVisiblyDisplayed(text)) {
              addSignal("clickfix", "visible_command_copy", //No I18N
                "Visible command copied via iframe clipboard API", //No I18N
                "Score=" + cmd.score, null, cmd.mitreIds, cmd.ruleIds, text); //No I18N
            } else {
              addSignal("clickfix", "iframe_clipboard_command", //No I18N
                "Command-like content written via iframe clipboard API", //No I18N
                "Score=" + cmd.score, null, cmd.mitreIds, cmd.ruleIds, text); //No I18N
            }
            sendCopiedDataReport(text, "clickfix"); //No I18N
          }
          reportIfThreshold();
          return originalWrite(text);
        };
        win.navigator.clipboard.writeText.__bsp_hooked = true;
        return true;
      }
    } catch (e) { /* ignore cross-origin */ }
    return false;
  }

  function iframeLoadHandler(e) {
    if (e && e.target && e.target.contentWindow) {
      hookIframeClipboard(e.target.contentWindow);
    }
  }

  // Hooks one iframe element, at most once. This replaces the previous
  // Node.prototype.appendChild/insertBefore patches, which routed *every* DOM
  // insertion on the page through a JS wrapper — a constant tax on a very hot
  // path. Iframes now come from the initial sweep, from the MutationObserver
  // (which hooks directly-inserted ones synchronously), and from each scan pass.
  function hookIframeElement(ifr) {
    if (!ifr) { return; }
    if (!_iframeLoadBound.has(ifr)) {
      _iframeLoadBound.add(ifr);
      try { ifr.addEventListener("load", iframeLoadHandler); } catch (e) {} //No I18N
    }
    if (_hookedIframes.has(ifr)) { return; }
    try {
      // Only mark it done once the wrap actually took; a same-origin iframe whose
      // contentWindow was not ready yet gets another chance on the load event.
      if (hookIframeClipboard(ifr.contentWindow)) { _hookedIframes.add(ifr); }
    } catch (e) { /* ignore cross-origin */ }
  }

  function scanForIframes() {
    var iframes = document.querySelectorAll("iframe"); //No I18N
    for (var i = 0; i < iframes.length; i++) {
      hookIframeElement(iframes[i]);
    }
  }

  function protectIframes() {
    scanForIframes();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TIER 2 + TIER 3 — INCREMENTAL DOM / CONTENT ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════
  //
  //  Every check below is driven by a list of ROOTS rather than by the whole
  //  document. A full sweep happens once at start-up (and on the post-load
  //  pass); after that the MutationObserver hands us just the subtrees that
  //  actually changed, so a pass costs time proportional to the change instead
  //  of to the size of the page. That is what makes a short debounce affordable
  //  and removes any need to cap the number of passes.
  //
  //  The three genuinely document-global checks (page_in_iframe, fake CAPTCHA,
  //  and the Base64 body sweep) are handled separately — see scanRoots().

  var SEL = {
    iframe:  "iframe",                                                         //No I18N
    divs:    "div, section, article",                                          //No I18N
    hidden:  "[style*='position:absolute'], [style*='position: absolute'], .hidden, [aria-hidden='true']", //No I18N
    oncopy:  "[oncopy]",                                                       //No I18N
    overlays:"[style*='position:fixed'], [style*='position: fixed'], " +       //No I18N
             "[style*='position:absolute'], [style*='position: absolute'], " + //No I18N
             "[class*='modal'], [class*='dialog'], [class*='overlay'], " +     //No I18N
             "[class*='popup'], [role='dialog'], [role='alertdialog']",        //No I18N
    modals:  "[class*='modal'], [class*='dialog'], [role='dialog']",           //No I18N
    code:    "pre, code, [class*='code'], kbd, samp, textarea[readonly]",      //No I18N
    scripts: "script:not([src])",                                              //No I18N
    links:   "a[href^='data:'], a[href^='blob:']",                             //No I18N
    captcha: "[class*='captcha'], [id*='captcha'], [class*='verify'], [id*='verify'], " + //No I18N
             "[class*='robot'], [id*='robot'], [class*='human'], [id*='human']"           //No I18N
  };

  // Matching elements inside the given roots (each root itself included), or
  // across the whole document when isFull is set.
  function collectIn(roots, selector, isFull) {
    var out = [];
    var i, j, found;
    if (isFull) {
      found = document.querySelectorAll(selector);
      for (i = 0; i < found.length; i++) { out.push(found[i]); }
      return out;
    }
    for (i = 0; i < roots.length; i++) {
      var root = roots[i];
      // Detached subtrees cannot be shown to the user, so they are not worth
      // the traversal.
      if (!root || root.nodeType !== 1 || !root.isConnected) { continue; }
      try {
        if (root.matches(selector)) { out.push(root); }
        found = root.querySelectorAll(selector);
        for (j = 0; j < found.length; j++) { out.push(found[j]); }
      } catch (e) { /* malformed selector support differences */ }
    }
    return out;
  }

  // ── Clickjacking: page framed by someone else (one-time, global) ──────────
  function checkPageInIframe() {
    if (window !== window.top) {
      addSignal("clickjacking", "page_in_iframe", //No I18N
        "Page loaded inside iframe",                                         //No I18N
        "");
    }
  }

  // ── Clickjacking: hidden / fullscreen iframes ─────────────────────────────
  function checkIframes(els) {
    for (var fi = 0; fi < els.length; fi++) {
      var ifr = els[fi];
      // Hooking here covers iframes that arrived inside a larger subtree.
      hookIframeElement(ifr);
      // getComputedStyle forces a style/layout flush — pay it once per element.
      if (_styledIframes.has(ifr)) { continue; }
      _styledIframes.add(ifr);
      var style = window.getComputedStyle(ifr);
      if (style.opacity === "0" || style.visibility === "hidden" ||
          (parseInt(style.width) <= 1 && parseInt(style.height) <= 1)) {
        addSignal("clickjacking", "hidden_iframe", //No I18N
          "Hidden/invisible iframe detected",                                //No I18N
          "src=" + (ifr.src || "about:blank").substring(0, 100));            //No I18N
      }
      if (parseInt(style.width) >= window.innerWidth * 0.9 &&
          parseInt(style.height) >= window.innerHeight * 0.9) {
        addSignal("clickjacking", "fullscreen_overlay_iframe", //No I18N
          "Near-fullscreen iframe overlay",                                  //No I18N
          "size=" + style.width + "x" + style.height);                       //No I18N
      }
    }
  }

  // ── Clickjacking: pointer-events / invisible fixed overlays ───────────────
  function checkOverlayDivs(els) {
    var styleBudget = MAX_STYLE_CHECKS_PER_PASS;
    for (var di = 0; di < els.length; di++) {
      var dEl = els[di];
      if (_styledDivs.has(dEl)) { continue; }
      // Anything over budget is picked up by a follow-up pass rather than
      // blocking the main thread on thousands of forced layouts at once.
      if (styleBudget-- <= 0) { _styleBacklog = true; return; }
      _styledDivs.add(dEl);
      var dstyle = window.getComputedStyle(dEl);
      if (dstyle.pointerEvents === "none" && dstyle.position === "fixed" &&
          parseInt(dstyle.zIndex) > 999) {
        addSignal("clickjacking", "pointer_passthrough", //No I18N
          "Fixed overlay with pointer-events:none",                          //No I18N
          "zIndex=" + dstyle.zIndex);                                        //No I18N
      }
      if (dstyle.position === "fixed" && dstyle.opacity === "0" &&
          parseInt(dstyle.zIndex) > 100) {
        addSignal("clickjacking", "invisible_overlay_div", //No I18N
          "Invisible fixed overlay div",                                     //No I18N
          "zIndex=" + dstyle.zIndex);                                        //No I18N
      }
    }
  }

  // ── PasteJacking: hidden text elements ────────────────────────────────────
  function checkHiddenText(els) {
    for (var hi = 0; hi < els.length; hi++) {
      var hel = els[hi];
      var txt = (hel.textContent || "").trim();

      // Re-check only when the element's text actually changed, and skip the
      // forced layout entirely for text too short to qualify.
      if (_hiddenTextSeen.get(hel) === txt.length) { continue; }
      _hiddenTextSeen.set(hel, txt.length);
      if (txt.length <= 10) { continue; }

      var hstyle = window.getComputedStyle(hel);

      if (hstyle.left === "-9999px" || hstyle.top === "-9999px" ||
          parseInt(hstyle.left) < -1000 || parseInt(hstyle.top) < -1000 ||
          hstyle.opacity === "0" || hstyle.visibility === "hidden" ||
          (parseInt(hstyle.width) <= 1 && parseInt(hstyle.height) <= 1)) {
        var cmdResult = classifyAsCommand(txt);
        if (cmdResult.isCommand) {
          addSignal("pastejacking", "hidden_shell_text", //No I18N
            "Hidden element contains command-like text",                     //No I18N
            "cmdScore=" + cmdResult.score + " len=" + txt.length,            //No I18N
            hel, cmdResult.mitreIds, cmdResult.ruleIds);
        } else if (txt.length > 30) {
          addSignal("pastejacking", "hidden_text_payload", //No I18N
            "Substantial hidden text payload",                               //No I18N
            "len=" + txt.length);                                            //No I18N
        }
      }
    }
  }

  // ── PasteJacking: oncopy handlers ─────────────────────────────────────────
  function checkOncopy(els) {
    if (els.length > 0) {
      addSignal("pastejacking", "oncopy_handler", //No I18N
        "Element has oncopy attribute",                                      //No I18N
        "count=" + els.length);                                              //No I18N
    }
  }

  // ── ClickFix: overlay/modal structure ─────────────────────────────────────
  function checkClickFixOverlays(els) {
    for (var oi = 0; oi < els.length; oi++) {
      var overlay    = els[oi];
      var innerText  = (overlay.textContent || "").substring(0, 2000);
      if (_overlaysSeen.get(overlay) === innerText.length) { continue; }
      _overlaysSeen.set(overlay, innerText.length);
      var ostyle     = window.getComputedStyle(overlay);

      // Skip tiny/hidden overlays
      if (parseInt(ostyle.width) < 200 || parseInt(ostyle.height) < 100) { continue; }
      if (ostyle.display === "none" || ostyle.visibility === "hidden") { continue; }

      var hasCodeBlock      = overlay.querySelector("pre, code, [class*='code'], kbd, samp") !== null; //No I18N
      var hasButton         = overlay.querySelector("button, [role='button'], a[href], [class*='btn']") !== null;
      var hasNumberedSteps  = /(?:step\s*[1-3]|[①②③]|1\.\s|2\.\s|3\.\s)/i.test(innerText);

      var structuralSignals = 0;
      if (hasCodeBlock)     { structuralSignals++; }
      if (hasButton)        { structuralSignals++; }
      if (hasNumberedSteps) { structuralSignals++; }

      if (hasNumberedSteps && (hasCodeBlock || hasButton)) {
        addSignal("clickfix", "dom_overlay_with_steps", //No I18N
          "Overlay with numbered steps + code/button",                       //No I18N
          "codeBlock=" + hasCodeBlock + " button=" + hasButton);             //No I18N
      }
      if (hasCodeBlock && !hasNumberedSteps) {
        addSignal("clickfix", "dom_overlay_with_code", //No I18N
          "Overlay contains code block",                                     //No I18N
          "", overlay);                                                       //No I18N
      }
      if (hasButton && !hasCodeBlock && !hasNumberedSteps) {
        addSignal("clickfix", "dom_overlay_with_action", //No I18N
          "Overlay with action button (no code/steps)",                      //No I18N
          "", overlay);                                                       //No I18N
      }
      if (structuralSignals >= 3) {
        addSignal("clickfix", "dom_structure_combo", //No I18N
          "Overlay with 3+ structural ClickFix signals",                     //No I18N
          "signals=" + structuralSignals, overlay);                          //No I18N
      }
    }
  }

  // ── ClickFix: standalone modals with code + button ────────────────────────
  function checkModals(els) {
    for (var mi = 0; mi < els.length; mi++) {
      var modal = els[mi];
      if (_styledModals.has(modal)) { continue; }
      _styledModals.add(modal);
      var mstyle = window.getComputedStyle(modal);
      if (mstyle.display === "none" || mstyle.visibility === "hidden") { continue; }

      var hasCode = modal.querySelector("pre, code, kbd") !== null; //No I18N
      var hasBtn  = modal.querySelector("button, [role='button']") !== null; //No I18N
      if (hasCode && hasBtn) {
        addSignal("clickfix", "suspicious_modal_elements", //No I18N
          "Modal with code block + button",                                  //No I18N
          "", modal);                                                         //No I18N
      }
    }
  }

  // Document-global by nature: proving the ABSENCE of a provider iframe means
  // querying the whole page. Gated by a cheap incremental trigger in scanRoots
  // so it only runs when a CAPTCHA-like element has actually appeared.
  function detectFakeCaptcha() {
    var captchaProviderIframes = document.querySelectorAll(
      "iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile'], " + //No I18N
      "iframe[src*='arkose'], iframe[src*='geetest']" //No I18N
    );
    var overlays = document.querySelectorAll(SEL.captcha);

    if (overlays.length > 0 && captchaProviderIframes.length === 0) {
      addSignal("clickfix", "fake_captcha_no_provider", //No I18N
        "CAPTCHA-like UI without real provider iframe",                      //No I18N
        "overlayCount=" + overlays.length);                                  //No I18N
    }
  }

  // ── TIER 3: code blocks, entropy + command syntax ─────────────────────────
  function checkCodeBlocks(els) {
    for (var ci = 0; ci < els.length; ci++) {
      var codeEl = els[ci];
      var text = (codeEl.textContent || "").trim();
      if (text.length < 10 || text.length > 5000) { continue; }

      // Only re-analyze a block whose content actually changed.
      if (_codeBlocksSeen.get(codeEl) === text.length) { continue; }
      _codeBlocksSeen.set(codeEl, text.length);

      var entropy = shannonEntropy(text);
      var cmd     = classifyAsCommand(text);

      // Command-like entropy range: 3.5–5.5 bits (higher = more random)
      if (entropy > 3.5 && cmd.isCommand) {
        addSignal("clickfix", "code_block_high_entropy", //No I18N
          "Code block with command-like entropy",                            //No I18N
          "entropy=" + entropy.toFixed(2) + " cmdScore=" + cmd.score,        //No I18N
          codeEl, cmd.mitreIds, cmd.ruleIds);
      }
      if (cmd.isCommand && cmd.score >= 50) {
        addSignal("clickfix", "command_syntax_detected", //No I18N
          "Command syntax structure in code block",                          //No I18N
          "score=" + cmd.score + " reasons=" + cmd.reasons.join(","),        //No I18N
          codeEl, cmd.mitreIds, cmd.ruleIds);
      }
    }
  }

  // ── TIER 3: Base64 payloads ───────────────────────────────────────────────
  // A full pass reads the whole body once; incremental passes only read the
  // text of the subtrees that changed, which is where a new payload can be.
  function checkBase64(roots, isFull) {
    var text;
    if (isFull) {
      text = document.body ? (document.body.textContent || "").substring(0, MAX_BODY_TEXT) : ""; //No I18N
      if (text === _lastBodyText) { return; }
      _lastBodyText = text;
    } else {
      var parts = [];
      for (var r = 0; r < roots.length; r++) {
        var root = roots[r];
        if (!root || root.nodeType !== 1 || !root.isConnected) { continue; }
        parts.push(root.textContent || "");
      }
      text = parts.join("\n").substring(0, MAX_BODY_TEXT);                 //No I18N
    }
    if (!text) { return; }

    var b64Finds = findBase64(text);
    for (var bi = 0; bi < b64Finds.length; bi++) {
      var cmd2 = classifyAsCommand(b64Finds[bi].decoded);
      if (cmd2.isCommand) {
        addSignal("clickfix", "base64_malicious_payload", //No I18N
          "Decoded Base64 contains command syntax",                          //No I18N
          "decodedLen=" + b64Finds[bi].decoded.length + " cmdScore=" + cmd2.score, //No I18N
          null, cmd2.mitreIds, cmd2.ruleIds);
      }
    }
  }

  // ── TIER 3: inline script deobfuscation ───────────────────────────────────
  function checkScripts(els) {
    for (var si = 0; si < els.length; si++) {
      // Inline script bodies do not change once parsed — deobfuscate each once.
      if (_scriptsSeen.has(els[si])) { continue; }
      _scriptsSeen.add(els[si]);
      var src     = els[si].textContent || "";
      var deobbed = deobfuscate(src);
      for (var di = 0; di < deobbed.length; di++) {
        var cmd3 = classifyAsCommand(deobbed[di]);
        if (cmd3.isCommand) {
          addSignal("clickfix", "deobfuscated_malicious", //No I18N
            "Deobfuscated script contains command syntax",                   //No I18N
            "cmdScore=" + cmd3.score, null, cmd3.mitreIds, cmd3.ruleIds);    //No I18N
        }
      }
    }
  }

  // ── TIER 3: data: / blob: URIs ────────────────────────────────────────────
  function checkDataBlobLinks(els) {
    if (els.length > 0) {
      addSignal("clickfix", "data_blob_uri", //No I18N
        "Page contains data:/blob: links",                                   //No I18N
        "count=" + els.length);                                              //No I18N
    }
  }

  // Runs every check over the supplied roots (or the whole document when
  // isFull). Ordering matches the original analyzeDOM() + analyzeContent().
  function scanRoots(roots, isFull) {
    checkIframes(          collectIn(roots, SEL.iframe,   isFull));
    checkOverlayDivs(      collectIn(roots, SEL.divs,     isFull));
    checkHiddenText(       collectIn(roots, SEL.hidden,   isFull));
    checkOncopy(           collectIn(roots, SEL.oncopy,   isFull));
    checkClickFixOverlays( collectIn(roots, SEL.overlays, isFull));

    // Cheap trigger for the one genuinely page-wide structural check.
    if (collectIn(roots, SEL.captcha, isFull).length > 0) { detectFakeCaptcha(); }

    checkModals(           collectIn(roots, SEL.modals,   isFull));
    checkCodeBlocks(       collectIn(roots, SEL.code,     isFull));
    checkBase64(roots, isFull);
    checkScripts(          collectIn(roots, SEL.scripts,  isFull));
    checkDataBlobLinks(    collectIn(roots, SEL.links,    isFull));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  REPORT TO SERVICE WORKER
  // ═══════════════════════════════════════════════════════════════════════════

  var _reported = false;

  function sendCopiedDataReport(text, catString) {
    if (!text) { return; }
    // Only send the copied event if a command was detected
    if (!_commandDetected) { return; }

    var copiedReport = {
      Request:     "ClickFixCopiedData",                                 //No I18N
      threat_type: catString || "clickfix",                              //No I18N
      url:         window.location.href,
      title:       document.title || "",
      timestamp:   Date.now(),
      copied_command: text
    };
    try {
      window.postMessage({
        source: "__bsp_clickfix_report__",  //No I18N
        report: copiedReport
      }, "*"); //No I18N
    } catch(e) {}
  }

  // ClickFix is only actionable when an actual command payload was observed: a
  // page that merely looks like a ClickFix lure is not reported on its own.
  // Clickjacking and PasteJacking are structural/behavioural categories and must
  // be able to report without a command — a blanket _commandDetected gate here
  // used to suppress them entirely, so they could never fire no matter the score.
  var COMMAND_GATED_CATEGORIES = { clickfix: true };

  // Highest-scoring category that is both over threshold and allowed to report.
  function qualifyingCategory() {
    var best      = null;
    var bestScore = -1;
    for (var cat in SCORE_THRESHOLDS) {
      var score = scoreBoard[cat] || 0;
      if (score < SCORE_THRESHOLDS[cat]) { continue; }
      if (COMMAND_GATED_CATEGORIES[cat] && !_commandDetected) { continue; }
      if (score > bestScore) { bestScore = score; best = cat; }
    }
    return best;
  }

  function reportIfThreshold() {
    if (_reported) { return; }

    var cat = qualifyingCategory();
    if (!cat) { return; }

    _reported = true;
    sendReport(cat, scoreBoard[cat] || 0);
  }

  // reportCat/reportScore come from qualifyingCategory(). They must not be
  // re-derived from the raw scoreBoard here: the highest-scoring category is not
  // necessarily one that is allowed to report, and picking it by score alone
  // could label a report "clickfix" on a page where no command was ever seen.
  function sendReport(reportCat, reportScore) {
    var maxCat   = reportCat || "clickfix";                                  //No I18N
    var maxScore = reportScore || 0;
    var copiedCommand = "";

    for (var k = 0; k < threats.length; k++) {
      if (threats[k].payload) {
        copiedCommand = threats[k].payload;
        break;
      }
    }

    var severity_id = 1;     // Informational
    var severity    = "Informational";                                        //No I18N
    if (maxScore >= 100) { severity_id = 4; severity = "Critical"; }         //No I18N
    else if (maxScore >= 70)  { severity_id = 3; severity = "High"; }        //No I18N
    else if (maxScore >= 40)  { severity_id = 2; severity = "Medium"; }      //No I18N

    var report = {
      Request:     "ClickFixDetection",                                      //No I18N
      threat_type: maxCat,
      scores:      scoreBoard,
      threats:     threats,
      url:         window.location.href,
      title:       document.title || "",
      severity_id: severity_id,
      severity:    severity,
      timestamp:   Date.now(),
      copied_command: copiedCommand
    };

    //console.log("Browser Security Plus: " + maxCat + " detected! Score: " + maxScore);
    //alert("Browser Security Plus Threat Detected!\nType: " + maxCat + "\nDetection Score: " + maxScore);

    try {
      // Post to ISOLATED world (contentScript.js) since chrome.runtime
      // is not available in MAIN world
      window.postMessage({
        source: "__bsp_clickfix_report__",  //No I18N
        report: report
      }, "*"); //No I18N

      if (copiedCommand) {
        var copiedReport = {
          Request:     "ClickFixCopiedData",                                 //No I18N
          threat_type: maxCat,
          url:         window.location.href,
          title:       document.title || "",
          timestamp:   Date.now(),
          copied_command: copiedCommand
        };
        window.postMessage({
          source: "__bsp_clickfix_report__",  //No I18N
          report: copiedReport
        }, "*"); //No I18N
      }
    } catch (e) {
      // Extension context may be invalidated
    }
  }

  function sendFinalReport() {
    if (_reported) { return; }

    var cat = qualifyingCategory();
    if (!cat) { return; }

    _reported = true;
    sendReport(cat, scoreBoard[cat] || 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SCAN SCHEDULING
  // ═══════════════════════════════════════════════════════════════════════════

  // Retires the expensive DOM/content scanning. The MutationObserver itself
  // stays connected: iframe clipboard hooking feeds sendCopiedDataReport(), which
  // is deliberately not gated on _reported, so it must keep working afterwards.
  // Once scanning is retired the observer callback only does a nodeName check per
  // added node, which is far cheaper than the appendChild patch it replaced.
  function stopScanning() {
    _scanningDone = true;
    if (_scanTimer !== null) {
      clearTimeout(_scanTimer);
      _scanTimer     = null;
      _scanScheduled = false;
    }
  }

  // Queues a changed subtree for the next pass. Text nodes are attributed to
  // their parent element: dropping a command into an existing <pre> shows up as
  // an added text node, and the original code rescanned on any added node.
  function queueRoot(node) {
    if (!node || _scanningDone || _pendingFull) { return; }
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el) { return; }
    if (_pendingRoots.size >= MAX_PENDING_ROOTS) {
      // Too many discrete roots to be worth visiting individually.
      _pendingFull = true;
      _pendingRoots.clear();
      return;
    }
    _pendingRoots.add(el);
  }

  function runScan(isFinal) {
    if (_scanningDone || _reported) { stopScanning(); return; }

    var isFull = _pendingFull || !_initialScanDone;
    var roots  = [];
    if (!isFull) {
      _pendingRoots.forEach(function (el) { roots.push(el); });
    }
    _pendingFull = false;
    _pendingRoots.clear();
    _styleBacklog = false;

    if (!_initialScanDone) {
      _initialScanDone = true;
      checkPageInIframe();
    }
    if (isFull) { scanForIframes(); }

    if (isFull || roots.length) { scanRoots(roots, isFull); }

    if (isFinal) { sendFinalReport(); } else { reportIfThreshold(); }

    if (_reported) { stopScanning(); return; }

    // The initial sweep is spread across passes by the style budget; keep going
    // until the backlog is drained.
    // Draining the start-up backlog is not waiting on anything, so it yields to
    // the main thread briefly rather than paying the full mutation debounce.
    if (_styleBacklog) {
      _pendingFull = true;
      scheduleScan(BACKLOG_DELAY_MS);
    }
  }

  // Coalesce mutation bursts into a single scan. Without this, a full-document
  // scan ran per mutation batch, which on any framework-driven page is constant.
  function scheduleScan(delayMs) {
    if (_scanningDone || _reported || _scanScheduled) { return; }
    _scanScheduled = true;
    _scanTimer = setTimeout(function () {
      _scanTimer     = null;
      _scanScheduled = false;
      runScan(false);
    }, typeof delayMs === "number" ? delayMs : SCAN_DEBOUNCE_MS);          //No I18N
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  function init() {
    // T1: Start behavioral monitoring immediately (before DOM loads)
    trackUserGestures();
    monitorClipboardAPI();
    monitorCopyEvent();
    monitorKeyboard();
    monitorFocusTrap();
    monitorDragAndDrop();
    protectIframes();

    // T2+T3: Analyze DOM & content when DOM is ready
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        runScan(false);
      });
    } else {
      runScan(false);
    }

    // Final scan after full page load (catches late-injected content)
    window.addEventListener("load", function () {
      setTimeout(function () {
        // Full sweep: catches anything the incremental passes could have missed.
        _pendingFull = true;
        runScan(true);
      }, 3000);
    });

    // MutationObserver to catch dynamically injected overlays
    if (typeof MutationObserver === "function") {
      _observer = new MutationObserver(function (mutations) {
        var relevant = false;
        for (var m = 0; m < mutations.length; m++) {
          var added = mutations[m].addedNodes;
          for (var n = 0; n < added.length; n++) {
            var node = added[n];
            if (node.nodeType === 1) {
              relevant = true;
              // Hook a directly-inserted iframe right away so its clipboard API
              // is wrapped before its own scripts run; iframes arriving inside a
              // larger subtree are caught by checkIframes() during the pass.
              if (node.nodeName === "IFRAME") { hookIframeElement(node); }      //No I18N
              queueRoot(node);
            } else if (node.nodeType === 3) {
              // Text dropped into an existing element. Scanning just the parent
              // keeps the original's coverage without a document-wide sweep.
              relevant = true;
              queueRoot(node.parentElement);
            }
          }
        }
        if (relevant && !_scanningDone) { scheduleScan(); }
      });

      var readyFn = function () {
        if (document.body && _observer) {
          _observer.observe(document.body, { childList: true, subtree: true });
        }
      };

      if (document.body) {
        readyFn();
      } else {
        document.addEventListener("DOMContentLoaded", readyFn);
      }
    }
  }

  init();

})();

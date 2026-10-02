(function() {
    var isFirefoxApi = (typeof browser !== 'undefined'); //No I18N
    var runtimeApi = isFirefoxApi ? browser : chrome;
    var openButton = document.getElementById('openBSPIncognito'); //No I18N
    var statusText = document.getElementById('bspIncognitoStatus'); //No I18N

    function setStatus(message, isError) {
        statusText.textContent = message || ''; //No I18N
        if (isError) {
            statusText.classList.add('error'); //No I18N
        } else {
            statusText.classList.remove('error'); //No I18N
        }
    }

    function handleResponse(response) {
        openButton.disabled = false;
        if (response && response.success) {
            clearActionPopup();
            window.close();
            return;
        }
        setStatus((response && response.error) ? response.error : 'Unable to open BSP Private Window.', true); //No I18N
    }

    function applyEligibility(response) {
        if (!response || !response.success) {
            openButton.disabled = true;
            setStatus((response && response.error) ? response.error : 'Unable to verify BSP Private Window availability.', true); //No I18N
            return;
        }
        if (response.enabled !== true) {
            openButton.disabled = true;
            setStatus(response.blockedReason || 'BSP Private Window is not enabled for this browser.', true); //No I18N
            return;
        }
        if (response.launchAllowed === false) {
            openButton.disabled = true;
            setStatus(response.blockedReason || 'A BSP Private Window is already running for this browser.', true); //No I18N
            return;
        }
        openButton.disabled = false;
        setStatus('', false); //No I18N
    }

    function refreshEligibility() {
        openButton.disabled = true;
        try {
            if (isFirefoxApi) {
                runtimeApi.runtime.sendMessage({ action: 'getBSPIncognitoEligibility' }).then(applyEligibility).catch(function(error) { //No I18N
                    openButton.disabled = true;
                    setStatus(error && error.message ? error.message : 'Unable to verify BSP Private Window availability.', true); //No I18N
                });
                return;
            }

            runtimeApi.runtime.sendMessage({ action: 'getBSPIncognitoEligibility' }, function(response) { //No I18N
                if (runtimeApi.runtime.lastError) {
                    openButton.disabled = true;
                    setStatus(runtimeApi.runtime.lastError.message || 'Unable to verify BSP Private Window availability.', true); //No I18N
                    return;
                }
                applyEligibility(response);
            });
        } catch (error) {
            openButton.disabled = true;
            setStatus(error && error.message ? error.message : 'Unable to verify BSP Private Window availability.', true); //No I18N
        }
    }

    function clearActionPopup() {
        try {
            runtimeApi.runtime.sendMessage({ action: 'clearBSPIncognitoPopup' }); //No I18N
        } catch (error) {
        }
    }

    window.addEventListener('unload', clearActionPopup); //No I18N

    refreshEligibility();

    openButton.addEventListener('click', function() { //No I18N
        openButton.disabled = true;
        setStatus('', false); //No I18N

        try {
            if (isFirefoxApi) {
                runtimeApi.runtime.sendMessage({ action: 'openBSPIncognito' }).then(handleResponse).catch(function(error) { //No I18N
                    openButton.disabled = false;
                    setStatus(error && error.message ? error.message : 'Unable to open BSP Private Window.', true); //No I18N
                });
                return;
            }

            runtimeApi.runtime.sendMessage({ action: 'openBSPIncognito' }, function(response) { //No I18N
                if (runtimeApi.runtime.lastError) {
                    openButton.disabled = false;
                    setStatus(runtimeApi.runtime.lastError.message || 'Unable to open BSP Private Window.', true); //No I18N
                    return;
                }
                handleResponse(response);
            });
        } catch (error) {
            openButton.disabled = false;
            setStatus(error && error.message ? error.message : 'Unable to open BSP Private Window.', true); //No I18N
        }
    });
})();

// ==UserScript==
// @name         OpenClaw Auto-Attach
// @match        *://*/*
// @grant        none
// ==/UserScript==

// Auto-attach OpenClaw extension to all tabs
(function() {
    'use strict';
    
    // Check if extension is present
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        // Attempt to auto-attach
        setTimeout(() => {
            chrome.runtime.sendMessage({
                action: 'autoAttach',
                url: window.location.href,
                title: document.title
            });
        }, 1000);
    }
})();

// Content script for auto-attachment
// This script runs on all pages to facilitate OpenClaw control

(function() {
  'use strict';
  
  // Notify background script that page is ready
  chrome.runtime.sendMessage({
    type: 'pageReady',
    url: window.location.href,
    title: document.title
  });
  
  // Create a marker to indicate OpenClaw is active
  window.__OPENCLAW_AUTO_ATTACHED__ = true;
  
  console.log('[OpenClaw] Page auto-attached and ready for control');
})();

const DEFAULT_PORT = 18792

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

let relayWs = null
let relayConnectPromise = null
let debuggerListenersInstalled = false
let nextSession = 1

const tabs = new Map()
const tabBySession = new Map()
const childSessionToTab = new Map()
const pending = new Map()
const autoAttachedTabs = new Set()

function nowStack() {
  try {
    return new Error().stack || ''
  } catch {
    return ''
  }
}

async function getRelayPort() {
  const stored = await chrome.storage.local.get(['relayPort'])
  const raw = stored.relayPort
  const n = Number.parseInt(String(raw || ''), 10)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const port = await getRelayPort()
    const httpBase = `http://127.0.0.1:${port}`
    const wsUrl = `ws://127.0.0.1:${port}/extension`

    // Fast preflight: is the relay server up?
    try {
      await fetch(`${httpBase}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    } catch (err) {
      throw new Error(`Relay server not reachable at ${httpBase}`)
    }

    const ws = new WebSocket(wsUrl)
    relayWs = ws

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      ws.onopen = () => {
        clearTimeout(t)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(t)
        reject(new Error('WebSocket connect failed'))
      }
      ws.onclose = (ev) => {
        clearTimeout(t)
        reject(new Error(`WebSocket closed (${ev.code})`))
      }
    })

    ws.onmessage = (event) => void onRelayMessage(String(event.data || ''))
    ws.onclose = () => onRelayClosed('closed')
    ws.onerror = () => onRelayClosed('error')

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true
      chrome.debugger.onEvent.addListener(onDebuggerEvent)
      chrome.debugger.onDetach.addListener(onDebuggerDetach)
    }
  })()

  try {
    await relayConnectPromise
  } finally {
    relayConnectPromise = null
  }
}

function onRelayClosed(reason) {
  relayWs = null
  relayConnectPromise = null
  // Clear all tab states
  for (const [tabId] of tabs) {
    setBadge(tabId, 'error')
  }
  tabs.clear()
  tabBySession.clear()
  childSessionToTab.clear()
  autoAttachedTabs.clear()
}

async function onRelayMessage(data) {
  let msg
  try {
    msg = JSON.parse(data)
  } catch {
    return
  }

  if (msg.type === 'command') {
    const { method, params, id } = msg
    await handleCommand(method, params, id)
  } else if (msg.type === 'response' && msg.id != null) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) {
      p.reject(new Error(msg.error))
    } else {
      p.resolve(msg.result)
    }
  }
}

async function handleCommand(method, params, id) {
  try {
    let result
    if (method === 'attach') {
      result = await doAttach(params)
    } else if (method === 'detach') {
      result = await doDetach(params)
    } else if (method === 'send') {
      result = await doSend(params)
    } else if (method === 'getTargets') {
      result = await doGetTargets()
    } else if (method === 'getVersion') {
      result = await doGetVersion()
    } else {
      throw new Error(`Unknown method: ${method}`)
    }
    send({ type: 'response', id, result })
  } catch (err) {
    send({ type: 'response', id, error: String(err?.message || err) })
  }
}

async function doAttach({ tabId, sessionId }) {
  if (!tabId) throw new Error('attach requires tabId')
  
  const existing = tabs.get(tabId)
  if (existing?.state === 'connected') {
    return { sessionId: existing.sessionId, alreadyAttached: true }
  }

  const target = { tabId }
  const order = nextSession++

  await chrome.debugger.attach(target, '1.3')
  await chrome.debugger.sendCommand(target, 'Runtime.enable')
  await chrome.debugger.sendCommand(target, 'Page.enable')
  await chrome.debugger.sendCommand(target, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  })

  const session = sessionId || `tab_${tabId}_${order}`
  tabs.set(tabId, { state: 'connected', sessionId: session, targetId: String(tabId), attachOrder: order })
  tabBySession.set(session, tabId)
  autoAttachedTabs.add(tabId)
  setBadge(tabId, 'on')

  return { sessionId: session, attached: true }
}

async function doDetach({ tabId }) {
  if (!tabId) throw new Error('detach requires tabId')
  const t = tabs.get(tabId)
  if (t?.sessionId) tabBySession.delete(t.sessionId)
  tabs.delete(tabId)
  autoAttachedTabs.delete(tabId)
  setBadge(tabId, 'off')
  try {
    await chrome.debugger.detach({ tabId })
  } catch {}
  return { detached: true }
}

async function doSend({ tabId, message, sessionId }) {
  if (!tabId || !message) throw new Error('send requires tabId and message')
  const method = message.method
  const params = message.params
  const result = await chrome.debugger.sendCommand({ tabId }, method, params)
  return result
}

async function doGetTargets() {
  const allTabs = await chrome.tabs.query({})
  const targets = allTabs
    .filter((t) => t.id != null && /^https?:\/\//.test(t.url || ''))
    .map((t) => ({
      targetId: String(t.id),
      type: 'page',
      title: t.title || '',
      url: t.url || '',
      attached: tabs.has(t.id) && tabs.get(t.id).state === 'connected',
    }))
  return { targetInfos: targets }
}

async function doGetVersion() {
  return {
    protocolVersion: '1.3',
    product: 'Chrome/ExtensionRelay',
    userAgent: navigator.userAgent,
    jsVersion: '1.0',
  }
}

function onDebuggerEvent(source, method, params) {
  const tabId = source?.tabId
  if (!tabId) return
  const t = tabs.get(tabId)
  if (!t) return

  if (method === 'Target.attachedToTarget') {
    const childSession = params?.sessionId
    const childTargetId = params?.targetInfo?.targetId
    if (childSession && childTargetId) {
      childSessionToTab.set(childSession, tabId)
    }
  } else if (method === 'Target.detachedFromTarget') {
    const childSession = params?.sessionId
    if (childSession) childSessionToTab.delete(childSession)
  }

  const sessionId = t.sessionId
  const targetId = t.targetId
  send({ type: 'event', sessionId, targetId, method, params })
}

function onDebuggerDetach(source) {
  const tabId = source?.tabId
  if (!tabId) return
  const t = tabs.get(tabId)
  if (t?.sessionId) tabBySession.delete(t.sessionId)
  tabs.delete(tabId)
  autoAttachedTabs.delete(tabId)
  setBadge(tabId, 'off')
  if (t?.sessionId) {
    send({ type: 'event', sessionId: t.sessionId, method: 'Inspector.detached', params: { reason: 'target closed' } })
  }
}

function send(msg) {
  if (!relayWs) return
  try {
    relayWs.send(JSON.stringify(msg))
  } catch {}
}

// AUTO-ATTACH: Automatically attach to tabs when they load
async function autoAttachTab(tabId, url) {
  // Skip chrome:// and extension pages
  if (url?.startsWith('chrome://') || url?.startsWith('chrome-extension://') || url?.startsWith('devtools://')) {
    return
  }
  
  if (autoAttachedTabs.has(tabId)) {
    return // Already attached
  }
  
  try {
    setBadge(tabId, 'connecting')
    await ensureRelayConnection()
    await doAttach({ tabId })
    console.log(`[OpenClaw] Auto-attached to tab ${tabId}: ${url}`)
  } catch (err) {
    console.error(`[OpenClaw] Auto-attach failed for tab ${tabId}:`, err)
    setBadge(tabId, 'error')
  }
}

// Listen for tab updates to auto-attach
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && !autoAttachedTabs.has(tabId)) {
    autoAttachTab(tabId, tab.url)
  }
})

// Listen for tab creation
chrome.tabs.onCreated.addListener((tab) => {
  // Wait for the tab to load
  const checkAndAttach = () => {
    chrome.tabs.get(tab.id, (t) => {
      if (chrome.runtime.lastError) return
      if (t.status === 'complete' && t.url) {
        autoAttachTab(t.id, t.url)
      } else {
        setTimeout(checkAndAttach, 500)
      }
    })
  }
  setTimeout(checkAndAttach, 500)
})

// Auto-attach to existing tabs on startup
chrome.runtime.onStartup.addListener(() => {
  chrome.tabs.query({}, (existingTabs) => {
    for (const tab of existingTabs) {
      if (tab.id && tab.url && tab.status === 'complete') {
        autoAttachTab(tab.id, tab.url)
      }
    }
  })
})

// Also attach on extension install/update
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({}, (existingTabs) => {
    for (const tab of existingTabs) {
      if (tab.id && tab.url && tab.status === 'complete') {
        autoAttachTab(tab.id, tab.url)
      }
    }
  })
})

// Keep service worker alive
setInterval(() => {
  chrome.runtime.getPlatformInfo(() => {})
}, 20000)

console.log('[OpenClaw Auto-Attach] Extension loaded - will auto-attach to all tabs')

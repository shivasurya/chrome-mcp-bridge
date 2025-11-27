// Background service worker for Chrome MCP Bridge
let ws = null;
let reconnectInterval = null;
let authToken = null;
let authenticated = false;

// Configuration
const WS_SERVER_URL = 'ws://localhost:8765';
const RECONNECT_DELAY = 3000;
const AUTH_TOKEN_STORAGE_KEY = 'mcp_auth_token';

// Load saved auth token
chrome.storage.local.get([AUTH_TOKEN_STORAGE_KEY], (result) => {
  if (result[AUTH_TOKEN_STORAGE_KEY]) {
    authToken = result[AUTH_TOKEN_STORAGE_KEY];
    console.log('Loaded saved auth token');
  }
});

// Connect to MCP WebSocket server
function connectWebSocket() {
  console.log('Attempting to connect to MCP server...');

  try {
    ws = new WebSocket(WS_SERVER_URL);

    ws.onopen = () => {
      console.log('Connected to MCP server, attempting authentication...');
      clearInterval(reconnectInterval);
      reconnectInterval = null;

      // Send authentication message
      if (authToken) {
        sendToServer({
          type: 'auth',
          token: authToken
        });
      } else {
        console.error('No auth token available - authentication will fail');
        console.log('Please set auth token in extension popup');
      }
    };

    ws.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('Received message from server:', message);

        // Handle authentication response
        if (message.type === 'auth_response') {
          if (message.success) {
            authenticated = true;
            console.log('✅ Authentication successful!');
          } else {
            authenticated = false;
            console.error('❌ Authentication failed:', message.message);
            ws.close();
          }
          return;
        }

        // Ignore non-command messages if not authenticated
        if (!authenticated) {
          console.warn('Not authenticated, ignoring message');
          return;
        }

        const response = await handleCommand(message);

        // Send response back to server
        sendToServer({
          type: 'response',
          requestId: message.id,
          success: response.success,
          data: response.data,
          error: response.error
        });
      } catch (error) {
        console.error('Error processing message:', error);
        sendToServer({
          type: 'response',
          requestId: message?.id,
          success: false,
          error: error.message
        });
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('Disconnected from MCP server');
      ws = null;

      // Attempt to reconnect
      if (!reconnectInterval) {
        reconnectInterval = setInterval(connectWebSocket, RECONNECT_DELAY);
      }
    };
  } catch (error) {
    console.error('Failed to create WebSocket:', error);
    if (!reconnectInterval) {
      reconnectInterval = setInterval(connectWebSocket, RECONNECT_DELAY);
    }
  }
}

// Send message to server
function sendToServer(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  } else {
    console.error('WebSocket is not connected');
  }
}

// Handle commands from MCP server
async function handleCommand(message) {
  const { command, params } = message;

  try {
    switch (command) {
      case 'openPage':
        return await openPage(params);

      case 'closePage':
        return await closePage(params);

      case 'screenshot':
        return await takeScreenshot(params);

      case 'scroll':
        return await scrollPage(params);

      case 'find':
        return await findInPage(params);

      case 'getCurrentTab':
        return await getCurrentTab();

      case 'listTabs':
        return await listTabs();

      case 'click':
        return await clickElement(params);

      case 'fillForm':
        return await fillFormFields(params);

      case 'getPageContent':
        return await getPageContent(params);

      default:
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Command: Open a new page
async function openPage(params) {
  const { url, active = true, newWindow = false } = params;

  if (!url) {
    throw new Error('URL is required');
  }

  // Validate URL
  let finalUrl = url;
  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
    finalUrl = 'https://' + url;
  }

  if (newWindow) {
    const window = await chrome.windows.create({
      url: finalUrl,
      focused: active
    });

    return {
      success: true,
      data: {
        windowId: window.id,
        tabId: window.tabs[0].id,
        url: finalUrl
      }
    };
  } else {
    const tab = await chrome.tabs.create({
      url: finalUrl,
      active: active
    });

    // Wait for the tab to finish loading
    await waitForTabLoad(tab.id);

    return {
      success: true,
      data: {
        tabId: tab.id,
        url: tab.url,
        title: tab.title
      }
    };
  }
}

// Command: Close a page
async function closePage(params) {
  const { tabId } = params;

  if (!tabId) {
    // Close current active tab
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      await chrome.tabs.remove(activeTab.id);
      return {
        success: true,
        data: { tabId: activeTab.id }
      };
    } else {
      throw new Error('No active tab found');
    }
  }

  await chrome.tabs.remove(tabId);
  return {
    success: true,
    data: { tabId }
  };
}

// Command: Take screenshot
async function takeScreenshot(params) {
  const { tabId, format = 'png', quality = 90, fullPage = false } = params;

  let targetTabId = tabId;

  if (!targetTabId) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) {
      throw new Error('No active tab found');
    }
    targetTabId = activeTab.id;
  }

  // Make sure the tab is active
  await chrome.tabs.update(targetTabId, { active: true });

  let dataUrl;

  if (fullPage) {
    // Full page screenshot using scrolling and stitching
    dataUrl = await captureFullPage(targetTabId, format, quality);
  } else {
    // Just capture visible viewport
    dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: format,
      quality: format === 'jpeg' ? quality : undefined
    });
  }

  return {
    success: true,
    data: {
      screenshot: dataUrl,
      format: format,
      tabId: targetTabId,
      fullPage: fullPage
    }
  };
}

// Helper: Capture full page screenshot
async function captureFullPage(tabId, format, quality) {
  // Get page dimensions and viewport size
  const dimensions = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      return {
        pageWidth: document.documentElement.scrollWidth,
        pageHeight: document.documentElement.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        originalScrollX: window.scrollX,
        originalScrollY: window.scrollY
      };
    }
  });

  const {
    pageWidth,
    pageHeight,
    viewportWidth,
    viewportHeight,
    originalScrollX,
    originalScrollY
  } = dimensions[0].result;

  // If page fits in viewport, just take one screenshot
  if (pageHeight <= viewportHeight && pageWidth <= viewportWidth) {
    return await chrome.tabs.captureVisibleTab(null, {
      format: format,
      quality: format === 'jpeg' ? quality : undefined
    });
  }

  // Calculate number of screenshots needed
  const cols = Math.ceil(pageWidth / viewportWidth);
  const rows = Math.ceil(pageHeight / viewportHeight);

  const screenshots = [];

  // Capture screenshots in a grid
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * viewportWidth;
      const y = row * viewportHeight;

      // Scroll to position
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (scrollX, scrollY) => {
          window.scrollTo(scrollX, scrollY);
        },
        args: [x, y]
      });

      // Wait for scroll to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Capture screenshot
      const dataUrl = await chrome.tabs.captureVisibleTab(null, {
        format: 'png', // Always use PNG for stitching
        quality: undefined
      });

      screenshots.push({
        dataUrl,
        x,
        y,
        row,
        col
      });
    }
  }

  // Restore original scroll position
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (scrollX, scrollY) => {
      window.scrollTo(scrollX, scrollY);
    },
    args: [originalScrollX, originalScrollY]
  });

  // Stitch screenshots together using canvas
  const stitched = await chrome.scripting.executeScript({
    target: { tabId },
    func: (screenshots, pageWidth, pageHeight, viewportWidth, viewportHeight, outputFormat, outputQuality) => {
      return new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = pageWidth;
        canvas.height = pageHeight;
        const ctx = canvas.getContext('2d');

        let loaded = 0;
        const total = screenshots.length;

        screenshots.forEach(({ dataUrl, x, y }) => {
          const img = new Image();
          img.onload = () => {
            ctx.drawImage(img, x, y);
            loaded++;

            if (loaded === total) {
              // Convert to desired format
              const finalDataUrl = canvas.toDataURL(
                outputFormat === 'jpeg' ? 'image/jpeg' : 'image/png',
                outputFormat === 'jpeg' ? outputQuality / 100 : undefined
              );
              resolve(finalDataUrl);
            }
          };
          img.src = dataUrl;
        });
      });
    },
    args: [screenshots, pageWidth, pageHeight, viewportWidth, viewportHeight, format, quality]
  });

  return stitched[0].result;
}

// Command: Scroll page
async function scrollPage(params) {
  const { tabId, x = 0, y = 0, behavior = 'smooth' } = params;

  let targetTabId = tabId;

  if (!targetTabId) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) {
      throw new Error('No active tab found');
    }
    targetTabId = activeTab.id;
  }

  await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: (scrollX, scrollY, scrollBehavior) => {
      window.scrollTo({
        left: scrollX,
        top: scrollY,
        behavior: scrollBehavior
      });
    },
    args: [x, y, behavior]
  });

  return {
    success: true,
    data: { tabId: targetTabId, x, y }
  };
}

// Command: Find text in page
async function findInPage(params) {
  const { tabId, text, highlightAll = false } = params;

  if (!text) {
    throw new Error('Search text is required');
  }

  let targetTabId = tabId;

  if (!targetTabId) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) {
      throw new Error('No active tab found');
    }
    targetTabId = activeTab.id;
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: (searchText, highlight) => {
      const found = window.find(searchText);

      if (highlight && found) {
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          return {
            found: true,
            text: range.toString(),
            position: {
              x: range.getBoundingClientRect().left,
              y: range.getBoundingClientRect().top
            }
          };
        }
      }

      return { found };
    },
    args: [text, highlightAll]
  });

  return {
    success: true,
    data: {
      tabId: targetTabId,
      ...results[0].result
    }
  };
}

// Get current active tab
async function getCurrentTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!activeTab) {
    throw new Error('No active tab found');
  }

  return {
    success: true,
    data: {
      id: activeTab.id,
      url: activeTab.url,
      title: activeTab.title,
      status: activeTab.status
    }
  };
}

// List all tabs
async function listTabs() {
  const tabs = await chrome.tabs.query({});

  return {
    success: true,
    data: {
      tabs: tabs.map(tab => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        windowId: tab.windowId,
        status: tab.status
      }))
    }
  };
}

// Command: Click element
async function clickElement(params) {
  const {
    tabId,
    selector,
    selectorType = 'css',
    waitForElement = true,
    timeout = 5000
  } = params;

  if (!selector) {
    throw new Error('Selector is required');
  }

  let targetTabId = tabId;

  if (!targetTabId) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) {
      throw new Error('No active tab found');
    }
    targetTabId = activeTab.id;
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: (sel, selType, wait, maxTimeout) => {
      return new Promise((resolve, reject) => {
        const findElement = () => {
          let element;

          if (selType === 'xpath') {
            const result = document.evaluate(
              sel,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null
            );
            element = result.singleNodeValue;
          } else {
            element = document.querySelector(sel);
          }

          return element;
        };

        const attemptClick = () => {
          const element = findElement();

          if (element) {
            // Scroll element into view
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // Click the element
            element.click();

            resolve({
              success: true,
              selector: sel,
              selectorType: selType,
              elementFound: true,
              clicked: true
            });
          } else if (wait) {
            // Element not found yet, keep waiting
            return false;
          } else {
            reject(new Error(`Element not found: ${sel}`));
          }

          return true;
        };

        if (wait) {
          // Poll for element with timeout
          const startTime = Date.now();
          const pollInterval = setInterval(() => {
            if (attemptClick()) {
              clearInterval(pollInterval);
            } else if (Date.now() - startTime > maxTimeout) {
              clearInterval(pollInterval);
              reject(new Error(`Timeout waiting for element: ${sel}`));
            }
          }, 100);
        } else {
          // Try to click immediately
          if (!attemptClick()) {
            reject(new Error(`Element not found: ${sel}`));
          }
        }
      });
    },
    args: [selector, selectorType, waitForElement, timeout]
  });

  return {
    success: true,
    data: {
      tabId: targetTabId,
      ...results[0].result
    }
  };
}

// Command: Fill form fields
async function fillFormFields(params) {
  const {
    tabId,
    fields,
    waitForElements = true,
    timeout = 5000
  } = params;

  if (!fields || !Array.isArray(fields) || fields.length === 0) {
    throw new Error('Fields array is required and must not be empty');
  }

  let targetTabId = tabId;

  if (!targetTabId) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) {
      throw new Error('No active tab found');
    }
    targetTabId = activeTab.id;
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: (fieldsData, wait, maxTimeout) => {
      return new Promise((resolve, reject) => {
        const fieldResults = [];

        const findElement = (selector, selectorType) => {
          if (selectorType === 'xpath') {
            const result = document.evaluate(
              selector,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null
            );
            return result.singleNodeValue;
          } else {
            return document.querySelector(selector);
          }
        };

        const fillField = (fieldConfig) => {
          const { selector, selectorType = 'css', value, clear = true } = fieldConfig;
          const element = findElement(selector, selectorType);

          if (!element) {
            return {
              selector,
              success: false,
              error: 'Element not found'
            };
          }

          // Scroll element into view
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });

          // Clear existing value if requested
          if (clear) {
            element.value = '';
          }

          // Set the value
          element.value = value;

          // Trigger input events to notify listeners
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));

          return {
            selector,
            success: true,
            value
          };
        };

        const fillAllFields = () => {
          let allFound = true;

          for (const field of fieldsData) {
            const result = fillField(field);
            fieldResults.push(result);

            if (!result.success && wait) {
              allFound = false;
            }
          }

          return allFound;
        };

        if (wait) {
          // Poll for all elements with timeout
          const startTime = Date.now();
          const pollInterval = setInterval(() => {
            if (fillAllFields()) {
              clearInterval(pollInterval);
              resolve({
                success: true,
                fieldsFilled: fieldResults.filter(r => r.success).length,
                totalFields: fieldsData.length,
                results: fieldResults
              });
            } else if (Date.now() - startTime > maxTimeout) {
              clearInterval(pollInterval);
              resolve({
                success: false,
                error: 'Timeout waiting for some elements',
                fieldsFilled: fieldResults.filter(r => r.success).length,
                totalFields: fieldsData.length,
                results: fieldResults
              });
            } else {
              // Reset for next attempt
              fieldResults.length = 0;
            }
          }, 100);
        } else {
          // Try to fill immediately
          fillAllFields();
          resolve({
            success: fieldResults.every(r => r.success),
            fieldsFilled: fieldResults.filter(r => r.success).length,
            totalFields: fieldsData.length,
            results: fieldResults
          });
        }
      });
    },
    args: [fields, waitForElements, timeout]
  });

  return {
    success: true,
    data: {
      tabId: targetTabId,
      ...results[0].result
    }
  };
}

// Command: Get page content
async function getPageContent(params) {
  const {
    tabId,
    format = 'html',
    includeMetadata = true
  } = params;

  let targetTabId = tabId;

  if (!targetTabId) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) {
      throw new Error('No active tab found');
    }
    targetTabId = activeTab.id;
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: (contentFormat) => {
      const getHtml = () => {
        return document.documentElement.outerHTML;
      };

      const getText = () => {
        return document.body.innerText;
      };

      const getMetadata = () => {
        return {
          title: document.title,
          url: window.location.href,
          domain: window.location.hostname,
          description: document.querySelector('meta[name="description"]')?.content || '',
          keywords: document.querySelector('meta[name="keywords"]')?.content || '',
          ogTitle: document.querySelector('meta[property="og:title"]')?.content || '',
          ogDescription: document.querySelector('meta[property="og:description"]')?.content || '',
          ogImage: document.querySelector('meta[property="og:image"]')?.content || '',
          canonicalUrl: document.querySelector('link[rel="canonical"]')?.href || '',
          lang: document.documentElement.lang || '',
          charset: document.characterSet || ''
        };
      };

      switch (contentFormat) {
        case 'html':
          return {
            html: getHtml(),
            metadata: getMetadata()
          };
        case 'text':
          return {
            text: getText(),
            metadata: getMetadata()
          };
        case 'both':
          return {
            html: getHtml(),
            text: getText(),
            metadata: getMetadata()
          };
        default:
          return {
            html: getHtml(),
            metadata: getMetadata()
          };
      }
    },
    args: [format]
  });

  const content = results[0].result;
  const tabInfo = await chrome.tabs.get(targetTabId);

  return {
    success: true,
    data: {
      tabId: targetTabId,
      format: format,
      ...content,
      ...(includeMetadata ? {
        tabInfo: {
          url: tabInfo.url,
          title: tabInfo.title,
          status: tabInfo.status,
          favIconUrl: tabInfo.favIconUrl
        }
      } : {})
    }
  };
}

// Helper: Wait for tab to finish loading
function waitForTabLoad(tabId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeout);

    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    // Check if already loaded
    chrome.tabs.get(tabId, (tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    });
  });
}

// Initialize connection on extension load
connectWebSocket();

// Listen for extension icon click
chrome.action.onClicked.addListener(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log('MCP Bridge is connected');
  } else {
    console.log('MCP Bridge is disconnected, attempting to reconnect...');
    connectWebSocket();
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getStatus') {
    sendResponse({
      connected: ws && ws.readyState === WebSocket.OPEN,
      authenticated: authenticated,
      hasToken: !!authToken
    });
  } else if (message.type === 'reconnect') {
    connectWebSocket();
    sendResponse({ success: true });
  } else if (message.type === 'setToken') {
    authToken = message.token;
    // Save token to storage
    chrome.storage.local.set({ [AUTH_TOKEN_STORAGE_KEY]: authToken }, () => {
      console.log('Auth token saved');
      // Reconnect with new token
      if (ws) {
        ws.close();
      }
      authenticated = false;
      connectWebSocket();
      sendResponse({ success: true });
    });
    return true; // Keep channel open for async response
  } else if (message.type === 'getToken') {
    sendResponse({ token: authToken || '' });
  }
  return true; // Keep the message channel open for async response
});

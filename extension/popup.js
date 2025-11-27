// Popup script for Chrome MCP Bridge
document.addEventListener('DOMContentLoaded', () => {
  const statusDiv = document.getElementById('status');
  const statusText = document.getElementById('statusText');
  const tokenInput = document.getElementById('tokenInput');
  const saveTokenBtn = document.getElementById('saveTokenBtn');
  const reconnectBtn = document.getElementById('reconnectBtn');

  // Load saved token
  chrome.runtime.sendMessage({ type: 'getToken' }, (response) => {
    if (response && response.token) {
      tokenInput.value = response.token;
    }
  });

  // Check connection status
  function updateStatus() {
    chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
      if (response) {
        if (response.connected && response.authenticated) {
          statusDiv.className = 'status connected';
          statusText.textContent = '✓ Connected & Authenticated';
          reconnectBtn.disabled = true;
        } else if (response.connected && !response.authenticated) {
          statusDiv.className = 'status disconnected';
          statusText.textContent = '⚠ Connected but not authenticated';
          reconnectBtn.disabled = false;
        } else {
          statusDiv.className = 'status disconnected';
          statusText.textContent = '✗ Disconnected from MCP Server';
          reconnectBtn.disabled = false;
        }
      }
    });
  }

  // Save token button
  saveTokenBtn.addEventListener('click', () => {
    const token = tokenInput.value.trim();

    if (!token) {
      alert('Please enter a token');
      return;
    }

    saveTokenBtn.textContent = 'Saving...';
    saveTokenBtn.disabled = true;

    chrome.runtime.sendMessage({
      type: 'setToken',
      token: token
    }, (response) => {
      if (response && response.success) {
        saveTokenBtn.textContent = 'Saved! Connecting...';
        setTimeout(() => {
          saveTokenBtn.textContent = 'Save Token & Connect';
          saveTokenBtn.disabled = false;
          updateStatus();
        }, 2000);
      } else {
        saveTokenBtn.textContent = 'Save Token & Connect';
        saveTokenBtn.disabled = false;
        alert('Failed to save token');
      }
    });
  });

  // Reconnect button
  reconnectBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'reconnect' });
    reconnectBtn.textContent = 'Reconnecting...';
    reconnectBtn.disabled = true;
    setTimeout(() => {
      reconnectBtn.textContent = 'Reconnect';
      updateStatus();
    }, 1000);
  });

  // Initial status check
  updateStatus();

  // Update status every 2 seconds
  setInterval(updateStatus, 2000);
});

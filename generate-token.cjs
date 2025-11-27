#!/usr/bin/env node

/**
 * Generate a secure random token for Chrome MCP Bridge authentication
 */

const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

const token = generateToken();

console.log('\n🔐 Chrome MCP Bridge Access Token Generated!\n');
console.log('Token:', token);
console.log('\n📋 Manual Configuration Steps:\n');
console.log('1. Find your Claude Code config file:');
console.log('   macOS/Linux: ~/.config/claude-code/claude_desktop_config.json');
console.log('   Windows: %APPDATA%\\claude-code\\claude_desktop_config.json\n');
console.log('2. Add this configuration:\n');
console.log('{');
console.log('  "mcpServers": {');
console.log('    "chrome-mcp-bridge": {');
console.log('      "command": "node",');
console.log('      "args": [');
console.log('        "/absolute/path/to/chrome-mcp-bridge/dist/index.js",');
console.log(`        "--token=${token}"`);
console.log('      ]');
console.log('    }');
console.log('  }');
console.log('}\n');
console.log('3. Replace /absolute/path/to/chrome-mcp-bridge with your actual path');
console.log('4. Enter this same token in the Chrome extension popup');
console.log('5. Restart Claude Code\n');

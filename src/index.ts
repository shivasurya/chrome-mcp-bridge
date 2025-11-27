#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, WebSocket } from "ws";
import * as fs from "fs";
import * as path from "path";

// Parse command line arguments
const args = process.argv.slice(2);
const tokenArg = args.find(arg => arg.startsWith('--token='));
const AUTH_TOKEN = tokenArg ? tokenArg.split('=')[1] : null;

// WebSocket server for extension communication
const WS_PORT = 8765;
let extensionSocket: WebSocket | null = null;
let pendingRequests = new Map<string, { resolve: Function; reject: Function }>();

// Start WebSocket server
const wss = new WebSocketServer({ port: WS_PORT });

// Check for authentication token
if (!AUTH_TOKEN) {
  console.error(`❌ ERROR: No authentication token provided!`);
  console.error(`   Run: node generate-token.cjs to create a secure token`);
  console.error(`   Then add it to your MCP config: --token=YOUR_TOKEN`);
  process.exit(1);
}

wss.on("listening", () => {
  console.error(`WebSocket server listening on port ${WS_PORT}`);
  console.error(`🔐 Authentication enabled - token required`);
});

wss.on("error", (error) => {
  console.error("WebSocket server error:", error.message);
});

wss.on("connection", (ws: WebSocket) => {
  console.error("Extension attempting to connect...");
  let authenticated = false;

  ws.on("message", (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      console.error("Received from extension:", message);

      // Handle authentication
      if (message.type === "auth") {
        if (message.token === AUTH_TOKEN) {
          authenticated = true;
          extensionSocket = ws;
          ws.send(JSON.stringify({
            type: "auth_response",
            success: true,
            message: "Authentication successful"
          }));
          console.error("Extension authenticated successfully");
        } else {
          ws.send(JSON.stringify({
            type: "auth_response",
            success: false,
            message: "Invalid authentication token"
          }));
          console.error("Authentication failed: invalid token");
          ws.close();
        }
        return;
      }

      // Reject messages if not authenticated
      if (!authenticated) {
        console.error("Rejecting message from unauthenticated connection");
        ws.send(JSON.stringify({
          type: "error",
          message: "Not authenticated"
        }));
        return;
      }

      if (message.type === "response" && message.requestId) {
        const pending = pendingRequests.get(message.requestId);
        if (pending) {
          if (message.success) {
            pending.resolve(message.data);
          } else {
            pending.reject(new Error(message.error || "Unknown error"));
          }
          pendingRequests.delete(message.requestId);
        }
      }
    } catch (error) {
      console.error("Error parsing message from extension:", error);
    }
  });

  ws.on("close", () => {
    console.error("Extension disconnected");
    extensionSocket = null;
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

// Send command to extension and wait for response
function sendCommandToExtension(
  command: string,
  params: any,
  timeout = 30000
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
      reject(new Error("Extension not connected"));
      return;
    }

    const requestId = `${Date.now()}-${Math.random()}`;
    const message = {
      id: requestId,
      command,
      params,
    };

    // Store pending request
    pendingRequests.set(requestId, { resolve, reject });

    // Set timeout
    const timeoutId = setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(new Error(`Request timeout after ${timeout}ms`));
      }
    }, timeout);

    // Clear timeout when resolved
    const originalResolve = resolve;
    const originalReject = reject;

    pendingRequests.set(requestId, {
      resolve: (data: any) => {
        clearTimeout(timeoutId);
        originalResolve(data);
      },
      reject: (error: Error) => {
        clearTimeout(timeoutId);
        originalReject(error);
      },
    });

    // Send message
    extensionSocket.send(JSON.stringify(message));
  });
}

// Define available tools
const tools: Tool[] = [
  {
    name: "browser_open_page",
    description:
      "Open a new page in the Island browser. Can open in a new tab or new window.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to open (e.g., https://example.com)",
        },
        active: {
          type: "boolean",
          description: "Whether to make the new tab/window active (default: true)",
          default: true,
        },
        newWindow: {
          type: "boolean",
          description: "Whether to open in a new window instead of a new tab (default: false)",
          default: false,
        },
      },
      required: ["url"],
    },
  },
  {
    name: "browser_close_page",
    description:
      "Close a browser tab. If no tabId is provided, closes the current active tab.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "The ID of the tab to close (optional, closes active tab if not provided)",
        },
      },
    },
  },
  {
    name: "browser_screenshot",
    description:
      "Take a screenshot of the browser tab. Can capture just the visible viewport or the entire scrollable page. Optionally save to disk.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "The ID of the tab to screenshot (optional, uses active tab if not provided)",
        },
        format: {
          type: "string",
          enum: ["png", "jpeg"],
          description: "Image format for the screenshot (default: png)",
          default: "png",
        },
        quality: {
          type: "number",
          description: "Quality for JPEG format (0-100, default: 90)",
          default: 90,
        },
        fullPage: {
          type: "boolean",
          description: "Capture the entire scrollable page instead of just the visible viewport (default: false)",
          default: false,
        },
        saveToFile: {
          type: "boolean",
          description: "Save the screenshot to disk in .chrome-mcp-bridge/images/ directory (default: false)",
          default: false,
        },
        cwd: {
          type: "string",
          description: "Current working directory where .chrome-mcp-bridge/images/ directory will be created (required if saveToFile is true)",
        },
        filename: {
          type: "string",
          description: "Custom filename for the saved screenshot (optional, auto-generated if not provided)",
        },
      },
    },
  },
  {
    name: "browser_scroll",
    description: "Scroll the page to a specific position.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "The ID of the tab to scroll (optional, uses active tab if not provided)",
        },
        x: {
          type: "number",
          description: "Horizontal scroll position in pixels (default: 0)",
          default: 0,
        },
        y: {
          type: "number",
          description: "Vertical scroll position in pixels (default: 0)",
          default: 0,
        },
        behavior: {
          type: "string",
          enum: ["smooth", "auto"],
          description: "Scroll behavior (default: smooth)",
          default: "smooth",
        },
      },
    },
  },
  {
    name: "browser_find",
    description: "Find and highlight text in the current page.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "The ID of the tab to search in (optional, uses active tab if not provided)",
        },
        text: {
          type: "string",
          description: "The text to search for in the page",
        },
        highlightAll: {
          type: "boolean",
          description: "Whether to highlight all matches (default: false)",
          default: false,
        },
      },
      required: ["text"],
    },
  },
  {
    name: "browser_get_current_tab",
    description: "Get information about the current active tab.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "browser_list_tabs",
    description: "List all open tabs in the browser.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "browser_click",
    description: "Click on an element in the page using a CSS selector or XPath.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "The ID of the tab (optional, uses active tab if not provided)",
        },
        selector: {
          type: "string",
          description: "CSS selector or XPath to locate the element (e.g., '#submit-button', '//button[text()=\"Submit\"]')",
        },
        selectorType: {
          type: "string",
          enum: ["css", "xpath"],
          description: "Type of selector (default: css)",
          default: "css",
        },
        waitForElement: {
          type: "boolean",
          description: "Wait for the element to be present before clicking (default: true)",
          default: true,
        },
        timeout: {
          type: "number",
          description: "Maximum time to wait for element in milliseconds (default: 5000)",
          default: 5000,
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "browser_fill_form",
    description: "Fill out form fields in the page. Can fill multiple fields at once.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "The ID of the tab (optional, uses active tab if not provided)",
        },
        fields: {
          type: "array",
          description: "Array of form fields to fill",
          items: {
            type: "object",
            properties: {
              selector: {
                type: "string",
                description: "CSS selector or XPath to locate the field",
              },
              selectorType: {
                type: "string",
                enum: ["css", "xpath"],
                description: "Type of selector (default: css)",
                default: "css",
              },
              value: {
                type: "string",
                description: "Value to fill in the field",
              },
              clear: {
                type: "boolean",
                description: "Clear existing value before filling (default: true)",
                default: true,
              },
            },
            required: ["selector", "value"],
          },
        },
        waitForElements: {
          type: "boolean",
          description: "Wait for elements to be present before filling (default: true)",
          default: true,
        },
        timeout: {
          type: "number",
          description: "Maximum time to wait for elements in milliseconds (default: 5000)",
          default: 5000,
        },
      },
      required: ["fields"],
    },
  },
  {
    name: "browser_get_page_content",
    description: "Get the rendered HTML content, text content, or both from a page after it has loaded. Includes page metadata like title, description, and Open Graph tags.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: {
          type: "number",
          description: "The ID of the tab (optional, uses active tab if not provided)",
        },
        format: {
          type: "string",
          enum: ["html", "text", "both"],
          description: "The format of content to retrieve: 'html' for full HTML, 'text' for visible text only, 'both' for both formats (default: html)",
          default: "html",
        },
        includeMetadata: {
          type: "boolean",
          description: "Include page metadata like title, description, Open Graph tags, etc. (default: true)",
          default: true,
        },
      },
    },
  },
];

// Create MCP server
const server = new Server(
  {
    name: "island-browser-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: any;

    switch (name) {
      case "browser_open_page":
        result = await sendCommandToExtension("openPage", args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };

      case "browser_close_page":
        result = await sendCommandToExtension("closePage", args || {});
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };

      case "browser_screenshot":
        result = await sendCommandToExtension("screenshot", args || {});

        // Handle file saving if requested
        let savedPath: string | null = null;
        if (args?.saveToFile) {
          if (!args.cwd || typeof args.cwd !== "string") {
            throw new Error("cwd parameter is required when saveToFile is true");
          }

          // Create the directory structure
          const imagesDir = path.join(args.cwd as string, ".chrome-mcp-bridge", "images");
          if (!fs.existsSync(imagesDir)) {
            fs.mkdirSync(imagesDir, { recursive: true });
          }

          // Generate filename if not provided
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const filename = (args.filename as string) || `screenshot-${timestamp}.${result.format}`;
          savedPath = path.join(imagesDir, filename);

          // Extract base64 data and save to file
          const base64Data = result.screenshot.split(",")[1];
          const buffer = Buffer.from(base64Data, "base64");
          fs.writeFileSync(savedPath, buffer);
        }

        // Return the screenshot as both text description and image
        const textContent = savedPath
          ? `Screenshot captured successfully from tab ${result.tabId} and saved to: ${savedPath}`
          : `Screenshot captured successfully from tab ${result.tabId}`;

        return {
          content: [
            {
              type: "text",
              text: textContent,
            },
            {
              type: "image",
              data: result.screenshot.split(",")[1], // Remove data:image/png;base64, prefix
              mimeType: `image/${result.format}`,
            },
          ],
        };

      case "browser_scroll":
        result = await sendCommandToExtension("scroll", args || {});
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };

      case "browser_find":
        result = await sendCommandToExtension("find", args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };

      case "browser_get_current_tab":
        result = await sendCommandToExtension("getCurrentTab", {});
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };

      case "browser_list_tabs":
        result = await sendCommandToExtension("listTabs", {});
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };

      case "browser_click":
        result = await sendCommandToExtension("click", args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };

      case "browser_fill_form":
        result = await sendCommandToExtension("fillForm", args);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };

      case "browser_get_page_content":
        result = await sendCommandToExtension("getPageContent", args || {});
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Island Browser MCP server running on stdio");

  // When stdin closes, close the WebSocket server to allow process to exit
  process.stdin.on("end", () => {
    console.error("Stdin closed, shutting down WebSocket server...");
    wss.close(() => {
      console.error("WebSocket server closed");
    });
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

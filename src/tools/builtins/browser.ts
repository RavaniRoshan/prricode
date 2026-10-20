/**
 * The browser surface: the target's twenty-two browser tools.
 *
 * Evidence: the target's own browser tool module, read out of the pinned build
 * (`chunk-g8377zgj.js:4271` — the tool array; `chunk-g8377zgj.js:615` — the
 * timeout table; `chunk-g8377zgj.js:716` and `:895` — the two group sets),
 * the target's browser MCP server (`chunk-0yzm074t.js:37995`; the module's
 * exports at `chunk-c4dsgjwz.js:818`), the target's own permission check for
 * these tools (`chunk-nv2bdxwv.js:11614`), the host-side check
 * (`chunk-zs5mxjzs.js:11446`) and the "safe" predicate
 * (`chunk-4jsg44k7.js:1013787`). The full reading, with every offset, is
 * `/home/shiva/opt/reference-agent-rea/analysis/findings-browser.md`.
 *
 * **The target has a browser surface and this implementation does not.** The
 * target reaches its browser through a Chrome extension, over a local socket to
 * the browser's native-messaging host, and it drives a **tab group**. This
 * implementation has no extension, no native host, no socket and no tab group,
 * so every one of these tools **refuses** and names the capability it needs. A
 * stub that returned a plausible page would be worse than a refusal, because
 * the model would act on it.
 *
 * **The data is the target's.** The twenty-two names, their order, their
 * descriptions, their input schemas, their titles, their result-size caps, the
 * two group sets and the timeout table are the target's own, read out of the
 * pinned build. The **one** substitution is the product's own name: the target
 * says its own product name where this implementation says "PRRICODE in Chrome".
 *
 * **The names are the target's bare names.** The target reaches these tools
 * through a browser MCP server, so the model calls them
 * `mcp__<server>__<tool>`; the tool array itself holds the **bare** names, and
 * those are the names this implementation registers. The rule engine therefore
 * matches a rule written `navigate(...)` and not one written with the server
 * prefix.
 *
 * **The schemas are the target's, verbatim.** They do **not** declare
 * `additionalProperties: false`, so — unlike the rest of this implementation's
 * tools — a browser call may carry an argument the schema does not name. The
 * divergence is deliberate: the schema is the target's, byte for byte, and it
 * is recorded in `docs/compatibility/tool-surface.md`.
 *
 * Implementation choices (the target does not pin them, so they are marked here):
 *
 *   - The **refusal** is this implementation's own. The target has a browser,
 *     so the target never refuses; here the refusal is a typed
 *     `capabilityUnavailable` that names the capability the tool needs.
 *   - The **permission rule for the safe subset** is the target's own rule, read
 *     out of `chunk-nv2bdxwv.js:11614`: a tool of the session group that the
 *     target's own predicate calls *safe* is allowed without a prompt. A **deny
 *     rule** and an **ask rule** both still win — only the *generic* prompt (the
 *     one that exists because no rule matched) becomes an allow. This is the one
 *     place a built-in tool answers the generic prompt with an allow, and it is
 *     here because the target's own rule says so.
 *   - The **validation** is this implementation's own: it checks the target's
 *     schema — the required fields, the types, the enums and the bounds — and it
 *     reports the typed codes the rest of this implementation reports.
 *   - The **input and output shapes** are not reproduced. The target's tools
 *     answer with an MCP tool result, and there is no such envelope here.
 */

import { TOOL_ERROR_CODES, type ToolDefinition } from '../registry.js';
import type { PermissionDecision, ToolContext } from '../../permissions/decision.js';

import {
  capabilityRefusal,
  checkToolPermissions,
  recheckToolPermissions,
  type BuiltinToolDeps,
} from './shared.js';

/** One of the target's browser tools. */
export interface BrowserToolSpec {
  /** The tool's name, as the model calls it. */
  name: string;
  /** The title the target gives the tool, when it gives one. */
  title?: string;
  /** The description the model sees. */
  description: string;
  /** The input schema, as JSON Schema. */
  inputSchema: unknown;
  /** The result-size cap the target puts on the tool's `_meta`. */
  _meta?: Readonly<Record<string, number>>;
}

/**
 * The target's twenty-two browser tools, in the target's own order.
 *
 * **The data is the target's.** The names, the descriptions and the input schemas
 * are the target's own, read out of the pinned build (`chunk-g8377zgj.js:4271` —
 * the tool array). The one substitution is the product's own name: the target
 * says its own product name where the surface says "PRRICODE in Chrome".
 */
export const BROWSER_TOOL_SPECS: readonly BrowserToolSpec[] = Object.freeze([
  {
    name: 'javascript_tool',
    description: "Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: "Must be set to 'javascript_exec'",
        },
        text: {
          type: 'string',
          description: 'The JavaScript code to execute. Evaluated in the page context with REPL semantics: top-level `await` works, and the result of the last expression is returned automatically — write the expression you want (e.g. `window.myData.value`, or `await fetch(url).then(r=>r.json())`) rather than `return ...`. You can access and modify the DOM, call page functions, and interact with page variables.',
        },
        tabId: {
          type: 'number',
          description: "Tab ID to execute the code in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
      },
      required: [
        'action',
        'text',
        'tabId',
      ],
    },
  },
  {
    name: 'read_page',
    description: "Get an accessibility tree representation of elements on the page. By default returns all elements including non-visible ones. Output is limited to 50000 characters by default. If the output exceeds this limit it is truncated at a line boundary, with a note giving the full size — pass a larger max_chars, or use depth/ref_id to focus on part of the page. Optionally filter for only interactive elements. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: [
            'interactive',
            'all',
          ],
          description: 'Filter elements: "interactive" for buttons/links/inputs only, "all" for all elements including non-visible ones (default: all elements)',
        },
        tabId: {
          type: 'number',
          description: "Tab ID to read from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
        depth: {
          type: 'number',
          description: 'Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large.',
        },
        ref_id: {
          type: 'string',
          description: 'Reference ID of a parent element to read. Will return the specified element and all its children. Use this to focus on a specific part of the page when output is too large.',
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs.',
        },
      },
      required: [
        'tabId',
      ],
    },
    _meta: Object.freeze({
      'anthropic/maxResultSizeChars': 60000,
    }),
  },
  {
    name: 'find',
    description: `Find elements on the page using natural language. Can search for elements by their purpose (e.g., "search bar", "login button") or by text content (e.g., "organic mango product"). Returns up to 20 matching elements with references that can be used with other tools. If more than 20 matches exist, you'll be notified to use a more specific query. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic")',
        },
        tabId: {
          type: 'number',
          description: "Tab ID to search in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
      },
      required: [
        'query',
        'tabId',
      ],
    },
  },
  {
    name: 'form_input',
    description: "Set values in form elements using element reference ID from the read_page tool. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: {
      type: 'object',
      properties: {
        ref: {
          type: 'string',
          description: 'Element reference ID from the read_page tool (e.g., "ref_1", "ref_2")',
        },
        value: {
          type: [
            'string',
            'boolean',
            'number',
          ],
          description: 'The value to set. For checkboxes use boolean, for selects use option value or text, for other inputs use appropriate string/number',
        },
        tabId: {
          type: 'number',
          description: "Tab ID to set form value in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
      },
      required: [
        'ref',
        'value',
        'tabId',
      ],
    },
  },
  {
    name: 'computer',
    description: "Use a mouse and keyboard to interact with a web browser, and take screenshots. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.\n* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.\n* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.",
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'left_click',
            'right_click',
            'type',
            'screenshot',
            'wait',
            'scroll',
            'key',
            'left_click_drag',
            'double_click',
            'triple_click',
            'zoom',
            'scroll_to',
            'hover',
          ],
          description: 'The action to perform:\n* `left_click`: Click the left mouse button at the specified coordinates.\n* `right_click`: Click the right mouse button at the specified coordinates to open context menus.\n* `double_click`: Double-click the left mouse button at the specified coordinates.\n* `triple_click`: Triple-click the left mouse button at the specified coordinates.\n* `type`: Type a string of text.\n* `screenshot`: Take a screenshot of the screen.\n* `wait`: Wait for a specified number of seconds.\n* `scroll`: Scroll up, down, left, or right at the specified coordinates.\n* `key`: Press a specific keyboard key.\n* `left_click_drag`: Drag from start_coordinate to coordinate.\n* `zoom`: Take a screenshot of a specific region for closer inspection.\n* `scroll_to`: Scroll an element into view using its element reference ID from read_page or find tools.\n* `hover`: Move the mouse cursor to the specified coordinates or element without clicking. Useful for revealing tooltips, dropdown menus, or triggering hover states.',
        },
        coordinate: {
          type: 'array',
          items: {
            type: 'number',
          },
          minItems: 2,
          maxItems: 2,
          description: '(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. Required for `left_click`, `right_click`, `double_click`, `triple_click`, and `scroll`. For `left_click_drag`, this is the end position.',
        },
        text: {
          type: 'string',
          description: `The text to type (for \`type\` action) or the key(s) to press (for \`key\` action). For \`key\` action: Provide space-separated keys (e.g., "Backspace Backspace Delete"). Supports keyboard shortcuts using the platform's modifier key (use "cmd" on Mac, "ctrl" on Windows/Linux, e.g., "cmd+a" or "ctrl+a" for select all). Page zoom shortcuts (e.g. "cmd+=", "ctrl+-", "cmd+0") are not supported and will return an error - use the \`zoom\` action to magnify a region of the page instead.`,
        },
        duration: {
          type: 'number',
          minimum: 0,
          maximum: 10,
          description: 'The number of seconds to wait. Required for `wait`. Maximum 10 seconds.',
        },
        scroll_direction: {
          type: 'string',
          enum: [
            'up',
            'down',
            'left',
            'right',
          ],
          description: 'The direction to scroll. Required for `scroll`.',
        },
        scroll_amount: {
          type: 'number',
          minimum: 1,
          maximum: 10,
          description: 'The number of scroll wheel ticks. Optional for `scroll`, defaults to 3.',
        },
        start_coordinate: {
          type: 'array',
          items: {
            type: 'number',
          },
          minItems: 2,
          maxItems: 2,
          description: '(x, y): The starting coordinates for `left_click_drag`.',
        },
        region: {
          type: 'array',
          items: {
            type: 'number',
          },
          minItems: 4,
          maxItems: 4,
          description: '(x0, y0, x1, y1): The rectangular region to capture for `zoom`. Coordinates define a rectangle from top-left (x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for `zoom` action. Useful for inspecting small UI elements like icons, buttons, or text.',
        },
        scale: {
          type: 'number',
          minimum: 0.1,
          maximum: 1,
          description: "For `screenshot` and `zoom` only. Scale factor in [0.1, 1] for the returned image; 1 (default) uses the full image token budget, 0.5 returns an image at half the width and height (~quarter of the tokens). Coordinates are ALWAYS in the full-resolution coordinate frame (reported with every scaled screenshot), never in the scaled image's own pixels. Requires a PRRICODE in Chrome extension version that supports scale; older extensions return the full-size image.",
        },
        repeat: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Number of times to repeat the key sequence. Only applicable for `key` action. Must be a positive integer between 1 and 100. Default is 1. Useful for navigation tasks like pressing arrow keys multiple times.',
        },
        ref: {
          type: 'string',
          description: 'Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Required for `scroll_to` action. Can be used as alternative to `coordinate` for click actions.',
        },
        modifiers: {
          type: 'string',
          description: 'Modifier keys for click actions. Supports: "ctrl", "shift", "alt", "cmd" (or "meta"), "win" (or "windows"). Can be combined with "+" (e.g., "ctrl+shift", "cmd+alt"). Optional.',
        },
        tabId: {
          type: 'number',
          description: "Tab ID to execute the action on. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
        save_to_disk: {
          type: 'boolean',
          description: "For screenshot/zoom actions: save the image to disk so it can be attached to a message for the user. Returns the saved path in the tool result. Only set this when you intend to share the image — screenshots you're just looking at don't need saving.",
        },
      },
      required: [
        'action',
        'tabId',
      ],
    },
  },
  {
    name: 'browser_batch',
    description: "Execute a sequence of browser tool calls in ONE round trip. Each item is {name, input} where input is exactly what you'd pass to that tool standalone. Actions execute SEQUENTIALLY (not in parallel) and stop on the first error. Use this tool extensively to quickly execute work whenever you can predict two or more steps ahead — e.g. navigate, click a field, type, press Return, screenshot. Each tool's own permission check runs per item — if an action navigates to a domain without permission, the next item's check fails and the batch stops. Screenshots and other images are returned interleaved with outputs; coordinates you write in THIS batch refer to the screenshot taken BEFORE this call. browser_batch cannot be nested.",
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Tool name (e.g. computer, navigate, find, tabs_create_mcp). browser_batch cannot be nested.',
              },
              input: {
                type: 'object',
                description: "That tool's input — same shape you'd pass when calling it directly.",
              },
            },
            required: [
              'name',
              'input',
            ],
          },
          description: 'List of tool calls to execute sequentially. Example: [{"name":"computer","input":{"action":"left_click","coordinate":[100,200],"tabId":123}},{"name":"computer","input":{"action":"type","text":"hello","tabId":123}},{"name":"navigate","input":{"url":"https://example.com","tabId":123}}]',
        },
      },
      required: [
        'actions',
      ],
    },
    _meta: Object.freeze({
      'anthropic/maxResultSizeChars': 60000,
    }),
  },
  {
    name: 'navigate',
    description: `Navigate to a URL, or go forward/back in browser history. tabId may be omitted for URL navigation when calling navigate STANDALONE (not inside browser_batch): tabs_context_mcp{createIfEmpty:true} is called for you and the first tab in the session's group is navigated — its result is appended to this call's output so you have the tab list and ids for subsequent calls. Inside browser_batch, navigate (and other tools that act on a page) requires an explicit tabId. Pass an explicit tabId when you need a specific tab or when the session's group has multiple tabs whose state you must preserve. tabId is required for url:"back"/"forward". A tab opened for you this way is yours to clean up, the same as one from tabs_create_mcp: close it with tabs_close_mcp once you no longer need it and before finishing your task, unless the user asked to see it or wants it kept open.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history.',
        },
        tabId: {
          type: 'number',
          description: 'Tab ID to navigate. Must be a tab in the current group. If omitted for URL navigation when calling navigate standalone, tabs_context_mcp{createIfEmpty:true} is called for you. Required for url:"back"/"forward" and for navigate (and other tools that act on a page) inside browser_batch.',
        },
      },
      required: [
        'url',
      ],
    },
  },
  {
    name: 'resize_window',
    description: "Resize the current browser window to specified dimensions. Useful for testing responsive designs or setting up specific screen sizes. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: {
      type: 'object',
      properties: {
        width: {
          type: 'number',
          description: 'Target window width in pixels',
        },
        height: {
          type: 'number',
          description: 'Target window height in pixels',
        },
        tabId: {
          type: 'number',
          description: "Tab ID to get the window for. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
      },
      required: [
        'width',
        'height',
        'tabId',
      ],
    },
  },
  {
    name: 'gif_creator',
    description: "Manage GIF recording and export for browser automation sessions. Control when to start/stop recording browser actions (clicks, scrolls, navigation), then export as an animated GIF with visual overlays (click indicators, action labels, progress bar, watermark). All operations are scoped to the tab's group. When starting recording, take a screenshot immediately after to capture the initial state as the first frame. When stopping recording, take a screenshot immediately before to capture the final state as the last frame. For export, either provide 'coordinate' to drag/drop upload to a page element, or set 'download: true' to download the GIF.",
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'start_recording',
            'stop_recording',
            'export',
            'clear',
          ],
          description: "Action to perform: 'start_recording' (begin capturing), 'stop_recording' (stop capturing but keep frames), 'export' (generate and export GIF), 'clear' (discard frames)",
        },
        tabId: {
          type: 'number',
          description: 'Tab ID to identify which tab group this operation applies to',
        },
        download: {
          type: 'boolean',
          description: "Always set this to true for the 'export' action only. This causes the gif to be downloaded in the browser.",
        },
        filename: {
          type: 'string',
          description: "Optional filename for exported GIF (default: 'recording-[timestamp].gif'). For 'export' action only.",
        },
        options: {
          type: 'object',
          description: "Optional GIF enhancement options for 'export' action. Properties: showClickIndicators (bool), showDragPaths (bool), showActionLabels (bool), showProgressBar (bool), showWatermark (bool), quality (number 1-30). All default to true except quality (default: 10).",
          properties: {
            showClickIndicators: {
              type: 'boolean',
              description: 'Show orange circles at click locations (default: true)',
            },
            showDragPaths: {
              type: 'boolean',
              description: 'Show red arrows for drag actions (default: true)',
            },
            showActionLabels: {
              type: 'boolean',
              description: 'Show black labels describing actions (default: true)',
            },
            showProgressBar: {
              type: 'boolean',
              description: 'Show orange progress bar at bottom (default: true)',
            },
            showWatermark: {
              type: 'boolean',
              description: 'Show PRRICODE logo watermark (default: true)',
            },
            quality: {
              type: 'number',
              description: 'GIF compression quality, 1-30 (lower = better quality, slower encoding). Default: 10',
            },
          },
        },
      },
      required: [
        'action',
        'tabId',
      ],
    },
  },
  {
    name: 'upload_image',
    description: "Upload a screenshot you took with the computer tool's screenshot action to a file input or drag & drop target. Screenshot IDs expire a few minutes after capture, so take the screenshot of what you want to upload right before uploading. Don't reuse an ID that an upload already failed with: to retry, take a new screenshot of the same content, and retry that upload at most once (never after the user declined). This tool cannot upload user-attached images or other files; use file_upload with the file's path for those, if that tool is available. Supports two approaches: (1) ref - for targeting specific elements, especially hidden file inputs, (2) coordinate - for drag & drop to visible locations like Google Docs. Provide either ref or coordinate, not both.",
    inputSchema: {
      type: 'object',
      properties: {
        imageId: {
          type: 'string',
          description: "ID of a screenshot from the computer tool's screenshot action, taken shortly before this call. IDs of user-attached images are not accepted.",
        },
        ref: {
          type: 'string',
          description: 'Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Use this for file inputs (especially hidden ones) or specific elements. Provide either ref or coordinate, not both.',
        },
        coordinate: {
          type: 'array',
          items: {
            type: 'number',
          },
          description: 'Viewport coordinates [x, y] for drag & drop to a visible location. Use this for drag & drop targets like Google Docs. Provide either ref or coordinate, not both.',
        },
        tabId: {
          type: 'number',
          description: 'Tab ID where the target element is located. This is where the image will be uploaded to.',
        },
        filename: {
          type: 'string',
          description: 'Optional filename for the uploaded file (default: "image.png")',
        },
      },
      required: [
        'imageId',
        'tabId',
      ],
    },
  },
  {
    name: 'get_page_text',
    description: "Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: "Tab ID to extract text from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
      },
      required: [
        'tabId',
      ],
    },
    _meta: Object.freeze({
      'anthropic/maxResultSizeChars': 60000,
    }),
  },
  {
    name: 'tabs_context_mcp',
    title: 'Tabs Context',
    description: 'Get context information about the current MCP tab group. Returns all tab IDs inside the group if it exists. CRITICAL: You must get the context at least once before using other browser automation tools so you know what tabs exist. Each new conversation should create its own new tab (using tabs_create_mcp) rather than reusing existing tabs, unless the user explicitly asks to use an existing tab.',
    inputSchema: {
      type: 'object',
      properties: {
        createIfEmpty: {
          type: 'boolean',
          description: 'Creates a new MCP tab group if none exists, creates a new Window with a new tab group containing an empty tab (which can be used for this conversation). If a MCP tab group already exists, this parameter has no effect.',
        },
      },
      required: [],
    },
  },
  {
    name: 'tabs_create_mcp',
    title: 'Tabs Create',
    description: 'Creates a new empty tab in the MCP tab group. CRITICAL: You must get the context using tabs_context_mcp at least once before using other browser automation tools so you know what tabs exist. Tabs you create are yours to clean up: close each one with tabs_close_mcp as soon as you no longer need it, and close any that remain before finishing your task. Leave a tab open only if the user asked to see it or wants it kept open.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'tabs_close_mcp',
    title: 'Tabs Close',
    description: "Close a tab in the MCP tab group by its ID. Use to clean up tabs you're done with. Only tabs in this session's group are closable; call tabs_context_mcp first to get valid IDs. If you close the group's last tab, Chrome auto-removes the group — the next tabs_context_mcp with createIfEmpty starts fresh.",
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'integer',
          description: "The ID of the tab to close. Must be in this session's tab group. Get valid IDs from tabs_context_mcp.",
        },
      },
      required: [
        'tabId',
      ],
    },
  },
  {
    name: 'read_console_messages',
    description: "Read browser console messages (console.log, console.error, console.warn, etc.) from a specific tab. Useful for debugging JavaScript errors, viewing application logs, or understanding what's happening in the browser console. Returns console messages from the current domain only. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs. IMPORTANT: Always provide a pattern to filter messages - without a pattern, you may get too many irrelevant messages.",
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: "Tab ID to read console messages from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
        onlyErrors: {
          type: 'boolean',
          description: 'If true, only return error and exception messages. Default is false (return all message types).',
        },
        clear: {
          type: 'boolean',
          description: 'If true, clear the console messages after reading to avoid duplicates on subsequent calls. Default is false.',
        },
        pattern: {
          type: 'string',
          description: "Regex pattern to filter console messages. Only messages matching this pattern will be returned (e.g., 'error|warning' to find errors and warnings, 'MyApp' to filter app-specific logs). You should always provide a pattern to avoid getting too many irrelevant messages.",
        },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to return. Defaults to 100. Increase only if you need more results.',
        },
      },
      required: [
        'tabId',
      ],
    },
  },
  {
    name: 'read_network_requests',
    description: "Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab. Useful for debugging API calls, monitoring network activity, or understanding what requests a page is making. Returns all network requests made by the current page, including cross-origin requests. Requests are automatically cleared when the page navigates to a different domain. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: "Tab ID to read network requests from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
        urlPattern: {
          type: 'string',
          description: "Optional URL pattern to filter requests. Only requests whose URL contains this string will be returned (e.g., '/api/' to filter API calls, 'example.com' to filter by domain).",
        },
        clear: {
          type: 'boolean',
          description: 'If true, clear the network requests after reading to avoid duplicates on subsequent calls. Default is false.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of requests to return. Defaults to 100. Increase only if you need more results.',
        },
      },
      required: [
        'tabId',
      ],
    },
  },
  {
    name: 'shortcuts_list',
    description: 'List all available shortcuts and workflows (shortcuts and workflows are interchangeable). Returns shortcuts with their commands, descriptions, and whether they are workflows. Use shortcuts_execute to run a shortcut or workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: "Tab ID to list shortcuts from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
      },
      required: [
        'tabId',
      ],
    },
  },
  {
    name: 'shortcuts_execute',
    description: 'Execute a shortcut or workflow by running it in a new sidepanel window using the current tab (shortcuts and workflows are interchangeable). Use shortcuts_list first to see available shortcuts. This starts the execution and returns immediately - it does not wait for completion.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: {
          type: 'number',
          description: "Tab ID to execute the shortcut on. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
        shortcutId: {
          type: 'string',
          description: 'The ID of the shortcut to execute',
        },
        command: {
          type: 'string',
          description: "The command name of the shortcut to execute (e.g., 'debug', 'summarize'). Do not include the leading slash.",
        },
      },
      required: [
        'tabId',
      ],
    },
  },
  {
    name: 'file_upload',
    description: "Upload one or multiple files to a file input element on the page. Do not click on file upload buttons or file inputs — clicking opens a native file picker dialog that you cannot see or interact with. Instead, use read_page or find to locate the file input element, then use this tool with its ref to upload files directly. Only files the user has shared with this session (attachments, the session's outputs/uploads folders, or folders the user has connected) can be uploaded; other paths will be rejected. The combined size of all files in a single call must stay under 10 MB.",
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: {
            type: 'string',
          },
          description: 'Absolute paths to the files to upload. Each path must be a file the user has shared with this session.',
        },
        ref: {
          type: 'string',
          description: 'Element reference ID of the file input from read_page or find tools (e.g., "ref_1", "ref_2").',
        },
        tabId: {
          type: 'number',
          description: "Tab ID where the file input is located. Use tabs_context_mcp first if you don't have a valid tab ID.",
        },
      },
      required: [
        'paths',
        'ref',
        'tabId',
      ],
    },
  },
  {
    name: 'switch_browser',
    description: "Send a connection request to every Chrome browser with the extension installed and wait (up to 2 minutes) for the user to click 'Connect' in the one they want to use. The user can name the browser when they connect. Use this when the user wants to pick the browser themselves from inside Chrome rather than choosing from a list; otherwise prefer select_browser with a known deviceId.",
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_connected_browsers',
    description: "List all Chrome browsers (extension instances) currently connected to this account. Returns each browser's deviceId, display name, OS platform, isLocal (its OS matches this computer's, a weak hint), when known onThisComputer (it is, or recently was, running on this computer), and inUse on the browser this session's actions go to when that is settled. When the user needs to choose a browser, use this to present the choices before select_browser.",
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'select_browser',
    description: 'Select a specific Chrome browser by deviceId for browser automation, without broadcasting a pairing request. Use this after list_connected_browsers when the user has chosen one from the list.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: {
          type: 'string',
          description: 'The deviceId from list_connected_browsers.',
        },
      },
      required: [
        'deviceId',
      ],
    },
  },
]);

/** The names of the browser tools, in the target's order. */
export const BROWSER_TOOL_NAMES: readonly string[] = Object.freeze(
  BROWSER_TOOL_SPECS.map((spec) => spec.name),
);

/**
 * The target's **session-tool set**: the nine tools that manage the browser
 * session rather than the content of a page.
 *
 * `chunk-g8377zgj.js:716` — the target's own `Ioe`. The three tab-group tools,
 * the two shortcut tools, the window resize, the two browser-selection tools
 * and the GIF recorder.
 */
export const BROWSER_SESSION_TOOL_NAMES: readonly string[] = Object.freeze([
  'tabs_context_mcp',
  'tabs_create_mcp',
  'tabs_close_mcp',
  'shortcuts_list',
  'shortcuts_execute',
  'resize_window',
  'switch_browser',
  'list_connected_browsers',
  'gif_creator',
]);

/**
 * The target's **browser-selection set**: the three tools that need the
 * account-wide browser roster.
 *
 * `chunk-g8377zgj.js:895` — the target's own `jis`. The target withholds these
 * three from the tool list unless the session has a bridge connection
 * (`chunk-0yzm074t.js:37810`), because only the bridge has the roster.
 */
export const BROWSER_SELECTION_TOOL_NAMES: readonly string[] = Object.freeze([
  'switch_browser',
  'list_connected_browsers',
  'select_browser',
]);

/**
 * The target's **always-safe** tools: the five that need no permission at all.
 *
 * `chunk-4jsg44k7.js:1013679` — the target's own `oPo`.
 */
export const BROWSER_SAFE_TOOL_NAMES: readonly string[] = Object.freeze([
  'list_connected_browsers',
  'resize_window',
  'shortcuts_list',
  'switch_browser',
  'tabs_close_mcp',
]);

/**
 * The three tools whose result carries the target's result-size cap.
 *
 * `chunk-g8377zgj.js:6782`, `:15216` and `:21910` — the three `_meta` members
 * in the target's own tool array.
 */
export const BROWSER_RESULT_CAPPED_TOOLS: readonly string[] = Object.freeze([
  'read_page',
  'browser_batch',
  'get_page_text',
]);

/**
 * The result-size cap the target puts on those three tools' `_meta`.
 *
 * `chunk-g8377zgj.js:970` — the target's own `r`.
 */
export const BROWSER_RESULT_SIZE_CAP: Readonly<Record<string, number>> = Object.freeze({
  'anthropic/maxResultSizeChars': 60000,
});

/**
 * The target's **timeout table**, in milliseconds.
 *
 * `chunk-g8377zgj.js:615` — the target's own `hNe`, `LPn`, `ueo`, `Uis`, `peo`
 * and `Bis`. The per-tool override (`browser_batch` at 90 000 ms) is the
 * target's own, at `chunk-ecavx9g0.js:12468`; the two-minute wait of
 * `switch_browser` is at `chunk-0yzm074t.js:12436`, and the eight-second bound
 * on the hidden tab-context lookup is at `chunk-0ga684vy.js:66935`.
 */
export const BROWSER_TIMEOUTS = Object.freeze({
  /** The default tool-call timeout. */
  defaultToolCallMs: 60000,
  /** The `browser_batch` timeout — the target's one per-tool override. */
  browserBatchMs: 90000,
  /** How long the client waits for the extension peer to connect. */
  peerConnectedMs: 10000,
  /** The extension-discovery deadline. */
  extensionDiscoveryMs: 5000,
  /** The bound on the local-device-ids lookup. */
  localDeviceIdsMs: 3000,
  /** The default external-message timeout. */
  externalMessageMs: 150000,
  /** The hard cap on an external-message timeout. */
  externalMessageCapMs: 270000,
  /** How long `switch_browser` waits for the user to click *Connect*. */
  switchBrowserMs: 120000,
  /** The bound on the hidden tab-context lookup `navigate` performs. */
  frontLoadLookupMs: 8000,
});

/**
 * The message the target's own browser tools ask with.
 *
 * `chunk-nv2bdxwv.js:11949` — the target's own message names the product; the
 * product's own name is this implementation's own.
 */
export const BROWSER_PERMISSION_MESSAGE = 'PRRICODE in Chrome requires permission.';

/** The capability a browser tool needs: a browser this session can drive. */
const BROWSER_CAPABILITY = 'connected browser extension';

/**
 * The capability the three browser-selection tools need.
 *
 * They read the account-wide roster of connected browsers, which is the
 * extension's own account connection and not a browser this session drives.
 */
const BROWSER_ROSTER_CAPABILITY = 'browser extension account connection';

/**
 * Whether a browser tool is one of the target's **safe** tools.
 *
 * **The target's own predicate** (`chunk-4jsg44k7.js:1013787`): five tools are
 * always safe, and three more are safe unless they change something —
 * `tabs_context_mcp` is safe unless it creates a tab group, and the two
 * readers are safe unless they clear what they read.
 */
export function isBrowserSafeTool(name: string, input: unknown): boolean {
  if (BROWSER_SAFE_TOOL_NAMES.includes(name)) return true;
  if (name === 'tabs_context_mcp') return !readBoolean(input, 'createIfEmpty');
  if (name === 'read_console_messages' || name === 'read_network_requests') {
    return !readBoolean(input, 'clear');
  }
  return false;
}

/**
 * Read an own boolean field of an input object.
 *
 * The field name comes from the target's own schema and the value from the
 * model, so the lookup is an **own-property** check.
 */
function readBoolean(input: unknown, field: string): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const record = input as Record<string, unknown>;
  if (!Object.hasOwn(record, field)) return false;
  return record[field] === true;
}

/* -------------------------------------------------------------------------- */
/* The schema check                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The subset of JSON Schema the target's own schemas use.
 *
 * The target's browser schemas use the object, array, string, number, integer and
 * boolean types, the `enum`, `required`, `items`, `minimum`, `maximum`,
 * `minItems`, `maxItems` and `maxLength` keywords, and nothing else.
 */
export interface BrowserSchemaNode {
  type?: string | readonly string[];
  enum?: readonly unknown[];
  properties?: Readonly<Record<string, BrowserSchemaNode>>;
  required?: readonly string[];
  items?: BrowserSchemaNode;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
}

/** The result of a schema check. */
type SchemaResult =
  | { ok: true }
  | { ok: false; message: string; errorCode: number };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    default:
      // A type this check does not know is not enforced, rather than refused.
      return true;
  }
}

function matchesDeclaredType(type: string | readonly string[], value: unknown): boolean {
  if (typeof type === 'string') return matchesType(type, value);
  return type.some((entry) => matchesType(entry, value));
}

function describeType(type: string | readonly string[]): string {
  if (typeof type === 'string') return type;
  return type.join(' or ');
}

/**
 * Check a value against the target's own schema.
 *
 * **An argument the schema does not name is accepted.** The target's browser
 * schemas do not close their object, so this check does not close them either.
 */
export function validateAgainstSchema(
  schema: BrowserSchemaNode,
  value: unknown,
  path = '',
): SchemaResult {
  if (schema.type !== undefined && !matchesDeclaredType(schema.type, value)) {
    return {
      ok: false,
      message: `The '${path}' argument must be a ${describeType(schema.type)}.`,
      errorCode: TOOL_ERROR_CODES.invalidInput,
    };
  }

  if (schema.enum !== undefined && !schema.enum.some((entry) => entry === value)) {
    return {
      ok: false,
      message: `The '${path}' argument must be one of ${schema.enum.map((entry) => String(entry)).join(', ')}.`,
      errorCode: TOOL_ERROR_CODES.invalidInput,
    };
  }

  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength) {
    return {
      ok: false,
      message: `The '${path}' argument must be at most ${schema.maxLength} characters.`,
      errorCode: TOOL_ERROR_CODES.invalidInput,
    };
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return {
        ok: false,
        message: `The '${path}' argument must be at least ${schema.minimum}.`,
        errorCode: TOOL_ERROR_CODES.invalidInput,
      };
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return {
        ok: false,
        message: `The '${path}' argument must be at most ${schema.maximum}.`,
        errorCode: TOOL_ERROR_CODES.invalidInput,
      };
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      return {
        ok: false,
        message: `The '${path}' argument must have at least ${schema.minItems} items.`,
        errorCode: TOOL_ERROR_CODES.invalidInput,
      };
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      return {
        ok: false,
        message: `The '${path}' argument must have at most ${schema.maxItems} items.`,
        errorCode: TOOL_ERROR_CODES.invalidInput,
      };
    }
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        const result = validateAgainstSchema(
          schema.items,
          value[index],
          path === '' ? `[${index}]` : `${path}[${index}]`,
        );
        if (!result.ok) return result;
      }
    }
    return { ok: true };
  }

  if (isPlainObject(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        return {
          ok: false,
          message: `The '${required}' argument is required.`,
          errorCode: TOOL_ERROR_CODES.missingField,
        };
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      const child = schema.properties?.[key];
      if (child === undefined) continue;
      const result = validateAgainstSchema(child, entry, key);
      if (!result.ok) return result;
    }
  }

  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* The tools                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Create the browser tools.
 *
 * **Every one of them refuses.** There is no browser behind them, so a call
 * ends in a typed refusal that names the capability it needed.
 */
export function createBrowserTools(deps: BuiltinToolDeps): ToolDefinition[] {
  return BROWSER_TOOL_SPECS.map((spec) => createBrowserTool(spec, deps));
}

/**
 * Create one browser tool.
 */
function createBrowserTool(spec: BrowserToolSpec, deps: BuiltinToolDeps): ToolDefinition {
  const schema = spec.inputSchema as BrowserSchemaNode;
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    mutatesFiles: false,

    async checkPermissions(input, ctx: ToolContext) {
      const decision = await checkToolPermissions(ctx, deps);
      return applyBrowserRule(decision, spec.name, input);
    },

    async recheckPermission(input, ctx: ToolContext) {
      const recheck = await recheckToolPermissions(ctx, deps);
      if (recheck.decision === undefined) return recheck;
      // The re-check runs the **same** rule against the **effective** input, so
      // a rewrite that makes a safe call unsafe — a tab group created, a
      // console cleared — asks, and a rewrite that leaves it safe still does
      // not.
      return {
        ...recheck,
        decision: applyBrowserRule(recheck.decision, spec.name, input),
      };
    },

    async validateInput(input) {
      return validateAgainstSchema(schema, input);
    },

    async execute(_input, _ctx) {
      throw capabilityRefusal(
        spec.name,
        BROWSER_SELECTION_TOOL_NAMES.includes(spec.name)
          ? BROWSER_ROSTER_CAPABILITY
          : BROWSER_CAPABILITY,
      );
    },
  };
}

/**
 * The target's own rule for the safe subset, applied to a decision.
 *
 * A tool of the session group that the target's own predicate calls *safe* is
 * allowed without a prompt. A **deny rule** and an **ask rule** both still win
 * — only the *generic* prompt (the one that exists because no rule matched)
 * becomes an allow.
 */
function applyBrowserRule(
  decision: PermissionDecision,
  name: string,
  input: unknown,
): PermissionDecision {
  if (decision.behavior !== 'ask' || decision.noRuleMatched !== true) return decision;

  if (isBrowserSafeTool(name, input)) {
    return {
      behavior: 'allow',
      source: 'unknown',
      reasonType: 'other',
      reason: `The ${name} tool is one of the browser tools that need no permission, so the call was allowed.`,
    };
  }

  return {
    ...decision,
    reason: BROWSER_PERMISSION_MESSAGE,
    message: BROWSER_PERMISSION_MESSAGE,
  };
}

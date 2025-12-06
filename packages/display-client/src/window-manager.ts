/**
 * Display Client - Window Manager
 *
 * Manages window rendering, state, and user interaction.
 * Receives sync/update/delete messages and renders windows to the DOM.
 *
 * ARCHITECTURE
 * ============
 * - Windows stored in Map by id
 * - Elements stored in Map by id, grouped by window_id
 * - Each window is a positioned div with title bar and content area
 * - Dragging updates local position, sends event to server
 *
 * @module display-client/window-manager
 */

import type {
    Window,
    Element,
    SyncData,
    UpdateData,
    DeleteData,
    EventData,
} from './types.js';

// =============================================================================
// TYPES
// =============================================================================

export interface WindowManagerConfig {
    /** Container element for windows */
    container: HTMLElement;

    /** Callback to send events to server */
    onEvent?: (event: EventData) => void;
}

// =============================================================================
// WINDOW MANAGER
// =============================================================================

export class WindowManager {
    private container: HTMLElement;
    private onEvent: ((event: EventData) => void) | undefined;

    /** Windows by id */
    private windows = new Map<string, Window>();

    /** Elements by id */
    private elements = new Map<string, Element>();

    /** DOM elements for windows */
    private windowElements = new Map<string, HTMLElement>();

    /** Currently dragging state */
    private dragging: {
        windowId: string;
        startX: number;
        startY: number;
        startWindowX: number;
        startWindowY: number;
    } | null = null;

    constructor(config: WindowManagerConfig) {
        this.container = config.container;
        this.onEvent = config.onEvent;

        // Global mouse handlers for dragging
        document.addEventListener('mousemove', this.handleMouseMove.bind(this));
        document.addEventListener('mouseup', this.handleMouseUp.bind(this));
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================

    /**
     * Handle sync message - full state replacement.
     */
    sync(data: SyncData): void {
        // Clear existing state
        this.windows.clear();
        this.elements.clear();

        // Clear DOM
        for (const el of this.windowElements.values()) {
            el.remove();
        }

        this.windowElements.clear();

        // Load new state
        for (const win of data.windows) {
            this.windows.set(win.id, win);
        }

        for (const el of data.elements) {
            this.elements.set(el.id, el);
        }

        // Render all windows
        for (const win of this.windows.values()) {
            this.renderWindow(win);
        }
    }

    /**
     * Handle update message - partial update.
     */
    update(data: UpdateData): void {
        if (data.model === 'window') {
            const win = this.windows.get(data.id);

            if (win) {
                Object.assign(win, data.changes);
                this.updateWindowElement(win);
            }
        }
        else if (data.model === 'element') {
            const el = this.elements.get(data.id);

            if (el) {
                Object.assign(el, data.changes);
                this.updateElement(el);
            }
            else {
                // New element
                const newEl = data.changes as Element;
                this.elements.set(data.id, newEl);
                this.renderElement(newEl);
            }
        }
    }

    /**
     * Handle delete message.
     */
    delete(data: DeleteData): void {
        if (data.model === 'window') {
            this.windows.delete(data.id);
            const el = this.windowElements.get(data.id);

            if (el) {
                el.remove();
                this.windowElements.delete(data.id);
            }

            // Remove elements belonging to this window
            for (const [id, elem] of this.elements) {
                if (elem.window_id === data.id) {
                    this.elements.delete(id);
                }
            }
        }
        else if (data.model === 'element') {
            this.elements.delete(data.id);
            const el = document.getElementById(`element-${data.id}`);
            el?.remove();
        }
    }

    // =========================================================================
    // RENDERING
    // =========================================================================

    private renderWindow(win: Window): void {
        // Create window container
        const el = document.createElement('div');
        el.id = `window-${win.id}`;
        el.className = 'window';

        if (win.focused) {
            el.classList.add('focused');
        }

        // Position and size
        el.style.left = `${win.x}px`;
        el.style.top = `${win.y}px`;
        el.style.width = `${win.width}px`;
        el.style.height = `${win.height}px`;
        el.style.zIndex = String(win.z_index);

        if (!win.visible) {
            el.style.display = 'none';
        }

        // Title bar
        const titleBar = document.createElement('div');
        titleBar.className = 'window-title-bar';

        if (win.movable) {
            titleBar.addEventListener('mousedown', (e) => this.startDrag(e, win.id));
        }

        // Title text
        const title = document.createElement('span');
        title.className = 'window-title';
        title.textContent = win.title || 'Untitled';
        titleBar.appendChild(title);

        // Window controls
        const controls = document.createElement('div');
        controls.className = 'window-controls';

        // Minimize button (always show, schema tracks minimized state)
        const minBtn = document.createElement('button');
        minBtn.className = 'window-btn window-btn-min';
        minBtn.innerHTML = '&minus;';
        minBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.sendWindowEvent(win.id, 'minimize');
        });
        controls.appendChild(minBtn);

        // Maximize button (always show, schema tracks maximized state)
        const maxBtn = document.createElement('button');
        maxBtn.className = 'window-btn window-btn-max';
        maxBtn.innerHTML = '&#x25a1;';
        maxBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.sendWindowEvent(win.id, 'maximize');
        });
        controls.appendChild(maxBtn);

        // Close button (only if closable)
        if (win.closable) {
            const closeBtn = document.createElement('button');
            closeBtn.className = 'window-btn window-btn-close';
            closeBtn.innerHTML = '&times;';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.sendWindowEvent(win.id, 'close');
            });
            controls.appendChild(closeBtn);
        }

        titleBar.appendChild(controls);
        el.appendChild(titleBar);

        // Content area
        const content = document.createElement('div');
        content.className = 'window-content';
        content.id = `window-content-${win.id}`;
        el.appendChild(content);

        // Focus on click
        el.addEventListener('mousedown', () => this.focusWindow(win.id));

        this.container.appendChild(el);
        this.windowElements.set(win.id, el);

        // Render elements for this window
        this.renderWindowElements(win.id);
    }

    private updateWindowElement(win: Window): void {
        const el = this.windowElements.get(win.id);

        if (!el) {
            return;
        }

        el.style.left = `${win.x}px`;
        el.style.top = `${win.y}px`;
        el.style.width = `${win.width}px`;
        el.style.height = `${win.height}px`;
        el.style.zIndex = String(win.z_index);
        el.style.display = win.visible ? '' : 'none';

        if (win.focused) {
            el.classList.add('focused');
        }
        else {
            el.classList.remove('focused');
        }

        const title = el.querySelector('.window-title');

        if (title) {
            title.textContent = win.title || 'Untitled';
        }
    }

    private renderWindowElements(windowId: string): void {
        const content = document.getElementById(`window-content-${windowId}`);

        if (!content) {
            return;
        }

        // Get elements for this window, sorted by order
        const windowElements = Array.from(this.elements.values())
            .filter(el => el.window_id === windowId && !el.parent_id)
            .sort((a, b) => a.order_ - b.order_);

        for (const elem of windowElements) {
            this.renderElement(elem, content);
        }
    }

    private renderElement(elem: Element, parent?: HTMLElement): void {
        if (!parent) {
            const windowContent = document.getElementById(`window-content-${elem.window_id}`);

            if (!windowContent) {
                return;
            }

            // If has parent_id, find parent element
            if (elem.parent_id) {
                parent = document.getElementById(`element-${elem.parent_id}`) ?? windowContent;
            }
            else {
                parent = windowContent;
            }
        }

        const el = document.createElement(elem.tag);
        el.id = `element-${elem.id}`;
        el.className = 'element';

        if (elem.text) {
            el.textContent = elem.text;
        }

        if (elem.flex) {
            el.style.flex = elem.flex;
        }

        if (elem.width) {
            el.style.width = elem.width;
        }

        if (elem.height) {
            el.style.height = elem.height;
        }

        if (elem.hidden) {
            el.style.display = 'none';
        }

        if (elem.disabled) {
            (el as HTMLButtonElement).disabled = true;
        }

        // Apply props
        if (elem.props) {
            for (const [key, value] of Object.entries(elem.props)) {
                if (key === 'style' && typeof value === 'object') {
                    Object.assign(el.style, value);
                }
                else if (key === 'className') {
                    el.className += ` ${value}`;
                }
                else if (key.startsWith('on')) {
                    // Event handlers - send to server
                    const eventType = key.slice(2).toLowerCase();
                    el.addEventListener(eventType, (e) => {
                        this.sendElementEvent(elem.id, eventType, e);
                    });
                }
                else {
                    el.setAttribute(key, String(value));
                }
            }
        }

        parent.appendChild(el);

        // Render children
        const children = Array.from(this.elements.values())
            .filter(e => e.parent_id === elem.id)
            .sort((a, b) => a.order_ - b.order_);

        for (const child of children) {
            this.renderElement(child, el);
        }
    }

    private updateElement(elem: Element): void {
        const el = document.getElementById(`element-${elem.id}`);

        if (!el) {
            this.renderElement(elem);
            return;
        }

        if (elem.text !== undefined) {
            el.textContent = elem.text;
        }

        if (elem.hidden !== undefined) {
            el.style.display = elem.hidden ? 'none' : '';
        }

        if (elem.disabled !== undefined) {
            (el as HTMLButtonElement).disabled = elem.disabled;
        }
    }

    // =========================================================================
    // DRAGGING
    // =========================================================================

    private startDrag(e: MouseEvent, windowId: string): void {
        const win = this.windows.get(windowId);

        if (!win) {
            return;
        }

        e.preventDefault();

        this.dragging = {
            windowId,
            startX: e.clientX,
            startY: e.clientY,
            startWindowX: win.x,
            startWindowY: win.y,
        };

        this.focusWindow(windowId);
    }

    private handleMouseMove(e: MouseEvent): void {
        if (!this.dragging) {
            return;
        }

        const win = this.windows.get(this.dragging.windowId);

        if (!win) {
            return;
        }

        const dx = e.clientX - this.dragging.startX;
        const dy = e.clientY - this.dragging.startY;

        win.x = this.dragging.startWindowX + dx;
        win.y = this.dragging.startWindowY + dy;

        this.updateWindowElement(win);
    }

    private handleMouseUp(): void {
        if (!this.dragging) {
            return;
        }

        const win = this.windows.get(this.dragging.windowId);

        if (win) {
            // Send move event to server
            this.sendWindowEvent(win.id, 'move', { x: win.x, y: win.y });
        }

        this.dragging = null;
    }

    // =========================================================================
    // EVENTS
    // =========================================================================

    private focusWindow(windowId: string): void {
        // Update z-index locally
        let maxZ = 0;

        for (const win of this.windows.values()) {
            if (win.z_index > maxZ) {
                maxZ = win.z_index;
            }

            win.focused = win.id === windowId;
        }

        const win = this.windows.get(windowId);

        if (win) {
            win.z_index = maxZ + 1;
        }

        // Update all window elements
        for (const w of this.windows.values()) {
            this.updateWindowElement(w);
        }

        // Send focus event
        this.sendWindowEvent(windowId, 'focus');
    }

    private sendWindowEvent(windowId: string, type: string, data?: Record<string, unknown>): void {
        this.onEvent?.({
            type,
            windowId,
            timestamp: Date.now(),
            data,
        });
    }

    private sendElementEvent(elementId: string, type: string, e: Event): void {
        const elem = this.elements.get(elementId);

        this.onEvent?.({
            type,
            windowId: elem?.window_id,
            elementId,
            timestamp: Date.now(),
            data: this.extractEventData(e),
        });
    }

    private extractEventData(e: Event): Record<string, unknown> {
        const data: Record<string, unknown> = {};

        if (e instanceof MouseEvent) {
            data.x = e.clientX;
            data.y = e.clientY;
            data.button = e.button;
            data.shift = e.shiftKey;
            data.ctrl = e.ctrlKey;
            data.alt = e.altKey;
            data.meta = e.metaKey;
        }
        else if (e instanceof KeyboardEvent) {
            data.key = e.key;
            data.shift = e.shiftKey;
            data.ctrl = e.ctrlKey;
            data.alt = e.altKey;
            data.meta = e.metaKey;
        }

        if (e.target instanceof HTMLInputElement) {
            data.value = e.target.value;
        }

        return data;
    }
}

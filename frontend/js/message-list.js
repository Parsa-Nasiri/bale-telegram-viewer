// Renders the timeline with DOM APIs only (createElement, textContent, property assignment). Message text is never
// parsed as markup. A thumbnail is set as an image source only after safeThumbSource() accepts it.

import { formatBytes, mediaLabel } from "./labels.js";
import { safeThumbSource } from "./thumbnail.js";

const dateFormat = new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short" });
const SKELETON_WIDTHS = [64, 42, 76];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : dateFormat.format(date);
}

export class MessageList {
  #container;
  #onDownload;
  #nodes = new Map();

  constructor(container, { onDownload }) {
    this.#container = container;
    this.#onDownload = onDownload;
  }

  setAll(messages) {
    this.#container.replaceChildren();
    this.#nodes.clear();
    this.#container.append(this.#fragment(messages));
  }

  /** Adds older messages above the current ones. `messages` must be ascending. */
  prepend(messages) {
    this.#container.prepend(this.#fragment(messages));
  }

  /** Placeholder bubbles while a channel loads. The next setAll() replaces them. */
  showSkeleton() {
    this.#container.replaceChildren();
    this.#nodes.clear();
    const fragment = document.createDocumentFragment();
    for (const width of SKELETON_WIDTHS) {
      const line = element("div", "skeleton");
      line.style.width = `${width}%`;
      fragment.append(line);
    }
    this.#container.append(fragment);
  }

  setDownloadStatus(messageId, text) {
    const status = this.#nodes.get(messageId)?.querySelector(".download-status");
    if (status) status.textContent = text;
  }

  #fragment(messages) {
    const fragment = document.createDocumentFragment();
    for (const message of messages) {
      if (this.#nodes.has(message.id)) continue;
      const node = this.#bubble(message);
      this.#nodes.set(message.id, node);
      fragment.append(node);
    }
    return fragment;
  }

  #bubble(message) {
    const bubble = element("article", "bubble");
    bubble.dataset.messageId = String(message.id);
    const thumb = this.#thumb(message);
    if (thumb) bubble.append(thumb);
    if (message.senderName) bubble.append(element("div", "sender", message.senderName));
    if (message.mediaType) bubble.append(this.#media(message));
    if (message.text) bubble.append(element("p", "text", message.text));
    const time = element("time", "meta", formatDate(message.date));
    time.dateTime = message.date;
    bubble.append(time);
    return bubble;
  }

  #thumb(message) {
    const source = safeThumbSource(message.thumb);
    if (!source) return null;
    const image = document.createElement("img");
    image.className = "thumb";
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.src = source;
    return image;
  }

  #media(message) {
    const box = element("div", "media");
    box.append(element("div", "media-title", message.fileName || mediaLabel(message.mediaType)));

    const size = formatBytes(message.sizeBytes);
    if (size) box.append(element("div", "media-size", size));

    if (message.downloadable) {
      const button = element("button", "download-btn", "دریافت فایل");
      button.type = "button";
      button.addEventListener("click", () => this.#onDownload(message, button));
      box.append(button, element("div", "download-status", ""));
    }
    return box;
  }
}

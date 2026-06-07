/*
 * Auto Batch Cover Cropper
 * Copyright (C) 2026 strailico5327
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 */

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"]);
const CANVAS_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const state = {
  queue: [],
  checkedIds: new Set(),
  outputEntries: [],
  selectedId: null,
  sortColumn: "",
  sortReverse: false,
  isProcessing: false,
};

const elements = {
  beforeCanvas: document.querySelector("#beforeCanvas"),
  addFilesButton: document.querySelector("#addFilesButton"),
  addFolderButton: document.querySelector("#addFolderButton"),
  removeButton: document.querySelector("#removeButton"),
  startButton: document.querySelector("#startButton"),
  downloadButton: document.querySelector("#downloadButton"),
  fileInput: document.querySelector("#fileInput"),
  folderInput: document.querySelector("#folderInput"),
  dropZone: document.querySelector("#dropZone"),
  queueBody: document.querySelector("#queueBody"),
  selectAllCheckbox: document.querySelector("#selectAllCheckbox"),
  formatSelect: document.querySelector("#formatSelect"),
  progressBar: document.querySelector("#progressBar"),
};

const crcTable = buildCrcTable();
let nextId = 1;
let previewResizeTimer = 0;

elements.addFilesButton.addEventListener("click", () => elements.fileInput.click());
elements.addFolderButton.addEventListener("click", () => elements.folderInput.click());
elements.fileInput.addEventListener("change", () => {
  addFiles([...elements.fileInput.files]);
  elements.fileInput.value = "";
});
elements.folderInput.addEventListener("change", () => {
  addFiles([...elements.folderInput.files]);
  elements.folderInput.value = "";
});
elements.removeButton.addEventListener("click", removeSelected);
elements.startButton.addEventListener("click", startConversion);
elements.downloadButton.addEventListener("click", downloadOutputs);
elements.selectAllCheckbox.addEventListener("change", toggleAllChecked);
elements.formatSelect.addEventListener("change", clearOutputEntries);
window.addEventListener("resize", schedulePreviewResize);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateSelectedPreview);
if ("ResizeObserver" in window) {
  new ResizeObserver(schedulePreviewResize).observe(document.querySelector(".preview-panel"));
}

document.querySelectorAll("th[data-sort]").forEach((header) => {
  header.addEventListener("click", () => sortQueue(header.dataset.sort));
});

["dragenter", "dragover"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("drag-over");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, () => {
    elements.dropZone.classList.remove("drag-over");
  });
});

elements.dropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  if (state.isProcessing) {
    setStatus("Wait for conversion to finish before dragging more files.");
    return;
  }
  const files = await filesFromDrop(event.dataTransfer);
  addFiles(files);
});

syncPreviewCanvasSizes();
clearPreviews();
renderQueue();

async function addFiles(files) {
  if (state.isProcessing) {
    setStatus("Wait for conversion to finish before adding files.");
    return;
  }

  const existingKeys = new Set(state.queue.map((item) => item.key));
  let added = 0;

  for (const file of files) {
    if (!isImageFile(file)) {
      continue;
    }

    const key = file.webkitRelativePath || `${file.name}:${file.size}:${file.lastModified}`;
    if (existingKeys.has(key)) {
      continue;
    }

    const item = {
      id: nextId++,
      file,
      key,
      name: file.name,
      fileSize: file.size,
      format: formatName(file),
      width: 0,
      height: 0,
      status: "Queued",
    };

    state.queue.push(item);
    existingKeys.add(key);
    added += 1;

    readDimensions(file)
      .then(({ width, height }) => {
        item.width = width;
        item.height = height;
        renderQueue();
        if (state.selectedId === item.id) {
          updateSelectedPreview();
        }
      })
      .catch(() => {
        item.status = "Unreadable";
        renderQueue();
      });
  }

  if (added && state.selectedId === null) {
    state.selectedId = state.queue[0].id;
    updateSelectedPreview();
  }

  if (added) {
    clearOutputEntries();
  }
  renderQueue();
  setStatus(added ? `Added ${added} image(s) to the queue.` : "No new images found.");
}

function removeSelected() {
  if (state.isProcessing || !state.checkedIds.size) {
    return;
  }
  state.queue = state.queue.filter((item) => !state.checkedIds.has(item.id));
  state.checkedIds.clear();
  if (!state.queue.some((item) => item.id === state.selectedId)) {
    state.selectedId = state.queue[0]?.id ?? null;
  }
  clearOutputEntries();
  renderQueue();
  updateSelectedPreview();
  setStatus("Selected image removed.");
}

function clearQueue() {
  if (state.isProcessing) {
    setStatus("Wait for conversion to finish before clearing.");
    return;
  }
  state.queue = [];
  state.checkedIds.clear();
  state.selectedId = null;
  clearOutputEntries();
  renderQueue();
  clearPreviews();
  setProgress(0);
  setStatus("Queue cleared.");
}

function renderQueue() {
  elements.queueBody.innerHTML = "";
  if (!state.queue.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="6" class="empty-cell">No images queued.</td>';
    elements.queueBody.append(row);
    syncQueueControls();
    return;
  }

  for (const item of state.queue) {
    const row = document.createElement("tr");
    row.className = item.id === state.selectedId ? "selected" : "";
    row.dataset.id = String(item.id);
    row.innerHTML = `
      <td class="check-cell">
        <input type="checkbox" aria-label="Select ${escapeHtml(item.name)}" ${state.checkedIds.has(item.id) ? "checked" : ""}>
      </td>
      <td title="${escapeHtml(item.status)}">
        <span class="status-pill ${statusClass(item.status)}">${escapeHtml(statusBadgeText(item.status))}</span>
      </td>
      <td title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</td>
      <td>${item.width && item.height ? `${item.width}x${item.height}` : "Unknown"}</td>
      <td>${formatFileSize(item.fileSize)}</td>
      <td>${escapeHtml(item.format)}</td>
    `;
    const checkbox = row.querySelector("input[type='checkbox']");
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      setItemChecked(item.id, checkbox.checked);
    });
    row.addEventListener("click", () => {
      state.selectedId = item.id;
      renderQueue();
      updateSelectedPreview();
    });
    elements.queueBody.append(row);
  }
  syncQueueControls();
}

function setItemChecked(id, checked) {
  if (checked) {
    state.checkedIds.add(id);
  } else {
    state.checkedIds.delete(id);
  }
  syncQueueControls();
}

function toggleAllChecked() {
  if (elements.selectAllCheckbox.checked) {
    state.checkedIds = new Set(state.queue.map((item) => item.id));
  } else {
    state.checkedIds.clear();
  }
  renderQueue();
}

function syncQueueControls() {
  const total = state.queue.length;
  const checkedCount = state.checkedIds.size;
  const allChecked = total > 0 && checkedCount === total;
  const downloadableCount = downloadableEntriesForChecked().length;

  elements.selectAllCheckbox.checked = allChecked;
  elements.selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < total;
  elements.selectAllCheckbox.disabled = state.isProcessing || total === 0;
  elements.removeButton.textContent = allChecked ? "Clear" : "Remove selected";
  elements.removeButton.disabled = state.isProcessing || checkedCount === 0;
  elements.downloadButton.disabled = state.isProcessing || downloadableCount === 0;
}

function statusBadgeText(status) {
  if (status.startsWith("Done")) {
    return "Done";
  }
  if (status.startsWith("Failed")) {
    return "Failed";
  }
  return status;
}

function statusClass(status) {
  if (status.startsWith("Done")) {
    return "status-done";
  }
  if (status.startsWith("Failed")) {
    return "status-failed";
  }
  if (status.startsWith("Converting")) {
    return "status-active";
  }
  return "status-queued";
}

function sortQueue(column) {
  if (state.sortColumn === column) {
    state.sortReverse = !state.sortReverse;
  } else {
    state.sortColumn = column;
    state.sortReverse = false;
  }

  const sign = state.sortReverse ? -1 : 1;
  state.queue.sort((a, b) => compareValues(sortValue(a, column), sortValue(b, column)) * sign);
  renderQueue();
}

function sortValue(item, column) {
  if (column === "size") {
    return item.width * item.height;
  }
  if (column === "fileSize") {
    return item.fileSize;
  }
  return String(item[column] ?? "").toLowerCase();
}

async function updateSelectedPreview() {
  const item = selectedItem();
  if (!item) {
    clearPreviews();
    return;
  }

  try {
    const image = await loadImage(item.file);
    syncPreviewCanvasSizes();
    drawSourceWithCropMask(elements.beforeCanvas, image);
  } catch (error) {
    clearPreviews();
    setStatus(`Could not preview selected image: ${error.message}`);
  }
}

async function startConversion() {
  if (state.isProcessing) {
    setStatus("Conversion is already running.");
    return;
  }
  if (!state.queue.length) {
    setStatus("Queue is empty.");
    return;
  }

  state.isProcessing = true;
  state.outputEntries = [];
  setProcessingControls(true);
  setProgress(0);

  const requestedFormat = elements.formatSelect.value;
  const outputNames = new Set();
  const zipEntries = [];
  let converted = 0;
  let failed = 0;

  for (let index = 0; index < state.queue.length; index += 1) {
    const item = state.queue[index];
    try {
      item.status = "Converting";
      renderQueue();
      const result = await cropFile(item.file, requestedFormat);
      const outputName = uniqueOutputName(item.name, result.extension, outputNames);
      const bytes = new Uint8Array(await result.blob.arrayBuffer());

      zipEntries.push({ id: item.id, name: outputName, bytes, mimeType: result.blob.type });

      item.status = `Done -> ${outputName}`;
      converted += 1;
    } catch (error) {
      item.status = `Failed: ${error.message}`;
      failed += 1;
    }

    setProgress(((index + 1) / state.queue.length) * 100);
    setStatus(`Converting ${index + 1}/${state.queue.length} image(s). Converted: ${converted}. Failed: ${failed}.`);
    renderQueue();
    await yieldToBrowser();
  }

  state.outputEntries = zipEntries;

  setStatus(`Converted ${converted} image(s).${failed ? ` Failed: ${failed}.` : ""}`);
  state.isProcessing = false;
  setProcessingControls(false);
}

function downloadOutputs() {
  const entries = downloadableEntriesForChecked();
  if (!entries.length) {
    return;
  }
  if (entries.length === 1) {
    const entry = entries[0];
    downloadBlob(new Blob([entry.bytes], { type: entry.mimeType }), entry.name);
    return;
  }

  const zipBlob = createZip(entries);
  downloadBlob(zipBlob, "square_crop_output.zip");
}

function downloadableEntriesForChecked() {
  return state.outputEntries.filter((entry) => state.checkedIds.has(entry.id));
}

async function cropFile(file, requestedFormat) {
  const image = await loadImage(file);
  const size = Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const sx = Math.floor((sourceWidth - size) / 2);
  const sy = Math.floor((sourceHeight - size) / 2);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { alpha: true });
  context.drawImage(image, sx, sy, size, size, 0, 0, size, size);

  const { mimeType, extension } = outputMimeAndExtension(file, requestedFormat);
  const blob = await canvasToBlob(canvas, mimeType, mimeType === "image/jpeg" ? 0.92 : undefined);
  return { blob, extension };
}

function outputMimeAndExtension(file, requestedFormat) {
  if (requestedFormat === "JPG") {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (requestedFormat === "PNG") {
    return { mimeType: "image/png", extension: "png" };
  }

  const sourceMime = file.type.toLowerCase();
  if (CANVAS_MIME_TYPES.has(sourceMime)) {
    return { mimeType: sourceMime, extension: extensionFromMime(sourceMime) };
  }

  const extension = fileExtension(file.name);
  if (extension === "jpg" || extension === "jpeg") {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (extension === "webp") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  return { mimeType: "image/png", extension: "png" };
}

function drawSourceWithCropMask(canvas, image) {
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  context.clearRect(0, 0, width, height);
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = Math.round(sourceWidth * scale);
  const drawHeight = Math.round(sourceHeight * scale);
  const x = Math.round((width - drawWidth) / 2);
  const y = Math.round((height - drawHeight) / 2);
  context.drawImage(image, x, y, drawWidth, drawHeight);

  const cropSize = Math.min(sourceWidth, sourceHeight);
  const cropX = x + ((sourceWidth - cropSize) / 2) * scale;
  const cropY = y + ((sourceHeight - cropSize) / 2) * scale;
  const cropDrawSize = cropSize * scale;

  context.fillStyle = "rgba(0, 0, 0, 0.48)";
  context.fillRect(x, y, drawWidth, Math.max(0, cropY - y));
  context.fillRect(x, cropY + cropDrawSize, drawWidth, Math.max(0, y + drawHeight - cropY - cropDrawSize));
  context.fillRect(x, cropY, Math.max(0, cropX - x), cropDrawSize);
  context.fillRect(cropX + cropDrawSize, cropY, Math.max(0, x + drawWidth - cropX - cropDrawSize), cropDrawSize);
}

function clearPreviews() {
  syncPreviewCanvasSizes();
  drawPlaceholder(elements.beforeCanvas, "No selection");
}

function drawPlaceholder(canvas, text) {
  const context = canvas.getContext("2d");
  const scale = canvasScale(canvas);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = cssVariable("--muted");
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `${14 * scale}px "Segoe UI", system-ui, sans-serif`;
  context.fillText(text, canvas.width / 2, canvas.height / 2);
}

function cssVariable(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function schedulePreviewResize() {
  window.clearTimeout(previewResizeTimer);
  previewResizeTimer = window.setTimeout(() => {
    updateSelectedPreview();
  }, 50);
}

function syncPreviewCanvasSizes() {
  let changed = false;
  for (const canvas of [elements.beforeCanvas]) {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      changed = true;
    }
  }
  return changed;
}

function canvasScale(canvas) {
  return canvas.clientWidth ? canvas.width / canvas.clientWidth : 1;
}

async function filesFromDrop(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  if (!items.length) {
    return [...(dataTransfer.files || [])];
  }

  const files = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) {
      files.push(...await filesFromEntry(entry));
    } else {
      const file = item.getAsFile?.();
      if (file) {
        files.push(file);
      }
    }
  }
  return files;
}

function filesFromEntry(entry) {
  if (entry.isFile) {
    return new Promise((resolve) => entry.file((file) => resolve([file]), () => resolve([])));
  }
  if (!entry.isDirectory) {
    return Promise.resolve([]);
  }

  const reader = entry.createReader();
  return new Promise((resolve) => {
    const entries = [];
    const readBatch = () => {
      reader.readEntries(async (batch) => {
        if (!batch.length) {
          const nested = await Promise.all(entries.map(filesFromEntry));
          resolve(nested.flat());
          return;
        }
        entries.push(...batch);
        readBatch();
      }, () => resolve([]));
    };
    readBatch();
  });
}

function readDimensions(file) {
  return loadImage(file).then((image) => ({
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height,
  }));
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Browser could not decode this image."));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error(`Could not encode ${mimeType}.`));
        return;
      }
      resolve(blob);
    }, mimeType, quality);
  });
}

function createZip(entries) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name.replace(/\\/g, "/"));
    const crc = crc32(entry.bytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.bytes.length, true);
    localView.setUint32(22, entry.bytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localHeader.set(nameBytes, 30);
    localParts.push(localHeader, entry.bytes);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.bytes.length, true);
    centralView.setUint32(24, entry.bytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralParts.push(centralHeader);

    offset += localHeader.length + entry.bytes.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uniqueOutputName(fileName, extension, usedNames) {
  const stem = fileName.replace(/\.[^.]*$/, "");
  let candidate = `${stem}.${extension}`;
  let counter = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${stem}_${counter}.${extension}`;
    counter += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function selectedItem() {
  return state.queue.find((item) => item.id === state.selectedId);
}

function setProcessingControls(processing) {
  elements.startButton.disabled = processing;
  elements.addFilesButton.disabled = processing;
  elements.addFolderButton.disabled = processing;
  syncQueueControls();
}

function setStatus(_message) {
}

function clearOutputEntries() {
  state.outputEntries = [];
  syncQueueControls();
}

function setProgress(value) {
  elements.progressBar.style.width = `${Math.max(0, Math.min(100, value))}%`;
}

function yieldToBrowser() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function isImageFile(file) {
  return file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(fileExtension(file.name));
}

function fileExtension(fileName) {
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

function formatName(file) {
  if (file.type) {
    return file.type.replace("image/", "").toUpperCase();
  }
  return fileExtension(file.name).toUpperCase() || "Image";
}

function extensionFromMime(mimeType) {
  if (mimeType === "image/jpeg") {
    return "jpg";
  }
  if (mimeType === "image/webp") {
    return "webp";
  }
  return "png";
}

function formatFileSize(bytes) {
  let size = Number(bytes);
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (size < 1024 || unit === "GB") {
      return unit === "B" ? `${size} ${unit}` : `${size.toFixed(1)} ${unit}`;
    }
    size /= 1024;
  }
  return `${size.toFixed(1)} GB`;
}

function compareValues(a, b) {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

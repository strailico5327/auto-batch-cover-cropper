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
  selectedId: null,
  sortColumn: "",
  sortReverse: false,
  isProcessing: false,
  cancelRequested: false,
};

const elements = {
  beforeCanvas: document.querySelector("#beforeCanvas"),
  afterCanvas: document.querySelector("#afterCanvas"),
  addFilesButton: document.querySelector("#addFilesButton"),
  addFolderButton: document.querySelector("#addFolderButton"),
  removeButton: document.querySelector("#removeButton"),
  clearButton: document.querySelector("#clearButton"),
  startButton: document.querySelector("#startButton"),
  cancelButton: document.querySelector("#cancelButton"),
  fileInput: document.querySelector("#fileInput"),
  folderInput: document.querySelector("#folderInput"),
  dropZone: document.querySelector("#dropZone"),
  queueBody: document.querySelector("#queueBody"),
  suffixInput: document.querySelector("#suffixInput"),
  formatSelect: document.querySelector("#formatSelect"),
  outputModeSelect: document.querySelector("#outputModeSelect"),
  progressBar: document.querySelector("#progressBar"),
  statusLabel: document.querySelector("#statusLabel"),
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
elements.clearButton.addEventListener("click", clearQueue);
elements.startButton.addEventListener("click", startConversion);
elements.cancelButton.addEventListener("click", () => {
  state.cancelRequested = true;
  setStatus("Cancelling after the current image finishes...");
});
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
      path: file.webkitRelativePath || file.name,
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

  renderQueue();
  setStatus(added ? `Added ${added} image(s) to the queue.` : "No new images found.");
}

function removeSelected() {
  if (state.isProcessing || state.selectedId === null) {
    return;
  }
  const index = state.queue.findIndex((item) => item.id === state.selectedId);
  if (index === -1) {
    return;
  }
  state.queue.splice(index, 1);
  state.selectedId = state.queue[Math.min(index, state.queue.length - 1)]?.id ?? null;
  renderQueue();
  updateSelectedPreview();
  setStatus("Selected image removed.");
}

function clearQueue() {
  if (state.isProcessing) {
    setStatus("Cancel or wait for conversion to finish before clearing.");
    return;
  }
  state.queue = [];
  state.selectedId = null;
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
    return;
  }

  for (const item of state.queue) {
    const row = document.createElement("tr");
    row.className = item.id === state.selectedId ? "selected" : "";
    row.dataset.id = String(item.id);
    row.innerHTML = `
      <td title="${escapeHtml(item.status)}">${escapeHtml(item.status)}</td>
      <td title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</td>
      <td>${item.width && item.height ? `${item.width}x${item.height}` : "Unknown"}</td>
      <td>${formatFileSize(item.fileSize)}</td>
      <td>${escapeHtml(item.format)}</td>
      <td title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</td>
    `;
    row.addEventListener("click", () => {
      state.selectedId = item.id;
      renderQueue();
      updateSelectedPreview();
    });
    elements.queueBody.append(row);
  }
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
    drawContain(elements.beforeCanvas, image);
    drawCroppedSquare(elements.afterCanvas, image);
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
  state.cancelRequested = false;
  setProcessingControls(true);
  setProgress(0);

  const suffix = elements.suffixInput.value;
  const requestedFormat = elements.formatSelect.value;
  const outputMode = elements.outputModeSelect.value;
  const outputNames = new Set();
  const zipEntries = [];
  let outputDirectory = null;
  let converted = 0;
  let failed = 0;

  if (outputMode === "folder" && "showDirectoryPicker" in window) {
    try {
      outputDirectory = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch (error) {
      state.isProcessing = false;
      setProcessingControls(false);
      setStatus(`Output folder was not selected: ${error.message}`);
      return;
    }
  }

  for (let index = 0; index < state.queue.length; index += 1) {
    if (state.cancelRequested) {
      break;
    }

    const item = state.queue[index];
    try {
      item.status = "Converting";
      renderQueue();
      const result = await cropFile(item.file, requestedFormat);
      const outputName = uniqueOutputName(item.name, suffix, result.extension, outputNames);
      const bytes = new Uint8Array(await result.blob.arrayBuffer());

      if (outputDirectory) {
        const handle = await outputDirectory.getFileHandle(outputName, { create: true });
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
      } else {
        zipEntries.push({ name: outputName, bytes, mimeType: result.blob.type });
      }

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

  if (!outputDirectory && zipEntries.length === 1) {
    downloadBlob(new Blob([zipEntries[0].bytes], { type: zipEntries[0].mimeType }), zipEntries[0].name);
  } else if (!outputDirectory && zipEntries.length > 1) {
    const zipBlob = createZip(zipEntries);
    downloadBlob(zipBlob, "square_crop_output.zip");
  }

  const cancelled = state.cancelRequested ? "Cancelled. " : "";
  setStatus(`${cancelled}Converted ${converted} image(s).${failed ? ` Failed: ${failed}.` : ""}`);
  state.isProcessing = false;
  state.cancelRequested = false;
  setProcessingControls(false);
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

function drawContain(canvas, image) {
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
}

function drawCroppedSquare(canvas, image) {
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const size = Math.min(sourceWidth, sourceHeight);
  const sx = Math.floor((sourceWidth - size) / 2);
  const sy = Math.floor((sourceHeight - size) / 2);
  context.clearRect(0, 0, width, width);
  context.drawImage(image, sx, sy, size, size, 0, 0, width, width);
}

function clearPreviews() {
  drawPlaceholder(elements.beforeCanvas, "No selection");
  drawPlaceholder(elements.afterCanvas, "No selection");
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
    if (syncPreviewCanvasSizes()) {
      updateSelectedPreview();
    }
  }, 50);
}

function syncPreviewCanvasSizes() {
  let changed = false;
  for (const canvas of [elements.beforeCanvas, elements.afterCanvas]) {
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

function uniqueOutputName(fileName, suffix, extension, usedNames) {
  const stem = fileName.replace(/\.[^.]*$/, "");
  let candidate = `${stem}${suffix}.${extension}`;
  let counter = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${stem}${suffix}_${counter}.${extension}`;
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
  elements.clearButton.disabled = processing;
  elements.addFilesButton.disabled = processing;
  elements.addFolderButton.disabled = processing;
  elements.removeButton.disabled = processing;
  elements.cancelButton.disabled = !processing;
}

function setStatus(message) {
  elements.statusLabel.textContent = message;
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

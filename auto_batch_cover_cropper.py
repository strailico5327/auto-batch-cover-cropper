from __future__ import annotations

import argparse
import ctypes
import io
import sys
import threading
from dataclasses import dataclass
from pathlib import Path

from PySide6.QtCore import QBuffer, QIODevice, QObject, Qt, QThread, Signal
from PySide6.QtGui import QDragEnterEvent, QDropEvent, QImage, QPixmap
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QFileDialog,
    QFrame,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

try:
    from PIL import Image, ImageDraw, ImageOps
except ImportError as exc:
    raise SystemExit(
        "Auto Batch Cover Cropper needs Pillow. Install it with: python -m pip install Pillow"
    ) from exc


APP_NAME = "Auto Batch Cover Cropper"
ABOUT_TEXT = """Auto Batch Cover Cropper
© 2026 strailico5327

Batch-crop images into square covers.

Licensed under GNU GPLv3."""
PREVIEW_MAX_HEIGHT = 240
PREVIEW_MIN_WIDTH = 140
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
FORMAT_OPTIONS = ("PNG", "JPG", "Original")
SUPPORTED_TYPES = "Images (*.png *.jpg *.jpeg *.webp *.bmp *.tif *.tiff);;PNG (*.png);;JPEG (*.jpg *.jpeg);;All files (*.*)"
COLUMN_KEYS = ("status", "name", "size", "file_size", "format", "path")


@dataclass
class QueueItem:
    source: Path | None
    image: Image.Image | None
    name: str
    width: int
    height: int
    image_format: str
    file_size: int | None
    status: str = "Queued"


def enable_high_dpi_support() -> None:
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        return
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
        return
    except Exception:
        pass
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def is_image_path(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTENSIONS


def collect_image_paths(paths: list[Path]) -> list[Path]:
    collected = []
    seen = set()
    for path in paths:
        if not path.exists():
            continue
        candidates = sorted(path.rglob("*")) if path.is_dir() else [path]
        for candidate in candidates:
            if not candidate.is_file() or not is_image_path(candidate):
                continue
            resolved = candidate.resolve()
            if resolved not in seen:
                collected.append(candidate)
                seen.add(resolved)
    return collected


def center_crop_square(image: Image.Image) -> Image.Image:
    width, height = image.size
    side = min(width, height)
    left = (width - side) // 2
    top = (height - side) // 2
    return image.crop((left, top, left + side, top + side))


def image_for_preview(image: Image.Image, width: int, height: int, crop: bool = False) -> Image.Image:
    image = ImageOps.exif_transpose(image)
    if crop:
        image = center_crop_square(image)
    image = image.convert("RGBA")
    image.thumbnail((width, height), Image.Resampling.LANCZOS)
    preview = Image.new("RGBA", (width, height), (255, 255, 255, 0))
    x = (width - image.width) // 2
    y = (height - image.height) // 2
    preview.paste(image, (x, y), image)
    return preview


def image_to_pixmap(image: Image.Image) -> QPixmap:
    image = image.convert("RGBA")
    data = image.tobytes("raw", "RGBA")
    qimage = QImage(data, image.width, image.height, image.width * 4, QImage.Format.Format_RGBA8888)
    return QPixmap.fromImage(qimage.copy())


def qimage_to_pil(image: QImage) -> Image.Image:
    buffer = QBuffer()
    buffer.open(QIODevice.OpenModeFlag.WriteOnly)
    image.save(buffer, "PNG")
    data = bytes(buffer.data())
    buffer.close()
    return Image.open(io.BytesIO(data)).copy()


def unique_output_path(base_path: Path) -> Path:
    if not base_path.exists():
        return base_path
    counter = 2
    while True:
        candidate = base_path.with_name(f"{base_path.stem}_{counter}{base_path.suffix}")
        if not candidate.exists():
            return candidate
        counter += 1


def output_extension_and_format(requested_format: str, source_format: str, source_suffix: str) -> tuple[str, str]:
    if requested_format == "JPG":
        return ".jpg", "JPEG"
    if requested_format == "PNG":
        return ".png", "PNG"

    suffix = source_suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return ".jpg", "JPEG"
    if suffix in IMAGE_EXTENSIONS:
        return suffix, source_format or "PNG"
    return ".png", "PNG"


def prepare_for_save(image: Image.Image, save_format: str) -> Image.Image:
    image = center_crop_square(image)
    if save_format.upper() in {"JPEG", "JPG", "BMP"}:
        return image.convert("RGB")
    return image.convert("RGBA")


def crop_source_to_square(
    source: Path,
    output_dir: Path | None,
    suffix: str,
    requested_format: str,
) -> Path:
    with Image.open(source) as image:
        image = ImageOps.exif_transpose(image)
        save_extension, save_format = output_extension_and_format(requested_format, image.format or "", source.suffix)
        target_dir = output_dir or source.parent
        target_dir.mkdir(parents=True, exist_ok=True)
        output_path = unique_output_path(target_dir / f"{source.stem}{suffix}{save_extension}")
        prepare_for_save(image, save_format).save(output_path, save_format)
    return output_path


def save_clipboard_square(
    image: Image.Image,
    output_dir: Path,
    index: int,
    suffix: str,
    requested_format: str,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    save_extension, save_format = output_extension_and_format(requested_format, "PNG", ".png")
    output_path = unique_output_path(output_dir / f"clipboard_{index}{suffix}{save_extension}")
    image = ImageOps.exif_transpose(image)
    prepare_for_save(image, save_format).save(output_path, save_format)
    return output_path


class ConvertWorker(QObject):
    item_updated = Signal(int, str, int, int, int, int)
    finished = Signal(int, int, int, bool)

    def __init__(
        self,
        jobs: list[tuple[int, QueueItem]],
        output_dir: Path | None,
        suffix: str,
        requested_format: str,
        delete_sources: bool,
        cancel_event: threading.Event,
        clipboard_output_dir: Path,
    ) -> None:
        super().__init__()
        self.jobs = jobs
        self.output_dir = output_dir
        self.suffix = suffix
        self.requested_format = requested_format
        self.delete_sources = delete_sources
        self.cancel_event = cancel_event
        self.clipboard_output_dir = clipboard_output_dir

    def run(self) -> None:
        converted = 0
        failed = 0
        deleted = 0

        for index, item in self.jobs:
            if self.cancel_event.is_set():
                self.finished.emit(converted, failed, deleted, True)
                return

            try:
                if item.source is None:
                    if item.image is None:
                        raise ValueError("Missing clipboard image data.")
                    output_dir = self.output_dir or self.clipboard_output_dir
                    output_path = save_clipboard_square(item.image.copy(), output_dir, index, self.suffix, self.requested_format)
                else:
                    output_path = crop_source_to_square(item.source, self.output_dir, self.suffix, self.requested_format)
                    if self.delete_sources:
                        item.source.unlink()
                        deleted += 1
                status = f"Done -> {output_path.name}"
                converted += 1
            except Exception as exc:
                status = f"Failed: {exc}"
                failed += 1

            self.item_updated.emit(index - 1, status, converted, failed, deleted, len(self.jobs))

        self.finished.emit(converted, failed, deleted, False)


class AutoBatchCoverCropper(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.resize(820, 860)
        self.setMinimumSize(760, 800)
        self.setAcceptDrops(True)

        self.queue: list[QueueItem] = []
        self.sort_column = ""
        self.sort_reverse = False
        self.thread: QThread | None = None
        self.worker: ConvertWorker | None = None
        self.cancel_event = threading.Event()
        self.is_processing = False

        self._build_ui()
        self._apply_styles()
        self.status_label.setText("Add images, choose a folder, drag files, or paste copied images.")
        self.refresh_list()
        self.clear_previews()

    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QVBoxLayout(central)
        main_layout.setContentsMargins(32, 24, 32, 12)
        main_layout.setSpacing(12)

        title = QLabel(APP_NAME)
        title.setObjectName("titleLabel")
        main_layout.addWidget(title)

        self.preview_row = QWidget()
        preview_layout = QHBoxLayout(self.preview_row)
        preview_layout.setContentsMargins(0, 0, 0, 0)
        preview_layout.setSpacing(18)
        self.original_preview_label = self._build_preview_panel("Before")
        self.cropped_preview_label = self._build_preview_panel("After")
        preview_layout.addWidget(self.original_preview_label)
        preview_layout.addWidget(self.cropped_preview_label)
        preview_layout.addStretch()
        main_layout.addWidget(self.preview_row)

        top_row = QHBoxLayout()
        self.add_files_button = QPushButton("Add Files")
        self.add_files_button.clicked.connect(self.add_files)
        self.choose_folder_button = QPushButton("Choose Folder")
        self.choose_folder_button.clicked.connect(self.choose_folder)
        self.paste_button = QPushButton("Paste")
        self.paste_button.clicked.connect(self.paste_to_queue)
        top_row.addWidget(self.add_files_button)
        top_row.addWidget(self.choose_folder_button)
        top_row.addWidget(self.paste_button)
        top_row.addStretch()
        main_layout.addLayout(top_row)

        self.table = QTableWidget(0, len(COLUMN_KEYS))
        self.table.setHorizontalHeaderLabels(["Status", "Name", "Size", "File Size", "Format", "Path"])
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.table.verticalHeader().setVisible(False)
        self.table.horizontalHeader().setSectionsClickable(True)
        self.table.horizontalHeader().sectionClicked.connect(self.sort_by_section)
        self.table.itemSelectionChanged.connect(self.update_selected_preview)
        self.table.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        header = self.table.horizontalHeader()
        widths = (110, 165, 90, 100, 75)
        for index, width in enumerate(widths):
            header.setSectionResizeMode(index, QHeaderView.ResizeMode.Interactive)
            self.table.setColumnWidth(index, width)
        header.setSectionResizeMode(COLUMN_KEYS.index("path"), QHeaderView.ResizeMode.Stretch)
        main_layout.addWidget(self.table, stretch=1)

        output_row = QHBoxLayout()
        output_row.addWidget(QLabel("Output path"))
        self.output_dir_edit = QLineEdit()
        output_row.addWidget(self.output_dir_edit, stretch=1)
        browse_button = QPushButton("Browse")
        browse_button.clicked.connect(self.choose_output_folder)
        output_row.addWidget(browse_button)
        output_row.addWidget(QLabel("Suffix"))
        self.suffix_edit = QLineEdit("_square")
        self.suffix_edit.setMaximumWidth(120)
        output_row.addWidget(self.suffix_edit)
        output_row.addWidget(QLabel("Format"))
        self.output_format_combo = QComboBox()
        self.output_format_combo.addItems(FORMAT_OPTIONS)
        self.output_format_combo.setMaximumWidth(120)
        output_row.addWidget(self.output_format_combo)
        main_layout.addLayout(output_row)

        self.delete_sources_checkbox = QCheckBox("Delete source files after conversion")
        main_layout.addWidget(self.delete_sources_checkbox)

        actions = QHBoxLayout()
        self.start_button = QPushButton("Start")
        self.start_button.setObjectName("startButton")
        self.start_button.clicked.connect(self.start)
        self.cancel_button = QPushButton("Cancel")
        self.cancel_button.clicked.connect(self.cancel_processing)
        self.cancel_button.setEnabled(False)
        self.clear_button = QPushButton("Clear")
        self.clear_button.clicked.connect(self.clear)
        actions.addWidget(self.start_button)
        actions.addWidget(self.cancel_button)
        actions.addWidget(self.clear_button)
        actions.addStretch()
        main_layout.addLayout(actions)

        self.status_label = QLabel()
        self.status_label.setWordWrap(True)
        self.status_label.setObjectName("statusLabel")
        main_layout.addWidget(self.status_label)

        footer_controls = QHBoxLayout()
        self.about_button = QPushButton("ⓘ")
        self.about_button.setObjectName("aboutButton")
        self.about_button.setToolTip("About")
        self.about_button.clicked.connect(self.show_about)
        footer_controls.addStretch()
        footer_controls.addWidget(self.about_button)
        main_layout.addLayout(footer_controls)

    def _apply_styles(self) -> None:
        self.setStyleSheet(
            """
            QWidget {
                background: palette(window);
                color: palette(window-text);
                font-family: "Segoe UI Variable Text", "Segoe UI";
                font-size: 10pt;
            }
            QLabel#titleLabel {
                font-family: "Segoe UI Variable Display", "Segoe UI";
                font-size: 22pt;
                font-weight: 700;
            }
            QLabel#previewLabel {
                background: palette(base);
                border: 1px solid palette(mid);
            }
            QLabel#statusLabel {
                color: palette(window-text);
            }
            QTableWidget, QLineEdit, QComboBox {
                background: palette(base);
                color: palette(text);
                border: 1px solid palette(mid);
            }
            QPushButton {
                padding: 8px 16px;
            }
            QPushButton#startButton {
                font-weight: 700;
            }
            QPushButton#aboutButton {
                min-width: 28px;
                max-width: 28px;
                min-height: 28px;
                max-height: 28px;
                padding: 0;
                border-radius: 14px;
                font-size: 13pt;
            }
            QCheckBox {
                spacing: 8px;
            }
            """
        )

    def _build_preview_panel(self, title: str) -> QFrame:
        panel = QFrame()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(4)
        title_label = QLabel(title)
        title_label.setObjectName("previewTitle")
        title_label.setStyleSheet("font-weight: 700;")
        preview = QLabel()
        preview.setObjectName("previewLabel")
        preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        preview.setFixedSize(PREVIEW_MAX_HEIGHT, PREVIEW_MAX_HEIGHT)
        setattr(panel, "preview", preview)
        layout.addWidget(title_label)
        layout.addWidget(preview)
        return panel

    def dragEnterEvent(self, event: QDragEnterEvent) -> None:
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            event.ignore()

    def dropEvent(self, event: QDropEvent) -> None:
        paths = [Path(url.toLocalFile()) for url in event.mimeData().urls() if url.isLocalFile()]
        if paths:
            self.handle_drop([str(path) for path in paths])
            event.acceptProposedAction()
        else:
            event.ignore()

    def update_selected_preview(self) -> None:
        selected_rows = self.table.selectionModel().selectedRows() if self.table.selectionModel() else []
        if not selected_rows:
            self.clear_previews()
            return

        index = selected_rows[0].row()
        if index >= len(self.queue):
            self.clear_previews()
            return

        item = self.queue[index]
        try:
            if item.source is None:
                if item.image is None:
                    raise ValueError("Missing clipboard image data.")
                source_image = item.image.copy()
            else:
                with Image.open(item.source) as image:
                    source_image = image.copy()

            before_width, before_height, after_size = self.preview_dimensions(source_image.width, source_image.height)
            before = image_for_preview(source_image, before_width, before_height, crop=False)
            after = image_for_preview(source_image, after_size, after_size, crop=True)
            self._set_preview(self.original_preview_label.preview, before)
            self._set_preview(self.cropped_preview_label.preview, after)
        except Exception as exc:
            self.clear_previews()
            self.status_label.setText(f"Could not preview selected image: {exc}")

    def _set_preview(self, label: QLabel, image: Image.Image) -> None:
        label.setFixedSize(image.width, image.height)
        label.setPixmap(image_to_pixmap(image))
        label.setText("")

    def preview_dimensions(self, image_width: int, image_height: int) -> tuple[int, int, int]:
        available_width = max(self.preview_row.width() - 18, 420)
        after_size = PREVIEW_MAX_HEIGHT
        before_max_width = max(PREVIEW_MIN_WIDTH, available_width - after_size - 36)
        scale = min(before_max_width / image_width, PREVIEW_MAX_HEIGHT / image_height)
        before_width = max(PREVIEW_MIN_WIDTH, int(image_width * scale))
        before_height = max(120, int(image_height * scale))
        before_width = min(before_width, before_max_width)
        before_height = min(before_height, PREVIEW_MAX_HEIGHT)
        return before_width, before_height, after_size

    def clear_previews(self) -> None:
        for panel in (self.original_preview_label, self.cropped_preview_label):
            label = panel.preview
            label.clear()
            label.setFixedSize(PREVIEW_MAX_HEIGHT, PREVIEW_MAX_HEIGHT)
            label.setText("No selection")

    def add_files(self) -> None:
        if self.is_processing:
            self.status_label.setText("Wait for conversion to finish before adding files.")
            return
        file_paths, _ = QFileDialog.getOpenFileNames(self, "Choose images", "", SUPPORTED_TYPES)
        self.add_paths([Path(path) for path in file_paths])

    def choose_folder(self) -> None:
        if self.is_processing:
            self.status_label.setText("Wait for conversion to finish before adding folders.")
            return
        folder = QFileDialog.getExistingDirectory(self, "Choose folder with images")
        if folder:
            self.add_paths([Path(folder)])

    def choose_output_folder(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "Choose output folder")
        if folder:
            self.output_dir_edit.setText(folder)

    def handle_drop(self, paths: list[str]) -> None:
        if self.is_processing:
            self.status_label.setText("Wait for conversion to finish before dragging more files.")
            return
        added = self.add_paths([Path(path) for path in paths])
        self.status_label.setText(f"Added {added} dragged image(s) to the queue.")

    def paste_to_queue(self) -> None:
        if self.is_processing:
            self.status_label.setText("Wait for conversion to finish before pasting more files.")
            return
        items = self.clipboard_items()
        if not items:
            self.status_label.setText("Clipboard has no image, copied image file, or folder.")
            return

        image_count = 0
        paths = []
        for item in items:
            if isinstance(item, Image.Image):
                self.add_clipboard_image(item)
                image_count += 1
            else:
                paths.append(item)
        path_count = self.add_paths(paths) if paths else 0
        self.status_label.setText(f"Added {image_count + path_count} item(s) to the queue.")

    def clipboard_items(self) -> list[Path | Image.Image]:
        clipboard = QApplication.clipboard()
        mime = clipboard.mimeData()
        if mime.hasImage():
            image = clipboard.image()
            if not image.isNull():
                return [qimage_to_pil(image)]
        if mime.hasUrls():
            return [Path(url.toLocalFile()) for url in mime.urls() if url.isLocalFile()]
        text = clipboard.text()
        items = []
        for line in text.splitlines():
            path = Path(line.strip().strip('"'))
            if is_image_path(path) or path.is_dir():
                items.append(path)
        return items

    def add_paths(self, paths: list[Path]) -> int:
        image_paths = collect_image_paths(paths)
        existing = {item.source.resolve() for item in self.queue if item.source is not None}
        added = 0
        first_added_index = len(self.queue)
        for path in image_paths:
            resolved = path.resolve()
            if resolved in existing:
                continue
            try:
                with Image.open(path) as image:
                    width, height = image.size
                    image_format = image.format or path.suffix.lstrip(".").upper()
            except Exception:
                width, height = 0, 0
                image_format = path.suffix.lstrip(".").upper()
            try:
                file_size = path.stat().st_size
            except OSError:
                file_size = None
            self.queue.append(
                QueueItem(
                    source=path,
                    image=None,
                    name=path.name,
                    width=width,
                    height=height,
                    image_format=image_format,
                    file_size=file_size,
                )
            )
            existing.add(resolved)
            added += 1
        self.refresh_list(first_added_index if added else None)
        if added:
            self.status_label.setText(f"Added {added} image(s) to the queue.")
        elif paths:
            self.status_label.setText("No new images found.")
        return added

    def add_clipboard_image(self, image: Image.Image) -> None:
        index = sum(1 for item in self.queue if item.source is None) + 1
        selected_index = len(self.queue)
        self.queue.append(
            QueueItem(
                source=None,
                image=image.copy(),
                name=f"Clipboard image {index}",
                width=image.width,
                height=image.height,
                image_format="Clipboard",
                file_size=None,
            )
        )
        self.refresh_list(selected_index)

    def refresh_list(self, selected_index: int | None = None) -> None:
        if selected_index is None:
            selected_rows = self.table.selectionModel().selectedRows() if self.table.selectionModel() else []
            selected_index = selected_rows[0].row() if selected_rows else None

        self.table.blockSignals(True)
        self.table.setRowCount(0)
        for index, item in enumerate(self.queue):
            values = (
                item.status,
                item.name,
                self.format_dimensions(item),
                self.format_file_size(item),
                item.image_format,
                "" if item.source is None else str(item.source),
            )
            self.table.insertRow(index)
            for column, value in enumerate(values):
                table_item = QTableWidgetItem(value)
                table_item.setFlags(table_item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                if value:
                    table_item.setToolTip(value)
                self.table.setItem(index, column, table_item)
        self.table.blockSignals(False)

        if not self.queue:
            self.clear_previews()
            return
        if selected_index is None or selected_index >= len(self.queue):
            selected_index = 0
        self.table.selectRow(selected_index)
        self.update_selected_preview()

    def format_dimensions(self, item: QueueItem) -> str:
        if item.width <= 0 or item.height <= 0:
            return "Unknown"
        return f"{item.width}x{item.height}"

    def format_file_size(self, item: QueueItem) -> str:
        if item.file_size is None:
            return "Clipboard"
        size = float(item.file_size)
        for unit in ("B", "KB", "MB", "GB"):
            if size < 1024 or unit == "GB":
                if unit == "B":
                    return f"{int(size)} {unit}"
                return f"{size:.1f} {unit}"
            size /= 1024
        return f"{size:.1f} GB"

    def sort_by_section(self, section: int) -> None:
        self.sort_by_column(COLUMN_KEYS[section])

    def sort_by_column(self, column: str) -> None:
        if self.sort_column == column:
            self.sort_reverse = not self.sort_reverse
        else:
            self.sort_column = column
            self.sort_reverse = False

        def sort_key(item: QueueItem):
            if column == "status":
                return item.status.lower()
            if column == "name":
                return item.name.lower()
            if column == "size":
                return (item.width * item.height, item.width, item.height)
            if column == "file_size":
                return -1 if item.file_size is None else item.file_size
            if column == "format":
                return item.image_format.lower()
            if column == "path":
                return "" if item.source is None else str(item.source).lower()
            return item.name.lower()

        self.queue.sort(key=sort_key, reverse=self.sort_reverse)
        self.refresh_list(0)

    def start(self) -> None:
        if self.is_processing:
            self.status_label.setText("Conversion is already running.")
            return
        if not self.queue:
            self.status_label.setText("Queue is empty.")
            return
        if self.delete_sources_checkbox.isChecked():
            confirmed = QMessageBox.question(
                self,
                APP_NAME,
                "Delete source files after successful conversion?\n\n"
                "Only source files with a newly written PNG will be deleted. Clipboard images are not deleted.",
            )
            if confirmed != QMessageBox.StandardButton.Yes:
                return

        output_dir = self.selected_output_dir()
        suffix = self.suffix_edit.text()
        requested_format = self.output_format_combo.currentText()
        delete_sources = self.delete_sources_checkbox.isChecked()
        jobs = list(enumerate(self.queue, start=1))

        self.cancel_event.clear()
        self.is_processing = True
        self.set_processing_controls(True)
        self.status_label.setText(f"Converting 0/{len(jobs)} image(s)...")

        self.thread = QThread()
        self.worker = ConvertWorker(
            jobs,
            output_dir,
            suffix,
            requested_format,
            delete_sources,
            self.cancel_event,
            Path(__file__).resolve().parent / "square_crop_output",
        )
        self.worker.moveToThread(self.thread)
        self.thread.started.connect(self.worker.run)
        self.worker.item_updated.connect(self.update_item_status)
        self.worker.finished.connect(self.finish_processing)
        self.worker.finished.connect(self.thread.quit)
        self.worker.finished.connect(self.worker.deleteLater)
        self.thread.finished.connect(self.cleanup_thread)
        self.thread.finished.connect(self.thread.deleteLater)
        self.thread.start()

    def update_item_status(
        self,
        selected_index: int,
        status: str,
        converted: int,
        failed: int,
        deleted: int,
        total: int,
    ) -> None:
        if 0 <= selected_index < len(self.queue):
            self.queue[selected_index].status = status
        self.refresh_list(selected_index)
        message = f"Converting {converted + failed}/{total} image(s). Converted: {converted}."
        if failed:
            message += f" Failed: {failed}."
        if deleted:
            message += f" Deleted: {deleted}."
        self.status_label.setText(message)

    def finish_processing(self, converted: int, failed: int, deleted: int, cancelled: bool) -> None:
        self.is_processing = False
        self.set_processing_controls(False)

        message = f"Converted {converted} image(s)."
        if failed:
            message += f" Failed: {failed}."
        if deleted:
            message += f" Deleted source files: {deleted}."
        if cancelled:
            message = f"Cancelled. {message}"
        self.status_label.setText(message)

    def cleanup_thread(self) -> None:
        self.thread = None
        self.worker = None

    def cancel_processing(self) -> None:
        if not self.is_processing:
            return
        self.cancel_event.set()
        self.status_label.setText("Cancelling after the current image finishes...")

    def set_processing_controls(self, processing: bool) -> None:
        enabled = not processing
        self.start_button.setEnabled(enabled)
        self.clear_button.setEnabled(enabled)
        self.add_files_button.setEnabled(enabled)
        self.choose_folder_button.setEnabled(enabled)
        self.paste_button.setEnabled(enabled)
        self.cancel_button.setEnabled(processing)

    def selected_output_dir(self) -> Path | None:
        text = self.output_dir_edit.text().strip().strip('"')
        if not text:
            return None
        return Path(text)

    def clear(self) -> None:
        if self.is_processing:
            self.status_label.setText("Cancel or wait for conversion to finish before clearing.")
            return
        self.queue.clear()
        self.refresh_list()
        self.status_label.setText("Queue cleared.")

    def show_about(self) -> None:
        dialog = QDialog(self)
        dialog.setWindowTitle(APP_NAME)
        dialog.setModal(True)
        dialog.setMinimumWidth(360)

        layout = QVBoxLayout(dialog)
        layout.setContentsMargins(22, 18, 22, 18)
        layout.setSpacing(16)

        text = QLabel(ABOUT_TEXT)
        text.setAlignment(Qt.AlignmentFlag.AlignCenter)
        text.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)

        ok_button = QPushButton("OK")
        ok_button.clicked.connect(dialog.accept)

        button_row = QHBoxLayout()
        button_row.addStretch()
        button_row.addWidget(ok_button)
        button_row.addStretch()

        layout.addWidget(text)
        layout.addLayout(button_row)

        dialog.exec()

    def run(self) -> None:
        self.show()
        QApplication.instance().exec()


def run_self_test() -> Path:
    output_dir = Path(__file__).resolve().parent / "smoke_test_output"
    output_dir.mkdir(exist_ok=True)
    image_path = output_dir / "sample_3000x4000.png"
    image = Image.new("RGB", (3000, 4000), "#2f80ed")
    draw = ImageDraw.Draw(image)
    draw.rectangle((750, 1000, 2250, 3000), outline="white", width=24)
    image.save(image_path, "PNG")

    output_path = crop_source_to_square(image_path, output_dir, "_square", "PNG")
    with Image.open(output_path) as output:
        if output.size != (3000, 3000):
            raise AssertionError(f"Expected 3000x3000, got {output.size}")
    return output_path


def check_dnd() -> None:
    print(f"Python: {sys.executable}")
    print("Qt drag-drop: built in")


def main() -> None:
    enable_high_dpi_support()
    parser = argparse.ArgumentParser(description=APP_NAME)
    parser.add_argument("--self-test", action="store_true", help="generate a sample and crop it")
    parser.add_argument("--check-dnd", action="store_true", help="check drag-drop availability")
    args = parser.parse_args()
    if args.self_test:
        print(f"Smoke test OK: {run_self_test()}")
        return
    if args.check_dnd:
        check_dnd()
        return
    app = QApplication(sys.argv)
    window = AutoBatchCoverCropper()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()

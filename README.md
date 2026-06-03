# Auto Batch Cover Cropper

Auto Batch Cover Cropper centre-crops many images into square images, helpful when adding custom album covers to music files.

## Features

- Add images with `Add Files`.
- Add all images from a folder with `Choose Folder`. Folder imports scan recursively.
- Drag image files or folders into the window.
- Paste copied image files, folders, or clipboard images.
- Review all queued items in a table with status, name, image size, file size, format, and path columns.
- Click any table column header to sort the queue by that column.
- Drag column dividers to resize columns. Use the horizontal scrollbar for long paths.
- Preview the selected item before and after centre-cropping. The preview area adjusts to the selected image shape.
- Set a custom output folder and filename suffix.
- Choose the output format: PNG, JPG, or Original.
- Click `Start` to centre-crop every queued image.
- Conversion runs in a background thread so the window stays responsive.
- Click `Cancel` to stop after the current image finishes.
- Click `Clear` to empty the queue.
- Enable `Delete source files after conversion` to delete only source files that were successfully converted.

## Output

- By default, file outputs are saved next to the source image as `name_square.png`.
- If an output folder is entered, file outputs are saved there instead.
- If that name already exists, a numbered suffix is added.
- Clipboard image outputs are saved inside `square_crop_output`, unless an output folder is entered.

## Repository Layout

```text
auto-batch-cover-cropper/
  .gitignore
  LICENSE
  README.md
  auto_batch_cover_cropper.py
  requirements.txt
```

`auto_batch_cover_cropper.py` is the application entry point.

## Dependencies

- Python 3.10 or newer
- Pillow
- PySide6

`Pillow` is required for image loading, preview, cropping, and export.
`PySide6` provides the Qt desktop controls and built-in drag-and-drop support.

## Run

Install dependencies into the same Python environment used to run the app:

```powershell
python -m pip install -r requirements.txt
```

Run:

```powershell
python auto_batch_cover_cropper.py
```

Check drag-drop:

```powershell
python auto_batch_cover_cropper.py --check-dnd
```

Drag-and-drop is provided by Qt, so no extra drag-drop package is required.

## Checks

```powershell
python auto_batch_cover_cropper.py --self-test
```

Smoke-test output is written to `smoke_test_output/`, which is ignored by Git.

## Git Ignore

The `.gitignore` excludes Python caches, virtual environments, package build
outputs, coverage artefacts, editor folders, OS metadata, logs, and generated
tool output such as `smoke_test_output/` and `square_crop_output/`.

## Licence

This project is licensed under the GNU General Public License v3.0.

Copyright (C) 2026 strailico5327.

## Notes

This project was developed with assistance from OpenAI Codex. The code has been reviewed and tested before release.

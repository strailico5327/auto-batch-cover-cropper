# Auto Batch Cover Cropper

Auto Batch Cover Cropper center-crops batches of images into square cover art.

This repository contains a static HTML5 browser version with no build step.

## Web Version

Open `index.html` in a browser, or serve the folder with any static HTTP server.

The Web version supports:

- Add image files.
- Add a folder with the browser folder picker.
- Drag image files or folders onto the page.
- Preview the selected image before and after center-cropping.
- Sort the queue table by status, name, dimensions, file size, format, or path.
- Choose PNG, JPG, or Original output.
- Choose a filename suffix.
- Download one converted image as a single file, or multiple converted images as `square_crop_output.zip`.
- Save directly to a chosen folder in browsers that support the File System Access API.

Browser security limits differ from the desktop app: the Web version cannot delete source
files, and it cannot silently write next to source files. ZIP download is the portable
default output path.

## License

This project is licensed under the GNU General Public License v3.0.

Copyright (C) 2026 strailico5327.

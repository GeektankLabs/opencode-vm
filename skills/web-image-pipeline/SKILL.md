---
name: web-image-pipeline
description: Optimize images for web delivery — resize, convert to modern formats (AVIF/WebP), compress losslessly or lossy, clean up SVGs, generate responsive variants, strip metadata, and vectorize simple bitmap logos. Use when the task involves image conversion, resizing, cropping, compressing, optimizing web assets, generating responsive image sets, reducing page-load times, or auditing image file sizes.
---

# Web Image Pipeline

Use this skill for production web image optimization and graphics conversion.

## Goals

- Reduce transfer size and improve page-load performance.
- Preserve source artwork — write outputs to a generated folder, never overwrite originals.
- Prefer deterministic CLI tools over manual editing.
- Generate modern web variants where useful: AVIF, WebP, JPEG/PNG fallback.
- Keep SVGs responsive and safe for web use.

## Prerequisites

Verify all tools are available before starting:

```bash
for c in file identify vips cwebp avifenc pngquant optipng jpegoptim gifsicle potrace rsvg-convert svgo exiftool; do
  command -v "$c" >/dev/null && echo "ok: $c" || echo "missing: $c"
done
command -v magick >/dev/null && echo "ok: magick (ImageMagick v7)" || echo "info: magick not found, using identify/convert (ImageMagick v6)"
```

If tools are missing, the base VM may need to be rebuilt (`opencode-vm init` on the host).

## First Steps

1. Inventory the target path before changing any files.
2. Identify file types, dimensions, byte sizes, and suspiciously large assets.
3. Decide per asset class: photo, screenshot/UI, icon/logo, SVG, animated GIF.
4. Write outputs to a generated folder, for example:
   - `public/images/generated/`
   - `assets/generated/`
   - `dist/images/`
5. Never overwrite source files unless explicitly requested.

Useful inventory commands:

```bash
find <path> -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' -o -iname '*.avif' -o -iname '*.gif' -o -iname '*.svg' \) -print0 \
  | xargs -0 file

find <path> -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' -o -iname '*.avif' -o -iname '*.gif' \) -print0 \
  | xargs -0 identify -format '%b %wx%h %m %i\n'
```

If `magick` exists, prefer `magick identify`; otherwise use `identify`.

## Tool Choice

### Large Raster Images

Prefer `vips` for large batch resizing/conversion — it is fast and memory-efficient.

```bash
vips thumbnail input.jpg output-1280.webp[Q=78,strip] 1280
vips thumbnail input.jpg output-1280.jpg[Q=82,strip,interlace] 1280
```

Use ImageMagick for operations where it is clearer or more flexible: trim, crop, gravity, unusual formats, or quick one-offs.

```bash
magick input.png -strip -resize 1280x1280\> output.png
magick input.jpg -strip -resize 1600x -gravity center -crop 1600x900+0+0 +repage output.jpg
```

If `magick` is unavailable, use `convert`.

### Photos / Hero Images

Typical production variants:

* AVIF: best compression, use for modern browsers.
* WebP: broadly supported web variant.
* JPEG fallback: keep only if the project still needs legacy support.
* Widths: usually 320, 640, 960, 1280, 1600, 1920; add 2560 only for large hero imagery.

```bash
cwebp -q 78 -m 6 input.jpg -o output.webp
avifenc --min 24 --max 34 --speed 6 input.jpg output.avif
jpegoptim --strip-all --all-progressive -m82 -d output-dir input.jpg
```

### PNG Screenshots / UI Images

For non-critical UI screenshots, try lossy PNG compression first, then lossless optimization:

```bash
pngquant --quality 65-85 --strip --force --output output.png input.png
optipng -o4 output.png
```

For pixel-perfect UI where lossy quantization is not acceptable, skip `pngquant` and use only `optipng`.

### SVG Files

Use SVGO, but preserve `viewBox` so SVGs remain responsive.

```bash
svgo --multipass input.svg -o output.svg
```

Avoid aggressive cleanup on SVGs that are styled or scripted by CSS/JS — IDs, classes, and embedded metadata might be meaningful.

Recommended `svgo.config.mjs` for projects:

```js
export default {
  multipass: true,
  plugins: [
    {
      name: "preset-default",
      params: {
        overrides: {
          removeViewBox: false
        }
      }
    },
    "removeDimensions"
  ]
}
```

Then: `svgo --config svgo.config.mjs --multipass input.svg -o output.svg`

### Bitmap to SVG

Use Potrace **only** for simple flat logos, icons, signatures, black-and-white marks, or high-contrast artwork. Do **not** vectorize photos or detailed raster art.

```bash
magick input.png -alpha off -colorspace Gray -threshold 55% tmp.pbm
potrace -s tmp.pbm -o output.svg
svgo --multipass output.svg -o output.svg
rm tmp.pbm
```

If `magick` is unavailable, use `convert`.

### Animated GIFs

For GIFs that must remain GIF:

```bash
gifsicle -O3 input.gif -o output.gif
```

For web production, consider replacing GIF with video or animated WebP/AVIF only if the project supports it.

### Metadata

Inspect metadata before stripping:

```bash
exiftool input.jpg
```

Strip all metadata for web delivery:

```bash
exiftool -all= -overwrite_original output.jpg
```

Do not strip color profiles if the user says the asset is color-critical.

## Quality Defaults

Use these as starting points:

* JPEG: quality 80-85, progressive, strip metadata.
* WebP photo: quality 75-82.
* AVIF photo: quantizer min/max around 24-34 or equivalent quality setting.
* PNG: lossless for UI-critical images; pngquant 65-85 for screenshots where visual comparison is acceptable.
* SVG: SVGO multipass, preserve viewBox.

## Required Output

After optimization, report:

* Files processed.
* Original total size.
* New total size.
* Percentage saved.
* Generated formats and widths.
* Any skipped files and why.
* Any visual-risk decisions (lossy PNG quantization, Potrace vectorization).

Use `du -b` or `wc -c` for byte counts. Present as a summary table.

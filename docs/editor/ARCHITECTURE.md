# Video Editor architecture

The Video Editor is a general-purpose nonlinear editor inside Vidra Studio. It
does not depend on video generation, any provider, or any network service.

## Phase 0 audit (what the editor builds on)

| Existing piece | How the editor uses it |
| --- | --- |
| Tauri 2 shell, React + TypeScript renderer, Rust core | Same app and executable; one new route (`/editor`) and nav item. |
| Asset protocol (`asset://`), scoped per folder | Each imported file is added to the scope individually (`allow_file`), never whole drives. Thumbnails come from the app's own cache folder. |
| "Renderer never sends paths" rule (dialogs and drop tokens) | Kept: media arrives through the native file dialog, drag-and-drop tokens or the archive. The renderer refers to media by id; saved projects take paths from the native registry. |
| `e2e-mock` dialog overrides | Extended with a multi-file open override (`next-open.txt`) for the native acceptance test. |
| Store events | One new event, `editor-export`, carries render progress. |
| Settings key-value table | `editor:config` (FFmpeg folder) and `editor:recent` (recent projects). No schema migration. |
| Archive | "Open in Video Editor" on saved videos imports the archived file (read-only). |
| Media tooling | **None shipped.** The editor uses FFmpeg/FFprobe from: a folder chosen in the editor, then next to `vidra-studio.exe`, then `PATH`. |

## Layers

```
packages/core/src/editor.ts      project schema (zod, versioned), pure timeline operations,
                                 undo history, render plan, placement math
apps/desktop/src/screens/editor  workspace UI: media panel, preview, inspector, timeline,
                                 export dialog, start screen (new / open / recent / recovery)
src-tauri/src/editor.rs          FFmpeg discovery, probing, import, thumbnail and waveform
                                 cache, project save/open, autosave/recovery, recents
src-tauri/src/editor_render.rs   render plan → FFmpeg arguments, export queue, progress,
                                 cancel, output validation
```

### One render plan for preview and export

`renderPlan(project)` flattens tracks and clips into what is drawn (video and
image layers with timing, fit, opacity, scale and offset) and what is heard
(gain, fades, speed). The preview plays that plan with HTML media elements; the
export turns the same plan into an FFmpeg filter graph. `placement()` is
implemented identically in TypeScript and Rust (unit-tested on both sides).

### Projects

- Format `vidra.editor` version 1, JSON, extension `.vidraproj`, default folder
  `Documents\Vidra Studio Projects`.
- Clips reference media by id with in/out points; source files are never written.
- Saves are atomic (`.part` then rename). Autosave writes a recovery copy to the
  app data folder every 15 s while there are unsaved changes, never over the
  project file. A recovery copy newer than its project file is offered on the
  start screen.
- Missing media is flagged on open (`available: false`) and can be relinked.

### Export

- Inputs are passed as separate `-i` arguments (no shell); the filter graph
  contains only numbers and fixed filter names. Graphs over 8 kB go through
  `-/filter_complex <file>`.
- H.264 (`libx264` when present, otherwise NVENC / QSV / AMF / Media
  Foundation), AAC 48 kHz, `+faststart`.
- One export runs at a time (queue). Progress comes from `-progress pipe:1`.
  Cancel kills the FFmpeg process and removes the partial file.
- The output is rendered to a hidden temporary file, validated with FFprobe
  (H.264 + AAC, the planned frame size, the planned duration) and only then
  moved to the chosen path.

## FFmpeg distribution and licensing

Vidra Studio is MIT-licensed and **does not bundle FFmpeg** in this release.

- FFmpeg itself is LGPL-2.1+, but builds that enable `libx264` (and other GPL
  components) are GPL. The common Windows builds (for example gyan.dev "full"
  or BtbN GPL) are GPL builds.
- Shipping a GPL FFmpeg executable next to an MIT app is generally treated as
  "mere aggregation" (separate programs), but it still requires distributing
  the corresponding FFmpeg source and license texts with every release.
- An LGPL build without `libx264` can still encode H.264 on Windows through
  `h264_mf` (Media Foundation), which the editor supports automatically, so an
  LGPL-only bundle is a viable future option.

Decision needed before bundling: LGPL build with Media Foundation H.264 (no
GPL obligations beyond LGPL source offer) versus a GPL build with libx264
(better quality per bit, GPL source distribution). Until then users install
FFmpeg themselves, and the editor explains how.

## Phase 1 scope (this release)

Import (MP4, MOV, M4V, WebM, MKV, AVI; MP3, WAV, AAC, M4A, FLAC, OGG, Opus;
PNG, JPEG, WebP), multitrack timeline (video tracks layered top-down, audio
tracks), drag to move between tracks, trim, split, ripple delete, duplicate,
copy/paste, multi-select, snapping, zoom, frame stepping, undo/redo, per-clip
volume / mute / fades / speed / opacity / fit (fit, fill, blurred background) /
size / position, track mute / hide / lock, project formats (16:9, 9:16, 1:1,
4:5, custom) without losing edits, safe-area guides, preview, 720p–4K H.264
export with progress and cancel, save / save as / open / recent / autosave /
recovery / relink.

Later phases (not in this release): text and subtitles, transitions and
effects, keyframes, color, advanced audio (ducking, normalization, EQ,
recording), screen and browser recording, Auto Edit.

## Phase 2 — Milestone A (motion, keyframes, transitions)

- **Project format 2.** Clips gain `rotation`, `crop`, `keyframes`, `transIn` and `transOut`; projects gain `markers`. Format 1 files validate with defaults for every new field and are written back as format 2. The native side (`check_doc`) accepts both.
- **Keyframes live at source time** (`s`), so trimming or splitting a clip never moves an animation off its frame. `clipAnim()` converts them to timeline time for the plan.
- **Easing** is a cubic curve (`ease()` in `packages/core`). The same formulas are emitted as FFmpeg expressions in `editor_render.rs` (`ease_expr`/`anim_expr`), so preview and export match.
- **Motion presets** are only a way of writing keyframes (`applyMotion`). The focal point stays fixed while scaling. Keyframes outside the interval are kept, which makes chained zooms possible.
- **Transitions** are stored on clip edges. A transition between two adjacent clips belongs to the later clip's `transIn`; `transOut` is only used at a clip end with no clip following.
  - `renderPlan()` turns them into overlaps: items are extended, and `holdStart`/`holdEnd` clone frames when the source has no spare footage.
  - It also adds alpha fades, wipe masks, blur copies, slide offsets and zoom factors, and inserts colour items for dips.
- **Export graph.** Static items keep the Phase 1 filters byte for byte. Animated items use `scale=…:eval=frame` and `overlay=…:eval=frame` with expressions of `t`. Rotation pre-scales to the largest size, then applies `rotate`. Opacity animation and wipes use `geq` on alpha, linear fades use `fade=…:alpha=1`, and blur uses `boxblur`.
- **Verification** happens in exported frames, not only in the UI. A real-FFmpeg Rust test measures a zoom and a dip. Native tests A/T/B/G check cutting (a 15 s result, with frames matched to the source), a dip to black, zoom in/out box widths, and opening plus exporting a format-1 project.

## Phase 2 — Milestone B (Smart Reframe, overlays, export)

### Subject tracking: options and licensing

| Option | Licence | Verdict |
|---|---|---|
| OpenCV (cascade / DNN) | Apache-2.0 | Fine to use, but it needs the native OpenCV library installed or bundled (~tens of MB) and a C++ toolchain; too heavy for an optional feature. |
| ONNX Runtime + a person detector (YOLO etc.) | MIT (runtime); model licences vary (YOLOv8 = AGPL-3.0) | Runtime is fine; most accurate detectors have viral licences or need a model download. Kept as a future opt-in. |
| MediaPipe | Apache-2.0 | No supported Rust binding; the C++/Python runtimes do not fit a Tauri app. |
| **SeetaFace via `rustface`** | **BSD-2-Clause** (code and model) | **Chosen.** Pure Rust, 1.2 MB model vendored in `src-tauri/models/` with its licence, no network, no system install. Frontal faces only. |

The analyzer (`editor_reframe.rs`) decodes the clip's source range with FFmpeg at 5 fps and 480 px wide (grey), detects faces per frame, associates detections into tracks by nearest centre, and ranks tracks by coverage × size. When no face track covers ≥ 30 % of the frames, a motion-energy fallback (2×2-block frame difference centroid) is tried; when that fails too the result is `method: "none"` and the UI offers the manual focus point or the blurred background. The result never claims success it did not get: `reframe.status` is `ok` (≥ 80 % coverage), `weak` or `failed`, and the inspector shows the method used.

`packages/core/src/reframe.ts` turns a track into keyframes: resample at 10 Hz, Gaussian smoothing (σ = 0.5 s), a small dead zone in *frame* units (2 %), the fill placement's clamp so the picture always covers the frame, and Ramer–Douglas–Peucker simplification with linear easing. The output is ordinary X/Y keyframes, so it is editable like any animation.

### Overlays and screen replacement

- **Corner pin** stores four corners (frame fractions) and optional corner keyframes on the clip. Export: the overlay is scaled to the frame and warped with FFmpeg's `perspective` (`sense=destination`, `eval=frame` with the frame number for keyframes); because the warp edge-extends outside the quad, a polygon mask of the same quad (geq) supplies the alpha through `alphamerge`. Preview: the same quad through a CSS `matrix3d` homography (`cornerPinCss`). A real-FFmpeg Rust test and a native test with a real screenshot verify the pixels land inside the quad and nowhere else.
- **Masks** (ellipse / rounded rectangle, feather) are applied in relative coordinates *before* scaling, so they survive zoom keyframes; the preview uses `clip-path` / `mask-image`.
- **Regions** (blur / cover) are applied after the clip is composited: blur = split → crop (per-frame x/y expressions) → boxblur → overlay; cover = colour source → overlay. Preview: `backdrop-filter: blur()` or a coloured box.
- **Motion blur** = `tmix=frames=3` enabled only while the clip's scale/position keyframes run (export only).

### Export and proxies

- `export-presets.ts` holds the platform targets; bitrate = pixel rate × 0.12 bit/px (high) / 0.07 (standard), clamped to 1.5–80 Mbps. `upscaleInfo` compares the export's short side with the sources' and the dialog says when a 4K export only enlarges 1080p material.
- `editor_proxy.rs` makes a 720p H.264 proxy in `editor-cache/proxies/` for sources above 1920 px; only the preview (`fileSrc(proxy)`) uses it. `editor_render::start` resolves media through the registry, which always points at the originals. The native test exports a 4K source with 2-px stripes and checks the stripes survive.

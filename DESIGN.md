---
name: pi-gemini-auth
description: A rotary slide tray turning around π, with the Gemini sign ♊ in the lit gate.
colors:
  tray-grey: "#8A8D91"
  rim-grey: "#5F6267"
  carbon: "#1C1C1E"
  slide-pale: "#D5D7DA"
  gate-amber: "#F2B705"
  lamp-light: "#FFF1C9"
rounded:
  mount: "0px"
  gate-window: "0px"
  gate-frame: "26px"
  small-gate-window: "30px"
  small-gate-frame: "50px"
components:
  tray-disc:
    backgroundColor: "{colors.tray-grey}"
    size: "900px"
  slide-mount:
    backgroundColor: "{colors.carbon}"
    rounded: "{rounded.mount}"
    size: "148px"
  slide-mount-window:
    backgroundColor: "{colors.slide-pale}"
    width: "108px"
    height: "72px"
  gate-slide:
    backgroundColor: "{colors.gate-amber}"
    rounded: "{rounded.gate-frame}"
    size: "252px"
  gate-window:
    backgroundColor: "{colors.lamp-light}"
    rounded: "{rounded.gate-window}"
    size: "180px"
  small-gate-slide:
    backgroundColor: "{colors.gate-amber}"
    rounded: "{rounded.small-gate-frame}"
    width: "384px"
    height: "508px"
  small-gate-window:
    backgroundColor: "{colors.lamp-light}"
    rounded: "{rounded.small-gate-window}"
    width: "296px"
    height: "400px"
  logo-readme:
    size: "128px"
---

# Design System: pi-gemini-auth

All geometry below is in the shipped SVGs' own units: a 1024 by 1024 artboard (`docs/logo.svg`, `docs/logo-small.svg`). Rasters are rendered from those files without resampling.

## Overview

**Creative North Star: "The Slide Tray"**

A 1960s rotary projector tray seen straight down, drawn as flat vector. The tray is the account pool. Seven grey slides wait in the ring, one sits in the amber gate at 12 o'clock, and π turns at the hub. The viewer reads "Gemini accounts rotating behind Pi" with no caption, because the two symbols are the generic mathematical π and the zodiac sign ♊.

The world is moulded plastic and lamp light. Five of the six fills are cool, near-neutral greys and carbon; the one warm note is the lit gate. Everything is a hard-edged filled path on a transparent ground. Depth comes only from value steps between rim, body, mount and window.

The mark carries no words. It sits beside the repo name on GitHub, as an avatar, and as a favicon, and has a separate small cut for sizes below 64px.

**Key Characteristics:**
- Six flat fills, no gradients, glow, shadow or opacity.
- Centred disc at 88% of the frame, with a darker moulded rim ring.
- Seven identical 35mm mounts on a 45-degree grid, turned tangent to the ring.
- One amber gate slide at 12 o'clock with a lamp-lit window holding ♊.
- A bold drawn π as the hub, about a third of the disc.
- A dedicated small cut below 64px; at 16px the gate window is plain light.

## Colors

A cool moulded-plastic grey family with a single amber lamp.

### Primary
- **Gate Amber** (`gate-amber`): the gate slide frame only. It marks the account in use and is the one saturated colour in the mark.

### Secondary
- **Lamp Light** (`lamp-light`): the gate window, read as projector light through the slide. Ground for the ♊ glyph.

### Neutral
- **Tray Grey** (`tray-grey`): the disc body, the field everything sits on.
- **Rim Grey** (`rim-grey`): the moulded rim ring at the disc edge (24 units in the main mark, 48 in the small cut).
- **Carbon** (`carbon`): mount frames and both glyphs, π and ♊. The only dark value.
- **Slide Pale** (`slide-pale`): the windows of the waiting mounts. Main mark only; the small cut drops it.

### Named Rules
**The Six Fills Rule.** The mark uses exactly these six fills and nothing between them. The small cut uses five, dropping Slide Pale with the mounts.

**The One Lit Slide Rule.** Gate Amber and Lamp Light appear only on the gate slide. No waiting mount is ever warm.

## Layout

The frame is square with a transparent ground. The disc is centred at (512, 512) with radius 450, so it fills 88% of the frame. The rim is a 24-unit ring inside that edge.

Eight slots sit on one ring of radius 320 at 45-degree steps, clockwise from 12 o'clock. The gate takes 0 degrees; the seven mounts take 45 through 315. Each mount is drawn once at 12 o'clock and rotated about the centre, so its window's long side stays tangent to the ring.

π is the hub, centred, about 312 units wide (35% of the disc). The composition is symmetric about the vertical axis apart from mount rotation.

**Small cut** (below 64px): disc radius 480 (94% of the frame) with a plain 48-unit rim. No mounts. The gate slide sits in the upper half and breaks above the rim. A larger π, about 44% of the disc, fills the lower half.

### Named Rules
**The Tangent Ring Rule.** Mounts are rotated copies of one shape about the disc centre. They never stand upright at diagonal positions.

**The Small Cut Rule.** Below 64px, use `docs/logo-small.svg` or its rasters, never a downscaled main mark. At 16px, remove the ♊ path and leave the window plain Lamp Light.

## Elevation & Depth

The system is flat. There are no shadows, gradients, filters, glows or opacity. Depth is read through stacking order and value alone: rim over body, mounts and gate over body, glyphs over windows.

### Named Rules
**The Flat Tray Rule.** Every element is a solid filled path with a hard edge. A new state or variant changes fill or geometry, never adds an effect.

## Shapes

Circles and rectangles only, plus the two glyphs.

- **Disc and rim:** true circles, the rim a constant-width annulus.
- **Mounts:** sharp square frames (148 units) with sharp landscape 3:2 windows (108 by 72).
- **Gate slide (main):** a square frame about 1.7 times a mount (252 units) with softly rounded corners (`gate-frame`), around a sharp square window (180 units). The rounded frame sets the gate apart from the sharp mounts.
- **Gate slide (small cut):** an upright portrait frame (384 by 508, `small-gate-frame`) around a portrait window (296 by 400, `small-gate-window`).
- **π:** one solid drawn shape with a thick top bar, two legs and a right-leg outward curl. Never assembled from blocks.
- **♊:** two vertical pillars with a deep arc above and below whose ends flare past them. In the main mark the pillars are 94 units tall with a 20-unit gap; in the small cut, 179 tall with a 48-unit gap.

## Components

### Main Mark
`docs/logo.svg`, rendered to `docs/logo.png` at 512px. Shown in README at `logo-readme` width. Use at 64px and above.

### Small Cut
`docs/logo-small.svg`, rendered to `docs/favicon-32.png`. `docs/favicon-16.png` is the same file with the ♊ path removed.

### Slide Mount
A carbon square frame with a pale landscape window. Seven identical copies, differing only in rotation.

### Gate Slide
The signature element. An amber frame around a lamp-lit window holding a tall carbon ♊. Always at 12 o'clock, always on the same ring as the mounts.

## Do's and Don'ts

### Do:
- **Do** keep to the six fills in the frontmatter, flat and opaque.
- **Do** keep π at the hub and ♊ in the gate, both as drawn filled paths in Carbon.
- **Do** draw ♊ as two tall pillars, taller than their gap by at least 1.5 times, with arcs flaring past them.
- **Do** switch to the small cut below 64px, and drop the ♊ at 16px.
- **Do** keep the disc centred on a transparent square ground.

### Don't:
- **Don't** use or imitate Pi's logo, the blocky three-colour π.
- **Don't** use Google's four-point Gemini sparkle or any four-point star.
- **Don't** add gradients, glow, shadow, filters or opacity.
- **Don't** put warm colour anywhere but the gate slide.
- **Don't** put words, the project name or initials inside the mark; π and ♊ are the only symbols.
- **Don't** swap in a padlock, key, refresh arrows, gradient orb or rounded-square monogram.

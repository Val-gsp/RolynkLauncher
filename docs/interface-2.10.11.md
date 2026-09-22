# Interface 2.10.11

The home logo keeps its original 1024×262 aspect ratio. The player body uses `background-size: auto 92%` to fit completely inside its portrait. Shop and Play share a 44px action height and top alignment, including the default 980×552 window.

Shop visibility now uses a reversible CSS opacity/transform transition and `inert` for inactive content. Escape closes the shop unless a dialog, legal panel or application overlay is active. The return target keeps keyboard focus on the original trigger. Checkout, consent and subscription handlers are unchanged.

Settings retain the exact template, options and persistence handlers from 2.10.10. The new scoped stylesheet changes navigation, cards, inputs and spacing. The existing checkbox inputs also remain keyboard-focusable.

## Pets

The three bundled sprite atlases are baked from the original `idle` tracks of `cubee-forest_keeper.bbmodel` (1.5s), `cubee-arctic_witch.bbmodel` (4.5s), and `cubee-meowgician.bbmodel` (6s). The renderer samples position, rotation and scale keyframes, linear/Catmull–Rom interpolation, and global bone rotation at 20fps. One camera frames the entire cycle. Animated portraits use these poses, rather than translating a static image.

Transformation conventions were checked against [Blockbench's bone animator](https://github.com/JannisX11/blockbench/blob/master/js/animations/timeline_animators.js). Rendering is done during development; the launcher only draws pre-rendered transparent frames to three small canvases. Atlases total about 1.7MiB compressed. Playback pauses offscreen, behind the shop, on document visibility loss, with reduced motion, or in Potato Mode. Static PNGs remain the fallback if an atlas fails to load.

To regenerate using the mod's original model directory, make `playwright` and `three` available through `NODE_PATH`, install Playwright Chromium, and run:

```
node tools/render-pets.cjs /path/to/bbmodels
```

## Validation

With Playwright Chromium available:

```
node tools/test-interface.cjs
node tools/test-subscription-ui.cjs
```

The interface test loads production EJS, CSS, the pet player, shop handlers, settings navigation and settings read/write functions. It exercises three viewport sizes, logo/portrait containment, exact action alignment, shop reversal/focus, all three animations and pause modes, all seven settings tabs and saving changed values while preserving Java options. It substitutes Electron/account/distribution services; it does not launch Minecraft or make purchases.

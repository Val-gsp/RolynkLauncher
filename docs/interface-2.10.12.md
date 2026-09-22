# Interface 2.10.12

## Pets

Each pet now plays three of its original tracks from `cubee-<pet>.bbmodel`: `idle` loops, `pet` answers the pointer, and `ultimate` plays on click, keyboard activation, or every third autoplayed move (one ultimate at a time, in turn: Forest Keeper, Arctic Witch, Meowgician). The pet names in the collection strip trigger the same actions.

`tools/render-pets.cjs` bakes one atlas per track (`<pet>-<track>.webp`) and one `<pet>.json` describing them. All tracks share the idle camera and pixel scale; `rect` gives each atlas's position in idle tiles, so the launcher draws every track into one canvas covering their union and the pet never jumps. The `hitbox` bone is dropped, and `allef` (the effect aura) only appears during `ultimate`, matching `CubeeModel` in the mod. The Blockbench editor visibility flag is ignored, as in the mod. VFX textures are drawn unlit. Ultimates reach up to 0.6 tile past the idle frame, bake at 15fps and lower density, and fade out at the clipped edges. They are decoded on demand and released after playing.

Regenerate from the mod's models with `playwright` and `three` on `NODE_PATH`:

```
node tools/render-pets.cjs ../RolynkRP/pets/src/main/resources/assets/rolynkpets/cubees
```

## Home ambience

The hero adds a drifting aurora, a pointer spotlight, rising sparks, pointer parallax on the pets, a sweeping orbit, floating pets with a colored aura and ground shadow, name tags, and an ultimate flash with a shockwave. The headline, "Nouveau" badge, call to action, shop teaser, and active instance also animate. Sections rise in on display.

Hero animations pause offscreen, behind the shop, and when the window is hidden.

2.10.13: the dashboard no longer honours the OS reduced-motion preference or Potato Mode. Windows reports reduced motion whenever its animation effects are turned off, a common performance tweak, and that froze the whole home for those players. Reduced motion still applies to the rest of the landing (bars, shop).

## Validation

`node tools/test-interface.cjs` also checks hover → `pet`, click → `ultimate`, the return to idle, and that pets and sparks keep moving under reduced motion and in Potato Mode.

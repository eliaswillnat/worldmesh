# The WorldMesh control convention

Traditional websites agree on links, scrolling and the back button. Spatial
sites need the same kind of agreement. This is it.

Every WorldMesh world ships these bindings by default. They live in
`packages/runtime/src/controls/keymap.ts` — one file, not copied into worlds.

## Desktop

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| `↑` `←` `↓` `→` | Move (identical) |
| Mouse | Look |
| `Space` | Jump (and ascend while flying) |
| `Shift` | Sprint |
| `E` | Interact / enter a portal |
| `V` | Toggle first ↔ third person |
| `1` … `9`, `0` | Change the default figure's face: smile, grin, laugh, wink, love, surprised, sad, angry, sleepy, neutral |
| `Esc` | Release the cursor |
| Scroll wheel | Third-person camera distance |

Optional, and only active when the world declares the matching ability:

| Input | Action | Ability |
| --- | --- | --- |
| `Space` in mid-air | Second jump | `doubleJump` |
| `C` | Crouch (descend while flying) | `crouching` |
| `F` | Toggle flight | `flying` |
| `Q` | Dash | `dash` |

## Rules a world should not break

1. **Never rebind the core row.** A visitor arriving from another world already
   knows these. `keymap` exists for adding bindings, not for moving `W`.
2. **`Esc` always releases the pointer.** The browser enforces this; do not try
   to work around it.
3. **`V` always toggles the camera**, in every world, even worlds that are
   designed for one mode. Arriving somewhere and not being able to see yourself
   is disorienting.
4. **`E` is the only interaction key.** If a world needs more verbs, they go
   through context, not through new keys.

## Clicking to enter

Pointer lock requires a user gesture, so every world opens with the same
click-to-enter panel showing the same control legend. That panel is part of the
runtime, so it looks and behaves the same everywhere.

## Touch

Phones and tablets get the same controls from the runtime, in portrait or
landscape:

| Input | Action |
| --- | --- |
| Left half of the screen | Move. A joystick rests in the bottom-left corner; grab it there, or touch anywhere on the left and it comes to your thumb |
| Drag on the right half | Look |
| ▲ button | Jump |
| E button | Interact |
| V button | Toggle first / third person |
| ⏸ button (top right) | Pause |

## VR

When the browser can start a WebXR `immersive-vr` session, every WorldMesh
world shows an **Enter VR** button (top centre while walking, and again on the
Esc / pause menu). That click is what requests the session.

In the headset:

| Input | Action |
| --- | --- |
| Left thumbstick | Move |
| Right thumbstick | Turn |
| Trigger or A / X | Jump (hold to ascend while flying) |
| Squeeze | Interact / enter a portal |

The headset looks around. WASD and the usual keys still work on PCVR. The
system button ends the session. Worlds opt out with `vr: false`.

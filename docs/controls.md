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
| `M` | Bird's-eye view, on and off (in worlds that offer it, such as the lobby) |
| `1` … `9`, `0` | Change the default figure's face: smile, grin, laugh, wink, love, surprised, sad, angry, sleepy, neutral |
| `Esc` | Release the cursor |
| Scroll wheel | Third-person camera distance (and bird's-eye height) |

Optional, and only active when the world declares the matching ability:

| Input | Action | Ability |
| --- | --- | --- |
| `Space` in mid-air | Second jump | `doubleJump` |
| `C` | Crouch (descend while flying) | `crouching` |
| `F`, or double-tap `Space` | Toggle flight; flying down onto the floor lands | `flying` |
| `Shift` while flying | Descend | `flying` |
| `Ctrl` + a move key, or double-tap `W` | Fly twice as fast, until you stop moving | `flying` |
| `Q` | Dash | `dash` |

## Bird's-eye view

The lobby has a bird's-eye view: a high, three-quarter look down at it (close
to isometric, but in perspective), for getting somewhere far away quickly.
It has its own key, `M`, and its own button (bottom right on desktop, beside
the menu button on touch), and works at any time: walking, running or flying.
Other worlds don't have it, unless they ask for it with `view: { aerial: true }`.

While it is on, the player stands still, the cursor is free, and pointing
picks where to land:

| Input | Action |
| --- | --- |
| Move the mouse | A marker shows where you would land |
| Click | Land there, and walk on in the mode you came from |
| Drag | Move the view over the ground |
| `Q` / `E`, or right-drag | Turn the view around (its tilt stays three-quarter) |
| `W` `A` `S` `D` / arrows | Move the view (`Shift` for faster) |
| Scroll wheel | Lower or higher. The lobby's opens 80 m up, as high as it goes (`view.aerialMaxHeight`, 40 m unless a world sets it) |
| `M`, `Esc` or the button | Back to walking where you were |

The view glides at the height it opened at: panning over a roof does not lift
it. Pointing at a wall puts the marker at the wall's foot. Colliders a world marks with
`mesh.userData.noLanding = true` (a glass roof only fliers reach, say) are
seen through, to whatever is under them. The bird's-eye view is never carried
to the next world, and VR always leaves it.

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
| Bottom-left of the screen | Move. A joystick rests in the bottom-left corner; grab it there, or touch anywhere in the bottom-left part of the screen and it comes to your thumb |
| Drag anywhere else | Look, including the top-left; a second finger while moving looks too |
| ▲ button | Jump |
| E button | Interact (a world can hide it with `ui: { interactButton: false }`) |
| V button | Toggle first / third person |
| Bird's-eye button (top right, beside ⏸) | Bird's-eye view, on and off (in worlds that offer it) |
| ⏸ button (top right) | Pause |

In the bird's-eye view the joystick and the buttons are put away (worlds hide
their own, such as the lobby's talk and chat buttons, on `view:change`). One
finger drags the view, two fingers pinch to zoom and twist to turn it, and a
tap lands the player where you tapped.

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

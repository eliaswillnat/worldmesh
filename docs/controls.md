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
| `V` | Toggle first ↔ third person (in the lobby: first → third → bird's-eye view) |
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

The lobby has a third camera mode: a high, three-quarter look down at it, for
getting somewhere far away quickly. Other worlds don't, unless they ask for it
with `view: { aerial: true }`. While it is on, the player stands still and the
controls move the view instead:

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` / arrows | Pan over the ground |
| `Shift` | Pan faster |
| Mouse | Turn the view around, and tilt it between steep and shallow |
| Scroll wheel | Higher or lower, never more than 50 m above the ground in the lobby (`view.aerialMaxHeight`, 40 m unless a world sets it) |
| Click, or `E` | Land where the marker is, and walk on in the mode you came from |
| `V` | Back to first person without moving |

The marker sits on the first surface under the middle of the screen; pointing
at a wall puts it at the wall's foot. Colliders a world marks with
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
| Left half of the screen | Move. A joystick rests in the bottom-left corner; grab it there, or touch anywhere on the left and it comes to your thumb |
| Drag on the right half | Look |
| ▲ button | Jump |
| E button | Interact |
| V button | Toggle first / third person (in the lobby, the bird's-eye view too) |
| ⏸ button (top right) | Pause |

In the lobby's bird's-eye view the joystick pans, dragging on the right turns the view,
and E (or the prompt) lands the player at the marker.

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

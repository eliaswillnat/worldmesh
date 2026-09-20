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

## Touch and VR

Not implemented. When they are, they belong in the runtime's input layer for
exactly the same reason the keyboard bindings do.

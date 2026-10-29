> 🌀 **Nougan Suite** · [← Back to docs](README.md)

# 🖱️ Canvas Tools
<img width="1672" height="940" alt="canvas nodes" src="https://github.com/user-attachments/assets/3f2504c7-e748-4bfc-938f-3c568c33c057" />
Six frontend-only extensions for ComfyUI's classic canvas. They add no nodes and need no Python beyond the suite's `__init__.py`, which only checks the files are present and prints them in the startup banner.

| Tool | Gesture | What it does |
|------|---------|--------------|
| [Zip Ties](#-zip-ties) | Hold **Z**, drag across wires | Bundles wires into a neat ribbon |
| [Bypass Slash](#-bypass-slash) | Hold **B**, drag across nodes | Bypasses (or mutes) them; slash again to restore |
| [Smart Guides](#-smart-guides) | Just drag a node | Figma-style alignment lines and snapping, plus one-click tidy by dependency |
| [Subgraph Box](#-subgraph-box) | Hold **V**, drag a box | Boxed nodes become a subgraph; box a subgraph to unpack it |
| [Group Box](#-group-box) | Hold **G**, drag a box | Boxed nodes get wrapped in a group; box a whole group to remove it |
| [Group Switch](#-group-switch) | Hold **S**, click a group's title | Bypasses everything inside a group; click again to restore |

All settings live under **Settings → Nougan**.

---

## Install

Put the files in the suite's `web` folder:

```
Nougan_Nodes/
├── __init__.py
└── web/
    ├── nougan_zip_ties.js
    ├── nougan_bypass_slash.js
    ├── nougan_smart_guides.js
    ├── nougan_subgraph_box.js
    ├── nougan_group_box.js
    └── nougan_group_switch.js
```

`__init__.py` lists them in `_WEB_ONLY`, so the startup banner confirms each one is present:

```python
_WEB_ONLY = [
    ("Zip Ties", "nougan_zip_ties.js"),
    ("Bypass Slash", "nougan_bypass_slash.js"),
    ("Smart Guides", "nougan_smart_guides.js"),
    ("Subgraph Box", "nougan_subgraph_box.js"),
    ("Group Box", "nougan_group_box.js"),
    ("Group Switch", "nougan_group_switch.js"),
]
```

Restart ComfyUI and hard-refresh the browser tab (Ctrl+F5).

**Requirements:** the classic litegraph canvas. These tools do not work with the Vue/"nodes 2.0" renderer.

---

## 🪢 Zip Ties

Hold **Z** and drag a line across several wires to bundle them into a ribbon held together by a cable tie. Useful for taming a mess of parallel connections.

Based on the *ZipTies* extension by **safzan**. Saved ties use the same `graph.extra.zipTies` field, so workflows are interchangeable with the original. If the original `safzan.ZipTies` extension is also installed, this copy stands down (two copies would both patch the canvas); remove one of them.

### Using it

| Action | How |
|--------|-----|
| Tie wires | Hold **Z**, drag across the wires. The line previews white where it will tie. |
| Tie wires (no keyboard) | Right-click the canvas → **Tie wires**, then drag |
| Move a tie | Drag it |
| Rotate a tie | **Shift**-drag it (15° steps; add **Alt** for free rotation) |
| Colour, rotate 45° / 90°, remove | Right-click the tie |
| Cut a tie | Hold **Z** and drag across it (line turns red), or double-click it |
| Select ties | Click, **Ctrl/Cmd**-click to toggle, or rubber-band select (Shift adds, Alt removes) |
| Delete selected ties | **Delete** / **Backspace** |

Ties follow their wires: move a node, a group, or a selection and the ties move with them. Copy and paste carries ties along when every wire in the tie is part of the copied selection.

Ties are hidden and inactive while link rendering is set to *Hidden*.

### Settings (Nougan → Zip Ties)

- **Key to hold while dragging across wires**: Z, X, C, G, T or Y. These are letters ComfyUI doesn't bind on its own.
- **Colour of new ties**: *Random* (a cable-tie colour per tie), *Match wires* (takes the colour of the wires it holds), or *Grey*.

---

## ⚡ Bypass Slash

Hold **B** and drag a line across nodes to bypass them. Slash across them again to bring them back.

### Using it

1. Hold **B**. A hint pill appears and the cursor becomes a crosshair.
2. Drag across the nodes you want. The line and highlights preview what will happen:
   - **Magenta**: BYPASS
   - **Grey**: MUTE
   - **Green**: RESTORE
   - **Dashed white**: crosses nothing yet
3. Release. The affected nodes flash and the change is applied as **one undo step**.

**The rule:** if *every* node under the slash is already in the target mode, the slash restores them all. Otherwise it puts all of them into the target mode. A label next to the cursor (e.g. `BYPASS · 4 nodes`) tells you which one you're about to get.

Other ways in and out:

- Right-click the canvas → **Slash bypass** arms the next drag as a slash, no key needed.
- **Esc** cancels a stroke in progress, or disarms the menu option.
- The gesture is ignored while a modifier (Alt/Ctrl/Shift/Cmd) is down, so Alt-drag cloning and similar still work. **Ctrl+B** (ComfyUI's native bypass) is untouched.
- The key is ignored while you're typing in a text field.

### Settings (Nougan → Bypass Slash)

- **Key to hold while slashing across nodes**: B, X, C, G, T or Y. If you set this to the same key as Zip Ties, Zip Ties keeps it and Bypass Slash is inactive.
- **What a slash does**: *Bypass* (inputs pass straight through the node) or *Mute* (skips the node and everything that only feeds it).

---

## 📐 Smart Guides

Two things in one extension: snapping guides while you drag, and a one-click tidy.

### Alignment guides

Drag one or more nodes and they snap to the **left edge, centre and right edge**, and the **top, middle and bottom**, of other nearby nodes. Magenta guide lines with small ✕ marks show exactly what you're aligned to.

- Hold **Ctrl/Cmd** or **Shift** while dragging to move freely. Shift is ComfyUI's own grid snap, so it takes over.
- Snapping only runs when everything you're dragging is a node. Moving groups or reroutes behaves as before.
- Only nodes on or near the screen are considered.

### Tidy by dependency

Arranges nodes into **columns by dependency depth**: nodes with no inputs on the left, then whatever depends on them, and so on to the right.

- Run it from the canvas right-click menu, a node's right-click menu (**Tidy by dependency**), the command palette (**Tidy nodes by dependency**), or press **Alt+L**. The shortcut can be rebound under Keybinding settings.
- With **two or more nodes selected**, only those are arranged. Otherwise the whole graph is.
- A node's column is the longest chain of connections leading to it. Loops are broken rather than followed forever.
- Inside a column, each node tries to sit level with the middle of the nodes that feed it; overlaps are then pushed apart.
- Loaders and other nodes with no inputs are placed in the column just before the first node that uses them, rather than the far left, which keeps their wires short.
- It animates briefly and counts as **one undo step**. Zip ties follow their wires.

Things tidy does not do: it ignores groups (nodes may end up outside their group frames), and nodes with no links at all, including Remote Set/Get nodes, end up in the first column.

### Settings (Nougan → Smart Guides)

| Setting | Default | Meaning |
|---------|---------|---------|
| Snap nodes to each other while dragging | On | Master switch for the guides |
| Snap distance (screen pixels) | 6 | How close counts as aligned |
| Tidy: gap between columns | 80 | Horizontal spacing |
| Tidy: gap between nodes in a column | 30 | Vertical spacing |
| Tidy: put loaders next to the node that uses them | On | Pull source nodes toward their consumer |

A larger snap distance gives a stronger magnet; a smaller one a lighter touch. The distance is in screen pixels, so it feels the same at any zoom level.

---

## ▣ Subgraph Box

Hold **V** with your left hand and drag a box with the mouse. Release and the boxed nodes become a subgraph. Hold **V** and box a subgraph node and it unpacks again.

This does not reimplement subgraphs. It selects what you boxed and runs ComfyUI's own *Convert to Subgraph* and *Unpack Subgraph* commands, so wiring, inputs/outputs and undo behave exactly like the native feature. It needs a ComfyUI frontend with subgraph support (unpacking needs a newer one); if the commands are missing you get a toast instead of a broken graph.

### Using it

1. Hold **V**. A hint pill appears and the cursor becomes a crosshair.
2. Drag a box. The preview tells you what will happen when you let go:
   - **Teal**: SUBGRAPH. Two or more nodes will be converted.
   - **Orange**: UNPACK. Every captured node is a subgraph, so they will be unpacked.
   - **Dashed white**: nothing will happen (no nodes, or a single ordinary node).
3. Release. The affected nodes flash and the native command runs, with its normal undo step.

The rule is decided by what is inside the box: all subgraphs means unpack, two or more nodes of any mix means make a subgraph (so you can nest), anything else does nothing. A tiny drag is treated as a click and ignored.

Other ways in and out: right-click the canvas → **Box subgraph** arms the next drag with no key. **Esc** cancels. The gesture is ignored while a modifier is down, and while you're typing in a text field. Works inside a subgraph too, on whatever graph you are viewing.

### Settings (Nougan → Subgraph Box)

- **Key to hold while boxing nodes**: V, E, D, S or A, all left-hand letters ComfyUI doesn't bind on its own. If you pick the same key as Zip Ties or Bypass Slash, those keep it and this one is inactive.
- **Which nodes the box captures**: *Fully enclosed* (default, only nodes completely inside) or *Anything touched* (every node the box overlaps).

---

## ▢ Group Box

Hold **G** with your left hand and drag a box with the mouse. Release and the boxed nodes are wrapped in a group. Box exactly the nodes of an existing group and the group is removed again; the nodes stay where they are.

The group is built directly, the same way ComfyUI's own *Group Selected Nodes* does it, so it doesn't depend on the canvas selection. The held key is swallowed while you use it, so other ComfyUI shortcuts bound to that letter don't fire. ComfyUI's own command is only used as a fallback.

### Using it

1. Hold **G**. A hint pill appears and the cursor becomes a crosshair.
2. Drag a box. The preview tells you what will happen when you let go:
   - **Blue**: GROUP. One or more nodes will be wrapped; a dashed frame shows roughly where the group will sit.
   - **Red**: UNGROUP. The captured nodes are exactly the nodes inside an existing group, so that group will be removed.
   - **Dashed white**: nothing will happen (no nodes captured).
3. Release. The nodes flash and the change is applied as **one undo step**.

The rule is decided by what is inside the box: exactly one existing group's nodes means ungroup; anything else with at least one node means make a group (so you can nest groups, or group a subset of a group). If several groups wrap the same nodes, the innermost one is removed. A tiny drag counts as a click and is ignored.

Other ways in and out: right-click the canvas → **Box group** arms the next drag with no key. **Esc** cancels. The gesture is ignored while a modifier is down, and while you're typing in a text field.

### Settings (Nougan → Group Box)

- **Key to hold while boxing nodes**: G, E, D, S or A, all left-hand letters ComfyUI doesn't bind on its own. If you pick the same key as Zip Ties, Bypass Slash or Subgraph Box, those keep it and this one is inactive.
- **Which nodes the box captures**: *Fully enclosed* (default) or *Anything touched*.
- **Colour of new groups**: *Default* or one of ComfyUI's group colours.
- **Title of new groups**: the name a new group starts with.
- **Open the title editor on the new group**: lets you type the name right away. Best effort; turn it off if it misbehaves on your frontend version.

---

## ⏻ Group Switch

Hold **S** and click a group's title bar to bypass everything inside it. Click again to bring it back. Drag a line across several title bars to switch them all at once, the same gesture as Bypass Slash. It's quick for A/B testing whole sections, such as "with the LoRA stack" and "without".

### Using it

1. Hold **S**. A hint pill appears and the cursor becomes a crosshair. Moving over a group previews what a click would do.
2. Click a group's title bar, or drag across several. The preview shows:
   - **Magenta**: BYPASS
   - **Grey**: MUTE
   - **Green**: RESTORE
   - **Dashed white line**: the stroke isn't over any group that has nodes in it yet
3. Release. The groups flash and the change is applied as **one undo step**.

**The rule:** if every group under the click or slash is already switched off (all its nodes are in the target mode), it restores them all. Otherwise it switches all of them off. A label such as `BYPASS · 2 groups · 14 nodes` tells you what you're about to get.

**Restoring is exact.** When a group is switched off, each node's previous mode is remembered, so a node you had bypassed by hand beforehand stays bypassed afterwards. This memory lasts for the session and isn't saved in the workflow. A group that was switched off some other way (for example, saved that way) is restored to normal.

Nested groups work: nodes are counted by which group frame contains them, so switching an outer group switches everything in it, inner groups included. Groups with no nodes in them are ignored.

Other ways in and out: right-click the canvas → **Slash group** arms the next click or drag with no key. **Esc** cancels. The gesture is ignored while a modifier is down, and while you're typing in a text field.

### Settings (Nougan → Group Switch)

- **Key to hold while clicking or slashing groups**: S, E, D or A. If you pick the same key as any other canvas tool, that tool keeps it and this one is inactive.
- **Where a click or slash counts**: *Title bar* (default, so a slash across a big group doesn't catch it by accident) or *Anywhere on the group*.
- **Bypass or mute**: set under **Nougan → Bypass Slash → What a slash does**. Group Switch uses the same setting.

---

## Key map at a glance

| Key | Used by | Notes |
|-----|---------|-------|
| **Z** (hold) | Zip Ties | Configurable: Z X C G T Y |
| **B** (hold) | Bypass Slash | Configurable: B X C G T Y |
| **Ctrl/Cmd or Shift** (while dragging a node) | Smart Guides | Disables snapping |
| **V** (hold) | Subgraph Box | Configurable: V E D S A |
| **G** (hold) | Group Box | Configurable: G E D S A |
| **S** (hold) | Group Switch | Configurable: S E D A |
| **Alt+L** | Smart Guides | Tidy by dependency; rebindable |
| **Esc** | Bypass Slash | Cancels a stroke or armed mode |

Zip Ties, Bypass Slash, Subgraph Box, Group Box and Group Switch all read a held letter key. Pick different letters for each; on a clash Zip Ties wins, then Bypass Slash, then Subgraph Box, then Group Box, and Group Switch yields to all of them.

---

## Troubleshooting

- **Nothing happens at all**: you're probably on the Vue/"nodes 2.0" renderer. Switch back to the classic canvas.
- **A tool is missing from the startup banner**: the file isn't in `web/`, or has a different name than the one listed in `_WEB_ONLY`.
- **Zip Ties does nothing and the console mentions `safzan.ZipTies`**: the original extension is installed. Remove one of the two.
- **A ComfyUI toast pops up repeatedly while holding the key**: another shortcut is bound to that letter. Group Box swallows its own key, but if it still happens, pick a different key in settings (or unbind the shortcut in ComfyUI's Keybinding settings).
- **The key does nothing**: check you're not holding a modifier, not focused in a text box, and that the key isn't also assigned to the other gesture.

---

## Credits

Zip Ties is based on **safzan**'s *ZipTies* ComfyUI extension. Bypass Slash, Smart Guides, Subgraph Box, Group Box and Group Switch are original to the Nougan suite.

Made by **Winnougan**.

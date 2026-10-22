# The motion system

**One vocabulary, used everywhere.** This is the specification `CC-047` implements. It is
written before the code, so that the code is measured against something.

The **naming rule** applies to everything here: no third-party product or company is
referenced, named or cited — in this document, in the code, in the comments, or in the
identifiers. The vocabulary below is ours.

---

## 1. What the motion system is

**One system, four places.** The prompt, the transitions between the agent's states, the
pipeline's stage changes and the overlays all animate through **one** vocabulary: the same
kinds, the same easings, the same durations and the same frame budget. A motion drawn in
the prompt and the same motion drawn in an overlay are the **same picture**, because they
are the same function of the same time.

The decision this implements is in
[`docs/DIVERGENCE-LAYER-2.md`](../DIVERGENCE-LAYER-2.md) §6: **"A shared motion system,
used everywhere. One vocabulary — the same easing, the same durations, the same frame
budget — used by the prompt, the transitions, the stage changes and the overlays."**

### 1.1 The four rules, and they are the whole contract

1. **One vocabulary.** A motion is named from the table in §2.4, and its frame comes from
   the one function in §3. There is no second easing curve, no second duration table and
   no second frame clock anywhere in the product.
2. **What cannot be drawn is not drawn.** The terminal's capability is detected **once**
   (§4). A terminal that cannot draw a frame gets the **resting** picture and the reason,
   in the shared capability shape — `enabled: false` and `unsupported: <why>`. A motion is
   never half-drawn and never faked.
3. **Motion never blocks the input.** A slow frame delays the picture, never the key
   (§5).
4. **The motion is deterministic.** A frame is a function of the motion and the time
   alone (§3.4), so a test can assert on a frame and a golden can be recorded.

### 1.2 Where it sits

The first layer's terminal surface is the substrate. The theme
(`src/ui/theme.ts`) owns the colours and the **roles**; the renderers
(`src/ui/render/`) produce **segments** — a piece of text and the **role** it is drawn
in, with the colour resolved at the moment it is drawn.

The motion system **sits on** that and does not disturb it:

- it **reads** the theme's roles and the first layer's `Segment` shape;
- it **never writes** a colour literal of its own — a motion is expressed in the theme's
  own roles and in the segment styles every terminal has;
- it changes **nothing** under `src/ui/render/` or `src/ui/app.ts`. The first layer's
  rendering is pinned by its own tests, and those tests do not move.

---

## 2. The vocabulary

### 2.1 The kinds

A **kind** says *what* is animated. There are five, and no more.

| the kind | the frame carries | what it animates |
|---|---|---|
| `fade` | `opacity` — 0..1 | how present the content is |
| `slide` | `offset` — whole lines, signed | where the content sits |
| `pulse` | `brightness` — 0.5..1 | how brightly the content is drawn |
| `shimmer` | `phase` — 0..1 | where the travelling light is |
| `blink` | `visible` — a boolean | whether the content is drawn at all |

### 2.2 The easings

An **easing** is a curve from the progress `t` (0..1) to the eased progress. Every
easing is a **closed form** — no state, no simulation, so a frame is reproducible.

| the easing | the curve |
|---|---|
| `linear` | `t` |
| `ease-in` | `t * t` |
| `ease-out` | `1 - (1 - t) * (1 - t)` |
| `ease-in-out` | `t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2` |

The curve is evaluated on a `t` **clamped** to `[0, 1]`, and the result is clamped to
`[0, 1]`.

### 2.3 The durations

A **duration** is how long one pass takes. There are four, and every motion's duration is
one of them.

| the duration | the milliseconds |
|---|---|
| `instant` | 0 |
| `fast` | 120 |
| `normal` | 240 |
| `slow` | 480 |

### 2.4 The named motions

The **named motions** are the product's vocabulary. This table is the whole of it: a
surface that wants a motion takes one of these names.

| the name | the kind | the easing | the duration | it repeats | what it is for |
|---|---|---|---|---|---|
| `overlay-in` | `fade` | `ease-out` | `fast` | no | an overlay arriving |
| `overlay-out` | `fade` | `ease-in` | `fast` | no | an overlay leaving |
| `transition-in` | `slide` | `ease-out` | `normal` | no | the agent's state changing |
| `transition-out` | `slide` | `ease-in` | `normal` | no | the agent's state changing back |
| `prompt-shimmer` | `shimmer` | `linear` | `slow` | yes | the prompt's shimmer |
| `stage-advance` | `pulse` | `ease-in-out` | `normal` | no | the pipeline's stage changing |
| `cursor-blink` | `blink` | `linear` | `slow` | yes | the cursor |

### 2.5 The three frames of a motion

Every motion declares **three** frames, all of its own kind:

| the frame | what it is |
|---|---|
| the **start** | the frame at the beginning of a pass |
| the **end** | the frame at the end of a pass |
| the **resting** | the picture the motion shows when it is **not** animating |

| the motion | the start | the end | the resting |
|---|---|---|---|
| `overlay-in` | `opacity 0` | `opacity 1` | `opacity 1` |
| `overlay-out` | `opacity 1` | `opacity 0` | `opacity 1` |
| `transition-in` | `offset +1` | `offset 0` | `offset 0` |
| `transition-out` | `offset 0` | `offset -1` | `offset 0` |
| `prompt-shimmer` | `phase 0` | `phase 1` | `phase 0` |
| `stage-advance` | `brightness 0.5` | `brightness 1` | `brightness 1` |
| `cursor-blink` | `visible true` | `visible false` | `visible true` |

Two things follow from the table, and both are the point of it:

- **The direction is in the table.** `overlay-in` fades *in* and `overlay-out` fades
  *out*; `transition-in` comes up from one line below and `transition-out` goes one line
  above. A motion never has to be told which way it runs.
- **The resting frame is not the end of a pass.** `overlay-out` ends at no opacity and
  still rests fully present, because a motion that is not drawn is not a motion that has
  finished.

A motion also declares its **distance**: how many lines a `slide` moves. It is **1** for
both transitions and **0** for every other motion.

### 2.6 The rule about the easing

The easing shapes a motion that moves **between two states**: `fade`, `slide` and
`pulse`. The two motions that **cycle** — `shimmer` and `blink` — run on the **raw**
progress of the cycle, because a curve has no meaning in a cycle that never ends. The
easing named for them is `linear`, which says the same thing.

---

## 3. The frame

### 3.1 The clock

The system's clock is the **frame index**. A frame is not drawn at an arbitrary moment:
it is drawn on a frame boundary.

```
interval        = 33 milliseconds            (the frame budget — §6)
index(elapsed)  = floor(max(0, elapsed) / interval)
time(elapsed)   = index(elapsed) * interval
```

`elapsed` is the time since the motion started, in whole milliseconds. A negative
elapsed is **0**.

**The frame's own time is the quantised one.** Two elapsed times inside the same frame
interval produce the **same** frame — the frame is a function of the frame index, not of
the moment the picture happened to be drawn.

### 3.2 The progress

For a motion `M` with duration `d` (in milliseconds) and the quantised time `t`:

```
if M repeats:  p = d > 0 ? (t mod d) / d : 0
otherwise:     p = d > 0 ? min(1, t / d) : 1
e = easing(M.easing, p)
```

A one-pass motion that has run out of time has `p = 1` and stays there. A repeating
motion's progress is the position **within** its cycle.

### 3.3 The frames

The three kinds that move **between two states** interpolate between the motion's
**start** and its **end**, with the eased progress:

| the kind | the frame |
|---|---|
| `fade` | `{ kind: 'fade', opacity: start.opacity + (end.opacity - start.opacity) * e }` |
| `slide` | `{ kind: 'slide', offset: round(start.offset + (end.offset - start.offset) * e) }` |
| `pulse` | `{ kind: 'pulse', brightness: start.brightness + (end.brightness - start.brightness) * e }` |

The two kinds that **cycle** run on the raw cycle progress `p`:

| the kind | the frame |
|---|---|
| `shimmer` | `{ kind: 'shimmer', phase: start.phase + (end.phase - start.phase) * p }` |
| `blink` | `{ kind: 'blink', visible: p < 0.5 ? start.visible : end.visible }` |

`round` is the nearest whole number, halves upward — a terminal's layout is in whole
lines, so a slide is a whole line. `opacity` and `brightness` are floating point and are
never rounded: the frame carries the exact value.

### 3.4 Determinism

**The frame is a function of the motion and the time alone.** It does not read a clock,
it does not keep a counter, and it does not depend on how many frames were drawn before
it. Two consequences, and both are tested:

- **Stepping is the same as asking.** Drawing frames one at a time — 0, 33, 66, … — gives
  exactly the frames that asking for each of those times gives. A scheduler that drifts
  is a bug, and this is what catches it.
- **A frame is a value.** It can be asserted on, compared, and recorded in a golden.

### 3.5 The resting frame

The **resting frame** is the picture a motion shows when it is **not** animating. It is
the third frame of §2.5, and it is what a terminal without the capability gets:

| the motion | the resting frame |
|---|---|
| `overlay-in`, `overlay-out` | `{ kind: 'fade', opacity: 1 }` — fully present |
| `transition-in`, `transition-out` | `{ kind: 'slide', offset: 0 }` — at its origin |
| `prompt-shimmer` | `{ kind: 'shimmer', phase: 0 }` — the base look |
| `stage-advance` | `{ kind: 'pulse', brightness: 1 }` — full brightness |
| `cursor-blink` | `{ kind: 'blink', visible: true }` — the cursor is there |

**The resting frame is not the end of a pass.** `overlay-out` *ends* at no opacity, but
its resting frame is fully present: a motion that is not drawn is not a motion that has
finished.

---

## 4. The capability, and the degradation

### 4.1 The detection

The terminal's capability is detected **once**. The detection is a pure function of what
the terminal says about itself:

| what is detected | the rule |
|---|---|
| **interactive** | the output is a terminal, and `TERM` is not `dumb`. A terminal that says `dumb` cannot draw a frame, whatever it says about being a terminal. |
| **reduced motion** | the user asked for reduced motion. The setting is the first layer's own `prefersReducedMotion` — "Reduce or disable animations for accessibility". |

The detection reads the environment and the output's terminal-ness, and it takes the
reduced-motion preference as an input, because the preference is the user's and not the
terminal's.

### 4.2 The record

The record is the **shared capability shape** — the one `src/protocol/capability.ts`
builds and `docs/protocol/PROTOCOL.md` §6 states. The motion capability is a record like
any other:

```jsonc
// a terminal that can draw
{ "enabled": true, "unsupported": null, "interactive": true, "reducedMotion": false }

// a terminal that cannot
{ "enabled": false, "unsupported": "the output is not an interactive terminal, so no frame can be drawn" }
```

The motion capability's own fields sit beneath the shared pair: `interactive` and
`reducedMotion`. **The reason is a sentence that names what is missing**, exactly as the
protocol's contract says.

### 4.3 When the capability is off

The capability is **off** when either of these holds, and the reasons are checked in this
order:

1. **the user asked for reduced motion** — `unsupported: "the user asked for reduced
   motion, so no animation is drawn"`;
2. **the output is not an interactive terminal** — `unsupported: "the output is not an
   interactive terminal, so no frame can be drawn"`.

The user's own reason comes first: it is the one they can act on.

### 4.4 The degradation

**What cannot be drawn is not drawn.** When the capability is off:

- the motion's **resting frame** is what is drawn — the content, with no animation;
- **no frame is scheduled at all** — the scheduler draws nothing;
- the reason is **reported**, in the shared shape, and never left out.

There is no third thing: a motion is either drawn, or it is not drawn and the reason is
reported.

---

## 5. The renderer

### 5.1 One drawer

**There is one function that turns a motion into a picture**, and every surface uses it.
That is what makes "the same motion renders identically wherever it is used" a property
rather than a hope: there is nothing to differ.

The drawer is entered in **two ways**, and they must agree:

- `drawMotion` — from the motion and the elapsed time: the frame is computed (§3) and
  drawn;
- `drawFrame` — from a frame that has already been computed: the frame is drawn.

A surface that animates asks for frames as the clock advances and draws them with
`drawFrame`; a surface that draws once asks `drawMotion`. **Both paths draw the same
picture for the same frame**, and that is the test.

### 5.2 What the drawer produces

The drawer produces the first layer's **`Segment[]`** — the same shape the first layer's
renderers produce, carrying **roles** and **styles** and never a colour literal. The
render also carries the frame's exact values, so a surface that can do better than the
coarse form can read them:

| what the render carries | what it is |
|---|---|
| `frame` | the frame itself (§3.3) |
| `opacity` | the frame's opacity, 0..1 |
| `offset` | the frame's offset, in whole lines |
| `segments` | the content, styled by the frame |

### 5.3 The content

The content is either a **string** or a list of **segments**. A string becomes one
segment. A request may name a **role**, which is the role of any segment that does not
carry one of its own; a segment that names its own role keeps it.

### 5.4 The effects

The drawer draws what the segment shape can express — the theme's own roles and the
styles every terminal has. The **coarse form** is stated here, so nothing is implied
that is not drawn:

| the kind | the effect on the segments |
|---|---|
| `fade` | the segments are drawn `dim` when the opacity is **below 1**. The coarse form of an opacity: the terminal's own idiom for "less present". |
| `slide` | no effect on the segments — the movement is a **layout** matter, and the render carries the `offset` for the surface to apply. |
| `pulse` | the segments are drawn `dim` when the brightness is **below 1**. |
| `shimmer` | **each character** is drawn either in its own role or in that role's **shimmer partner**, according to where the travelling light is (§5.5). |
| `blink` | when the frame is not visible, the **text** is replaced by **spaces of the same length** — the layout holds, and the cursor is simply not there. |

### 5.5 The shimmer's travelling light

The shimmer is drawn **per character**, so the light travels across the content rather
than switching the whole run at once.

- The content's characters are counted **across the whole content**, not per segment.
- The light's **width** is `w = max(2, ceil(n / 2))` characters, where `n` is the
  content's length in characters.
- The light's **head** is at `head = -w + phase * (n + 2 * w)`: it enters from before the
  content, crosses it, and leaves after it.
- The character at index `i` is lit by `d = clamp(1 - |i - head| / w, 0, 1)`.
- A character with `d > 0` is drawn in its **shimmer partner**; a character with `d = 0`
  is drawn in its **own role**.

The **shimmer partner** of a role is the theme's own role of that name:

1. `<role>Shimmer` — the theme's camel-cased partner, as in `prricodeShimmer`;
2. otherwise `<role>_shimmer` — the theme's underscored partner, as in
   `rainbow_red_shimmer`;
3. otherwise the theme's **`text`** role.

So the shimmer is drawn in the **theme's own colours**, and the motion system writes no
colour of its own.

### 5.6 The degraded draw

When the capability is off, the drawer draws the **resting frame**: the content, with no
motion styling at all. The render still carries the frame — the resting one — so a
surface cannot tell by accident that an animation was expected.

---

## 6. The frame budget, and the input

### 6.1 The budget

**One frame every 33 milliseconds** — thirty a second. The interval is the budget: the
system never spends more than one frame's worth of time on the picture per interval, and
the picture is what the budget is for.

### 6.2 The input comes first

**Motion never blocks the input.**

- A **tick** — the scheduler's unit of work — draws **at most one** frame.
- A tick that finds an **input waiting** draws **nothing** and yields to it. The input
  goes first, always.
- The frame's time comes from the **clock**, not from an accumulation of frame costs. A
  slow frame therefore **drops** the frames it missed rather than queueing them: the
  picture catches up, and the key is never behind the picture.

### 6.3 The scheduler

The scheduler is the system's only clock. It:

- holds the **capability**, and draws **nothing at all** when the capability is off;
- draws **at most one frame** per tick, and **no frame** when the index has not moved;
- takes the elapsed time from an injected clock, so a test drives it by hand.

---

## 7. What this milestone does not build

- **The surfaces.** The prompt, the transitions, the stage changes and the overlays are
  `CC-048`'s. This milestone builds the system they will use.
- **The golden frames.** A frame is deterministic (§3.4), so a golden *can* be recorded —
  recording one is `CC-048`'s and `CC-050`'s.
- **The pipeline.** The stage change's *event* is `CC-045`'s. The motion the terminal
  draws when that event arrives is `CC-048`'s. The motion's **name** is here:
  `stage-advance`.
- **The first layer's own spinner.** The theme's spinner frames and their cadence are the
  first layer's, and they are pinned by the first layer's own tests. The motion system
  does not define a second spinner.
- **A compatibility row.** The target has no counterpart for this surface, and a
  divergence is not a compatibility claim. The readings are in
  [`docs/compatibility/motion-surface.md`](../compatibility/motion-surface.md).

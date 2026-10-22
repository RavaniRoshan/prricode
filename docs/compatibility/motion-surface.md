# The motion surface — conformance

**The specification:** [`docs/protocol/MOTION.md`](../protocol/MOTION.md) — one
vocabulary, used everywhere: the same kinds, the same easings, the same durations and the
same frame budget, for the prompt, the transitions, the pipeline's stage changes and the
overlays; the terminal's capability detected **once**, and what cannot be drawn **not
drawn**, with the reason in the shared shape; motion that never blocks the input; and a
motion that is deterministic.
**The decision:** [`docs/DIVERGENCE-LAYER-2.md`](../DIVERGENCE-LAYER-2.md) §6 — "A shared
motion system, used everywhere" and "Detect and disable, with the reason".
**Owning task:** `CC-047` in
[`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
**The implementation:** `src/ui/motion/` — **seven modules**: `vocabulary`, `easing`,
`frame`, `capability`, `render`, `schedule` and the barrel.
**The test:** `tests/contracts/motion.test.ts` — **forty-eight tests**.

The specification says what was built against it, and where it left a choice open, which
reading was taken and why.

---

## 0. The labels, and why this surface has no target rows

This surface is **our own design**. The pinned target has a terminal surface of its own,
and the first layer reproduces it — that is
[`docs/compatibility/feature-matrix.md`](feature-matrix.md), and it measures the
**rendering**. This document measures the **second layer's** motion: the vocabulary, the
frame, the capability and the degradation, and the second layer's motion is not a copy of
the first layer's: the first layer's spinner, its shimmer roles and its glyphs are the
target's, and this system is a product of its own.

So there is nothing to compare this surface against and **no row in the compatibility
matrix**: a divergence is not a compatibility claim, and a compatibility row must not be
weakened to make room for one.

Every row of this document therefore carries the first layer's **clone-choice label**:

| label | meaning | here |
|---|---|---|
| `Project requirement` | a product extension: the target does not have this behaviour, and nothing about it is a claim about the target | **every row of this document** |

and, inside the second layer, the label that says where the row comes from:

| label | meaning |
|---|---|
| `specified` | pinned by `docs/protocol/MOTION.md` — the specification says it, and the implementation says it |
| `implementation choice` | the specification is silent, and the reading below is ours |

The two are orthogonal: a row is `Project requirement` **and** `specified`, or `Project
requirement` **and** `implementation choice`.

**The naming rule applies to every line of this document.** The surface is named — a
motion, a frame, a capability — and no product and no company is named, in this document
or in the code it describes.

---

## 1. The vocabulary — one table

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the names | "This table is the whole of it: a surface that wants a motion takes one of these names" | `MOTIONS` — **seven** motions: `overlay-in`, `overlay-out`, `transition-in`, `transition-out`, `prompt-shimmer`, `stage-advance`, `cursor-blink`. The test reads the table and checks that **nothing else is in it** | `the motion vocabulary › names the seven motions, and the table holds nothing else` |
| the easings | four curves, each a closed form | `EASINGS` — `linear`, `ease-in`, `ease-out`, `ease-in-out`, each evaluated on a **clamped** progress | `the motion vocabulary › has four easings, and each one is the curve the specification states`; `… › clamps the curve to the progress, so a time outside the pass is the end of it` |
| the durations | four names, and every motion's duration is one of them | `DURATIONS` — `instant` 0, `fast` 120, `normal` 240, `slow` 480. The test checks that the table holds nothing else | `the motion vocabulary › has four durations, and the table holds nothing else` |
| the binding | each motion carries its kind, its easing, its duration and whether it repeats | `MOTIONS` — and the test checks the binding of **all seven**, case by case | `the motion vocabulary › binds each motion to its easing, its duration and whether it repeats` |
| the direction | "The direction is in the table" | the motion declares its **start**, its **end** and its **resting** frame, so `overlay-in` fades in, `overlay-out` fades out, `transition-in` comes up from one line below and `transition-out` goes one line above | `the motion vocabulary › rests each motion at the picture the specification states`; `the frame › slides in whole lines, and the direction is in the table` |
| the distance | "1 for both transitions and 0 for every other motion" | `distance` — and the test checks all seven | `the motion vocabulary › slides the transitions by one line, and moves nothing else` |

**Implementation choice — the direction is carried by three frames rather than by a
flag.** The specification says that a motion's direction is in the table and that the
resting frame is not the end of a pass. Carrying a **start** and an **end** frame per
motion makes both of those true without a second mechanism: the frame function
interpolates between the start and the end with the easing, and the resting frame is a
third value that is neither of them when the motion needs it — `overlay-out` ends at no
opacity and still rests fully present. The alternative — a `reversed` flag — would have
made the resting frame a special case in the frame function instead of a value in the
table.

**Implementation choice — the rest of the theme's roles are the fallback for the
shimmer.** The specification says the shimmer's partner is `<role>Shimmer`, then
`<role>_shimmer`, then the theme's `text` role. The theme carries **72** roles, of which
the camel-cased partners are seven and the underscored ones seven more, so a role without
a partner falls back to `text`. The fallback is the specification's; that the theme's
partner pairs are **asymmetric** — `rainbow_red_shimmer` and not `rainbow_redShimmer` —
is the theme's own arrangement, and the lookup follows it rather than normalising it.

---

## 2. The frame — a value, and therefore a golden

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the quantisation | "Two elapsed times inside the same frame interval produce the **same** frame" | `motionFrame` computes the frame at the **quantised** time — `floor(elapsed / 33) * 33` — and never at the moment the picture happened to be drawn | `the frame › quantises the time to the frame index`; `… › gives the same frame to two times inside one frame interval` |
| the determinism | "The frame is a function of the motion and the time alone" | `motionFrame` reads no clock and keeps no counter. The test **steps** to a frame one frame at a time and compares the steps with the frames asked for | `the frame › is the same frame whether it is stepped to or asked for` |
| the budget | "One frame every 33 milliseconds — thirty a second" | `MOTION_FRAME_INTERVAL_MS` = 33, `MOTION_FRAME_RATE` = 30 | `the frame › spends one frame every 33 milliseconds, thirty a second` |
| the progress | the position in the cycle for a repeating motion, the fraction of the pass for a one-pass motion | `motionFrame` — and a one-pass motion that has run out of time **holds** at its end | `the frame › runs a one-pass motion to its end and holds it there`; `… › cycles a repeating motion` |
| the kinds | the frame carries the one value its kind animates | `fade` → the opacity, `slide` → the offset in whole lines, `pulse` → the brightness, `shimmer` → the phase, `blink` → the visibility | `the frame › fades from nothing to present over the motion's own easing`; `… › slides in whole lines, and the direction is in the table`; `… › pulses from half brightness to full`; `… › blinks on the first half of the cycle and off on the second` |
| the cycling kinds | "a curve has no meaning in a cycle that never ends" | `shimmer` and `blink` run on the **raw** cycle progress; the other three are shaped by the easing | `the frame › cycles a repeating motion`; `… › blinks on the first half of the cycle and off on the second` |

**The golden is possible because of this.** A frame is a value and the time is
quantised, so a frame can be recorded and compared — that is what `CC-048`'s golden
frames and `CC-050`'s staleness check are built on, and it is why the specification made
determinism a rule rather than a convenience.

---

## 3. The capability, and the degradation

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the shape | "the shared capability shape — `enabled: false` and `unsupported: <why>`" | `MotionCapability` — the pair the protocol's own `capabilityRecord` builds, with the motion capability's own fields (`interactive`, `reducedMotion`) beneath it. **There is no second shape** | `the terminal capability › carries the shared pair, and the reason is a sentence` |
| the detection | "detected **once**" | `MotionCapabilityProvider` detects on the first ask and keeps the record; the process-wide `motionCapability()` is one of them | `the terminal capability › is detected once, and the record is the same every time it is asked for`; `… › gives the process one capability, detected once` |
| the terminal | "the output is a terminal, and `TERM` is not `dumb`" | `detectMotionCapability` — a terminal that says `dumb` cannot draw a frame, whatever it says about being a terminal | `the terminal capability › treats a terminal that says dumb as one that cannot draw` |
| the reason | "the user's own reason comes first: it is the one they can act on" | the reduced-motion reason is checked **before** the terminal's | `the terminal capability › reports the user's own reason first` |
| the degraded picture | the motion's **resting** frame, and **no frame is scheduled at all** | `drawFrame` draws the resting frame and the plain content; the scheduler draws **nothing** | `the degradation › draws the resting picture when the capability is off`; `… › draws nothing at all when the capability is off`; `… › does not draw the animation of a motion that is not drawn` |
| the reason is reported | "never left out" | the reason is in the record the drawer was given, and the test reads it beside the degraded picture | `the degradation › reports the reason beside the degraded picture` |

**Implementation choice — the reduced-motion preference is the first layer's own
setting, and it is an input.** The setting is `prefersReducedMotion` — "Reduce or disable
animations for accessibility" — and it is the **first layer's** settings key, so it is
data this implementation has to speak to and not a name of its own. The motion system
takes it as an **input** to the detection rather than reading the settings document
itself: the settings loader is the configuration's business, and a terminal capability
that read a file to find out whether it may draw a frame would be doing the
configuration's work in the drawing's path.

**Implementation choice — the reason for a terminal that cannot draw names the terminal,
not the motion.** "the output is not an interactive terminal, so no frame can be drawn" is
one reason for the whole system rather than one reason per motion, because the thing
that is missing is a terminal and not a particular animation. The **per-motion** question
("can this motion be drawn here?") has no separate answer in this milestone: every one
of the seven motions is drawn in roles and styles that every terminal has, so the
system-level record is the whole of it. §7 names what would change that.

---

## 4. The renderer — one drawer

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| one drawer | "There is one function that turns a motion into a picture" | `drawMotion` (from the motion and the time) and `drawFrame` (from a frame) — and they must agree | `the renderer › draws the same picture in two places` |
| the output | "the first layer's own `Segment[]`" | the render's `segments` are the first layer's own `Segment[]`, carrying **roles** and **styles** and never a colour literal | `the motion system sits on the first layer › draws the first layer's own segment shape`; `the renderer › writes no colour of its own` |
| the roles | "the content's own role keeps it" | `contentSegments` fills in the request's role only where the content has none | `the renderer › keeps a segment's own role, and fills in the ones that have none` |
| the fade | "the segments are drawn `dim` when the opacity is below 1" | the coarse form, and the render still carries the **exact** opacity | `the renderer › draws the fade as the dim style below the full opacity` |
| the shimmer | "**each character** … in its own role or in that role's **shimmer partner**" | the light travels **per character**, across the whole content, and a lit character is drawn in the theme's own partner role | `the renderer › draws the shimmer per character, in the theme's own roles`; `… › finds the theme's underscored shimmer partner too` |
| the blink | "the **text** is replaced by **spaces of the same length**" | the layout holds: the text is spaces, the role and the styles stay | `the renderer › draws the blink as spaces of the same length`; `… › keeps the layout when the content is not visible` |
| the slide | "the movement is a **layout** matter, and the render carries the `offset`" | the render carries the offset in whole lines, and the segments are untouched | `the renderer › carries the slide's offset for the surface to apply` |

**Implementation choice — the fade is drawn as `dim`, and the exact opacity is carried
beside it.** A terminal cannot blend one colour into another, so the specification's
coarse form is the `dim` style: the idiom every terminal has. The frame's **exact**
opacity is carried in the render, so a surface that can blend may draw it finer and the
motion is not faked — the picture is what the terminal can draw, and the number is what
the motion says.

---

## 5. The frame budget, and the input

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the budget | "at most one frame every 33 milliseconds" | the scheduler's `tick` draws **at most one** frame, and **no** frame when the index has not moved | `the frame budget › draws at most one frame per tick` |
| the input first | "a tick that finds an **input waiting** draws **nothing** and yields to it" | `notifyInput()` — the next tick draws nothing and the input is waited for, not lost | `the frame budget › yields to the input` |
| the dropped frames | "a slow frame **drops** the frames it missed rather than queueing them" | the frame's time comes from the clock, so a tick that arrives late draws the frame the index names and **one** frame, not the fifteen that were missed | `the frame budget › drops the frames a slow frame missed, rather than queueing them` |
| no drift | the picture is the frame the index names | the scheduler draws at the **quantised** time, and the test compares the drawn frames with the frames asked for | `the frame budget › takes the time from the clock, so the picture does not drift` |

---

## 6. The rules the layer keeps

| the rule | how it is kept | the test |
|---|---|---|
| **One vocabulary.** | one table of motions, one table of easings, one table of durations and one frame interval; a surface asks for a motion by name and there is nothing else to ask for | `the motion vocabulary › names the seven motions, and the table holds nothing else`; `the motion system sits on the first layer › has one vocabulary, and the module exports one table of motions` |
| **The same motion renders identically wherever it is used.** | there is **one** drawer, and the test draws the same motion in **two** places — the direct draw and the frame the scheduler produced — and compares the pictures | `the renderer › draws the same picture in two places` |
| **What cannot be drawn is not drawn.** | the capability is off, the motion's resting frame is drawn, **no** frame is scheduled, and the reason is reported in the shared shape | `the degradation › draws the resting picture when the capability is off`; `… › draws nothing at all when the capability is off` |
| **Never fake success.** | there is no third thing: a motion is drawn, or it is not drawn and the reason is reported. A capability that is enabled carries no reason, and one that cannot run carries a sentence — the pair is built by the protocol's own `capabilityRecord`, so a record that breaks the contract cannot be built | `the terminal capability › carries the shared pair, and the reason is a sentence`; `the degradation › does not draw the animation of a motion that is not drawn` |
| **Motion never blocks the input.** | the tick yields to a waiting input, and the time comes from the clock so a slow frame drops frames rather than queueing them | `the frame budget › yields to the input`; `… › drops the frames a slow frame missed, rather than queueing them` |
| **The motion is deterministic.** | the frame reads no clock and keeps no counter, and the time is quantised to the frame index | `the frame › is the same frame whether it is stepped to or asked for`; `… › gives the same frame to two times inside one frame interval` |
| **The first layer is not disturbed.** | the system reads the theme's roles and the first layer's `Segment` shape, and writes **no colour of its own**; nothing under `src/ui/render/` or `src/ui/app.ts` changed, and the first layer's own tests pass unchanged | `the motion system sits on the first layer › uses the theme's own roles, and writes no colour of its own`; `the renderer › writes no colour of its own` |
| **A caller-supplied key is guarded.** | the motion's name and the easing's name come from a caller, and `Object.prototype` carries members called `constructor` and `toString`; both lookups are `Object.hasOwn`, and a name that is not in the table is **refused** | `the motion vocabulary › refuses a name that is not in the table, rather than answering with something else` |
| **The naming rule.** | the layer names the capability — a motion, a frame, a capability — and no product and no company | `tests/contracts/naming.test.ts` |

---

## 7. What was not done, and why

| what | why |
|---|---|
| the **surfaces** — the prompt, the transitions, the stage changes and the overlays | they are `CC-048`'s. This milestone builds the system they will use, and the vocabulary names the motion each of them will ask for |
| the **golden frames** | a frame is deterministic, so a golden *can* be recorded; recording one is `CC-048`'s and `CC-050`'s |
| the **pipeline**'s stage advance | the event is `CC-045`'s and the pipeline is another implementer's in flight. The motion's **name** is here — `stage-advance` — and the drawing of it is `CC-048`'s |
| the **first layer's own spinner** and its shimmer | they are the target's, and they are pinned by the first layer's own tests. The motion system does not define a second spinner, and it does not touch the theme's spinner frames |
| a **per-motion** capability record | every one of the seven motions is drawn in roles and styles that every terminal has, so the system-level record is the whole of the answer. A per-motion record would become necessary the moment a motion needed something a terminal might not have — a colour blend, say — and the specification would then name what it needs |
| the **colour depth** of the terminal | the motion system writes no colour, so it has no use for the depth. It is the theme's business, and the theme's roles are the theme's own |
| a **compatibility row** for the motion surface | a divergence is not a compatibility claim. The target's counterpart is the first layer's terminal surface, measured in `docs/compatibility/feature-matrix.md` |

---

## 8. The readings, in one place

1. **The direction of a motion is carried by three frames** — a start, an end and a
   resting one — rather than by a reversal flag. §1.
2. **The reduced-motion preference is an input to the detection**, not something the
   motion system reads out of the settings document. §3.
3. **The reason for a terminal that cannot draw names the terminal**, and there is one
   reason for the whole system rather than one per motion. §3.
4. **The fade is drawn as `dim`**, and the exact opacity is carried beside it. §4.
5. **The shimmer falls back to the theme's `text` role** for a role with no partner, and
   the theme's partner pairs are followed as the theme names them. §1.
6. **A per-motion capability record is not needed yet**, and what would make it needed
   is named. §7.

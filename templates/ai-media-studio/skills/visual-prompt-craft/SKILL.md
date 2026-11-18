---
name: visual-prompt-craft
description: Write paste-ready prompts for AI image and video tools — lens and camera language, lighting patterns, composition, style dialects, negative prompts, and consistency anchors for characters and shots.
---

# Visual Prompt Craft

The craft reference behind every visual prompt this studio ships. Use it when turning a scene brief into text an image or video tool can render: subject → action → setting → light → style → quality tags, in that order. Most tools weight the head of the prompt, so put the thing you cannot afford to lose first.

## Camera language

- **Shot size**: extreme wide, wide, medium, close-up, insert. Say which one; "cinematic" says none.
- **Angle**: eye level, low angle, high angle, overhead, dutch, over-the-shoulder, aerial. The angle is the subtext.
- **Lens**: 24mm wide and immersive, 35mm natural and reportage-like, 50mm neutral, 85mm portrait compression, macro for inserts, anamorphic for flare and scope. Specific glass beats adjectives.
- **Depth of field**: shallow to isolate a face, deep to hold a whole room. Name the falloff ("f/1.4 separation", "deep focus").

## Lighting

Name exactly one light idea per prompt — two compete and tools average them into mush.

- **Direction**: soft key from a window, hard noon shadow, backlit silhouette, rim light on wet hair.
- **Quality**: overcast softbox, hard practical, bounced fill, single source in darkness.
- **Temperature and color**: golden hour, cold fluorescent, neon spill, candle warmth against blue night.
- **Motivated sources**: a lantern, a monitor, a streetlight through blinds — light with a reason in the scene.

## Composition and frame

- **Framing**: rule of thirds, centered symmetry, negative space ahead of the subject, tight claustrophobic crop.
- **Aspect ratio**: 16:9 broadcast, 2.39:1 scope, 1:1 square, 9:16 vertical — name it and write to that frame (a 2.39:1 brief described as a tight portrait wastes the sides).
- **Leading elements**: foreground occlusion, reflections, layered depth — these are what make a frame feel directed rather than described.

## Style dialects

Anchor every prompt to an aesthetic, then add one or two texture words:

- **Film and photo**: 70s film stock, 90s VHS, halation and light leaks, silver-halide grain, tungsten push.
- **Illustration and paint**: watercolor animation, cel-shaded anime, ink wash, Renaissance chiaroscuro, gouache texture.
- **Rendered and stylized**: photoreal PBR, low-poly, claymation, papercraft, isometric diorama.
- **Texture words**: film grain, bloom, chromatic aberration, halation, shallow depth of field, dust motes in light.

One dialect per prompt. Mixing "photoreal" with "watercolor animation" asks the tool to guess.

## Negative prompts

Always ship one. Keep out what tools commonly leak in:

- anatomy: extra limbs, extra fingers, deformed hands, warped faces
- artifacts: text, watermarks, logos, UI overlays, compression blockiness
- style drift: flat lighting, oversaturated color, plastic skin, cartoon when photoreal was asked
- scene leaks: modern objects in a period frame, crowd clones, background faces melting

## Consistency anchors

- Reuse character wording **verbatim** between shots — the same adjective order every time ("lean lighthouse keeper, salt-stained wool coat, brass lantern"). Re-describing a face differently is how casts drift.
- Repeat the style dialect and texture words verbatim across a sequence.
- Change **one dimension at a time** for variants: lens OR light OR mood — never all three, or you can't tell what caused the change.
- Keep the seed when the tool supports it, and say so in the prompt's tool notes.
- Carry the Story Bible's palette words through every prompt in the piece.

## Motion notes (video)

When the scene moves, append: subject motion, camera move (push-in, pan, crane, static), pacing, and a duration in seconds. One move per shot — a slow push-in with a whip pan and a dutch roll is three shots.

## Tool notes

Finish with the settings a paste needs: aspect ratio, seed, step or strength hints, and anything the tool must be told twice. You write prompts — you never call the tool yourself.

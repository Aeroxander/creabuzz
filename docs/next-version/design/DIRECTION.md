# Design direction for the new web app

Chosen by the owner on 17 November 2026 from the options page in this folder
(`type-and-buttons-options.html`, option F as last revised). The owner's words along the way: A was liked because
"everything was very clear and noticeable"; C's press animation was improved on request; F was asked to be "more
gradient", with "darker purple", and the green "a bit darker, same as the Creaton icon".

**Colours.** Keep the existing scheme. Surfaces that carry the brand use a gradient from dark purple
(`hsl(266 66% 13%)`) through `hsl(266 62% 24%)` and violet (`hsl(262 60% 40%)`) to a blue edge (`hsl(210 55% 42%)`),
with a violet glow top left and a green glow bottom right. The green is the Creaton mark's gradient green `#63c88e`
(button shading down to `#47a873`; light tint `#86d6a8` for green text on dark). Text on the gradient is white,
secondary text `hsl(262 45% 87%)`.

**Type.** Geist for headlines and text (headlines bold, tight letter-spacing), Geist Mono for every number that
lines up (money, counts, dates in tables).

**Glass.** Fields, chips, progress bars and outline buttons are frosted panes on the gradient: white at 12% to 22%,
a light border, `backdrop-filter: blur(14px) saturate(1.5)`.

**Buttons.** 48 px tall (40 px small), 12 px corners, 16 px semibold text. The main action is solid glossy green
(`#63c88e` to `#47a873`) with dark ink text. Press: the button scales to 96.5% in about 70 ms and springs back in
about 300 ms with a small overshoot; reduced motion turns it off. One green button per screen.

**Open points to settle in the build.** Option H (2 px bright borders and a hard bottom edge on F) was shown as a
bolder variant and not chosen; long reading surfaces (an update, a task) may need a calmer plain card on top of the
gradient for legibility; dark and light mode both render the gradient surfaces the same.

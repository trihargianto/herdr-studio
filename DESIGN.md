# Studio design guidance

Use Emil Kowalski’s `emil-design-eng` skill for interface polish:
https://github.com/emilkowalski/skills/blob/main/skills/emil-design-eng/SKILL.md

The installed skill is available at `~/.agents/skills/emil-design-eng/SKILL.md` and has been read. Follow it for Studio interface work, adapting web-specific examples to Herdr’s native GPUI APIs.

Apply its design intent through native GPUI, using the shipped type declarations as the API authority. CSS, React, and browser animation libraries do not apply to Herdr mods.

- Frequent navigation and status-filter updates stay instant.
- Controls have immediate native press feedback and accessible labels.
- Truncated identifying text has a full-text tooltip.
- Colors follow the user’s theme; spacing and hierarchy remain consistent.
- Keep keyboard interactions free of decorative animation.
- Review findings in a Before / After / Why table.

The first pass adds button press states, pointer cursors, accessible control labels, full-text tooltips, and singular agent counts to the existing dashboard.

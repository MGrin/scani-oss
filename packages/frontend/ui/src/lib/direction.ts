/**
 * The class that mirrors a *navigational* icon under `dir="rtl"` (SC-760).
 *
 * Logical CSS properties mirror boxes; they do nothing to a glyph. A back
 * button drawn with `ArrowLeft` still points left in an Arabic layout, where
 * left is the direction the reader is travelling *towards* — so the one
 * control whose entire job is to say "backwards" says "forwards" instead.
 * Nothing about that is visible in a diff of class names, which is why it is
 * named here rather than left to a `rtl:-scale-x-100` scattered across a dozen
 * call sites.
 *
 * **Navigational, not semantic.** Mirror an icon whose meaning is a direction
 * of TRAVEL through the interface — back, forward, the chevron on a row that
 * opens something. Do NOT mirror one whose meaning is a direction in the
 * world: the up-right and down-left arrows on money leaving and arriving
 * (`UpcomingFeed`, `ExpectedIncome`) encode outflow and inflow, and flipping
 * them would change what they claim rather than where they point. That call is
 * a product one and is deliberately not made here.
 *
 * `-scale-x-100` rather than swapping the component for its opposite: one
 * class, no second import at each site, and it cannot drift out of step with
 * the document direction the way a hand-picked pair can.
 */
export const MIRROR_IN_RTL = 'rtl:-scale-x-100';

# hermes-foundry

Foundry: a 3D workspace to see and operate the Hermes software factory (hackathon entry). Private until mk publishes.

## Desktop pane

The `/foundry` pane lives in `desktop/`. `desktop/plugin.js` is the committed build and is
built from `desktop/src/plugin.ts` only:

    cd desktop && node scripts/build.mjs src/plugin.ts plugin.js

`desktop/src/probe.ts` is a development-only integration probe. It is not imported by
`plugin.ts` and is not in the product bundle.

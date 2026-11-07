// The shared Hermes pane types its element factory loosely (`type: unknown`), which the strict React typings reject.
// Type-check only: this plugin's own files use createElement, so none of them depends on these loose signatures.
export function jsx(type: any, props: any, key?: any): any
export function jsxs(type: any, props: any, key?: any): any
export const Fragment: any

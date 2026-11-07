// Test-only: react-dom is a devDependency for the mounted-pane test and ships no types here.
declare module 'react-dom/client' {
  export interface Root { render(el: unknown): void; unmount(): void }
  export function createRoot(el: Element): Root
}

declare module '*?raw' { const text: string; export default text }

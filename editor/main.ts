// Phase 0 placeholder for the dev-only graph editor (built in Phase 2). This page is
// served by Vite in dev at /editor/ and is excluded from the production build.
const root = document.querySelector<HTMLDivElement>('#editor')!
root.innerHTML = `
  <main style="font-family: system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1.5rem;">
    <h1>DukeMaps — Editor</h1>
    <p style="color:#666">Dev-only graph editor. Built in Phase 2; this is the Phase 0 placeholder.</p>
  </main>
`

// Phase 0 placeholder. The real app — MapLibre basemap, the algorithm "show", and the
// route UI — is built in Phases 1-7. This just proves `npm run dev` boots and renders.
const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <main style="font-family: system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1.5rem;">
    <h1>DukeMaps</h1>
    <p>Walking directions across Duke's campus — watch the routing algorithms work.</p>
    <p style="color:#666">Phase 0 scaffold. The map and the show arrive in later phases.</p>
  </main>
`

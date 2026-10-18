// Apply the saved theme before first paint so dark mode never flashes light.
// A separate file, not inline, so the Content-Security-Policy can forbid inline scripts.
try {
  var saved = JSON.parse(localStorage.getItem('nola-transit-live:preferences:v1') || '{}').theme;
  var dark = saved === 'dark' || (saved !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch {
  // Storage blocked: the app sets the theme itself once it loads.
}

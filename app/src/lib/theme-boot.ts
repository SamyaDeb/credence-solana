// Shared by the root layout's pre-paint script (server) and lib/theme.ts (client).
export const THEME_KEY = 'credence.theme';

/** Runs before first paint (inlined into the root layout): applies a stored light / dark choice, so no flash. */
export const THEME_BOOT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

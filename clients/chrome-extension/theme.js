// Classic, not a module, so it runs before the first paint: the console's
// theme script without the cookie, following the system setting live.
(() => {
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const apply = () =>
    document.documentElement.classList.toggle("dark", dark.matches);
  apply();
  dark.addEventListener("change", apply);
})();

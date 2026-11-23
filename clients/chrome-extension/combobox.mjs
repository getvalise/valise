/**
 * The APG editable combobox with list autocomplete, for a text field and the
 * `ul` below it. `offered()` is read on every open, so a caller that removes
 * chosen values from it sees them go. `onPick` gets the active option's value
 * or the typed text, so a value not offered is created rather than refused.
 * https://www.w3.org/WAI/ARIA/apg/patterns/combobox/examples/combobox-autocomplete-list/
 */
export function combobox(input, list, { offered, onPick, max = 8 }) {
  let matches = [];
  let active = -1;

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-expanded", "false");
  list.setAttribute("role", "listbox");
  list.hidden = true;

  const optionId = (index) => `${list.id}-${index}`;

  function render() {
    const open = matches.length > 0;
    list.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    if (open && active >= 0)
      input.setAttribute("aria-activedescendant", optionId(active));
    else input.removeAttribute("aria-activedescendant");
    list.replaceChildren(
      ...matches.map((value, index) => {
        const option = document.createElement("li");
        option.id = optionId(index);
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(index === active));
        if (index === active) option.className = "active";
        option.textContent = value;
        // mousedown, not click: it comes before the input's blur closes the list.
        option.addEventListener("mousedown", (event) => {
          event.preventDefault();
          pick(value);
        });
        option.addEventListener("mousemove", () => {
          if (active === index) return;
          active = index;
          render();
        });
        return option;
      }),
    );
    if (active >= 0)
      list.children[active]?.scrollIntoView({ block: "nearest" });
  }

  function open() {
    const query = input.value.trim().toLowerCase();
    matches = offered()
      .filter((value) => value.toLowerCase().includes(query))
      .slice(0, max);
    active = -1;
    render();
  }

  function close() {
    matches = [];
    active = -1;
    render();
  }

  function pick(value) {
    close();
    onPick(value);
  }

  function move(step) {
    if (!matches.length) open();
    if (!matches.length) return;
    active =
      active < 0 && step < 0
        ? matches.length - 1
        : (active + step + matches.length) % matches.length;
    render();
  }

  input.addEventListener("focus", open);
  input.addEventListener("input", open);
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Enter":
        event.preventDefault();
        pick(active >= 0 ? matches[active] : input.value.trim());
        break;
      case "Escape":
        event.preventDefault();
        if (matches.length) close();
        else input.value = "";
        break;
      case "Tab":
        close();
        break;
      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End":
        // Visual focus returns to the textbox; the caret moves as usual.
        if (active < 0) break;
        active = -1;
        render();
        break;
    }
  });

  return { close };
}

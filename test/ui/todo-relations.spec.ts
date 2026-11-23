import { expect, mcp, test, goto as visit } from "./fixtures/session";

for (const javaScriptEnabled of [true, false])
  test(`relation forms preserve hierarchy/dependency semantics with scripting ${javaScriptEnabled ? "on" : "off"}`, async ({
    browser,
    request,
  }) => {
    const marker = crypto.randomUUID().slice(0, 8);
    const make = async (title: string) =>
      (
        await mcp(request, "create_todo", {
          title: `${title} ${marker}`,
          project: `relations-${marker}`,
        })
      ).id as string;
    const parent = await make("Parent");
    const child = await make("Child");
    const prerequisite = await make("Prerequisite");
    const context = await browser.newContext({
      javaScriptEnabled,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const goto = (path: string) => visit(page, path, javaScriptEnabled);
    const href = `/todos?project=relations-${marker}&open=${encodeURIComponent(child)}`;
    await goto(href);
    const pane = page.getByRole("dialog", {
      name: `Child ${marker}`,
      exact: true,
    });
    // One "Add relation" line opens a centred modal: the type, then the
    // to-do. Scripted, both are the console's pickers and the line opens the
    // modal as state; without scripting the line is a link to `?edit=`, and
    // the modal holds a select and a text box that takes a pasted id.
    const modal = page.getByRole("dialog", { name: "Add a relation" });
    const relate = async (type: string, label: string, id: string) => {
      await pane
        .getByRole("link", { name: "Add relation", exact: true })
        .click();
      await expect(modal).toBeVisible();
      if (javaScriptEnabled) {
        expect(page.url()).not.toContain("edit=");
        await modal.getByRole("combobox", { name: "Relation" }).click();
        await modal
          .getByRole("option", { name: new RegExp(`^${label}\\b`) })
          .click();
        await modal.getByRole("combobox", { name: "To-do" }).fill(id);
        await modal
          .getByRole("option", { name: new RegExp(id.slice(5, 17)) })
          .click();
      } else {
        expect(page.url()).toContain("edit=");
        await modal
          .getByRole("combobox", { name: "Relation" })
          .selectOption(type);
        await modal.getByLabel("To-do", { exact: true }).fill(id);
      }
      await modal
        .getByRole("button", { name: "Add relation", exact: true })
        .click();
      // A landed relation closes the modal back to the pane, where it is listed.
      await expect(modal).toHaveCount(0);
    };
    const remove = (label: string) =>
      pane.getByRole("button", { name: label, exact: true });

    await relate("parent", "Parent", parent);
    await expect(remove(`Remove parent Parent ${marker}`)).toBeVisible();
    await relate("blocked-by", "Blocked by", prerequisite);
    await expect(
      remove(`Remove blocked by Prerequisite ${marker}`),
    ).toBeVisible();
    // Claim gating on prerequisites is test/d1's coordinator suite; this
    // checks only that the form wrote the relation.
    expect(
      (await mcp(request, "fetch", { id: child })).metadata.relations.parent.id,
    ).toBe(parent);
    await remove(`Remove blocked by Prerequisite ${marker}`).click();
    await expect(
      remove(`Remove blocked by Prerequisite ${marker}`),
    ).toHaveCount(0);
    await remove(`Remove parent Parent ${marker}`).click();
    await expect(remove(`Remove parent Parent ${marker}`)).toHaveCount(0);
    // A child is written on the other to-do: its parent becomes this one.
    await relate("child", "Child", prerequisite);
    await expect(remove(`Remove child Prerequisite ${marker}`)).toBeVisible();
    expect(
      (await mcp(request, "fetch", { id: prerequisite })).metadata.relations
        .parent.id,
    ).toBe(child);
    // Recovery is offered only when something says a relation write is
    // pending (P15, ADR-0018). An interrupted D1 write cannot be staged from
    // here, so a blocker carrying the coordinator's words stands in for it.
    const reconcile = pane.getByRole("button", {
      name: "Reconcile relations",
      exact: true,
    });
    await expect(reconcile).toHaveCount(0);
    const claim = await mcp(request, "claim_todo", { id: child });
    await mcp(request, "update_todo", {
      id: child,
      token: claim.token,
      blocked_on: `relation write outcome unknown for ${child}; reconcile relations, inspect the result, then retry if needed`,
    });
    await expect
      .poll(
        async () =>
          (await mcp(request, "fetch", { id: child })).metadata.state as string,
      )
      .toBe("blocked");
    await goto(href);
    await reconcile.click();
    await expect(pane.getByRole("status")).toContainText(
      "no edit was replayed",
    );
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    ).toBe(true);
    await context.close();
  });

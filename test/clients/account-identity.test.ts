import { createElement, Fragment } from "react";
import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { AppSidebar } from "../../app/components/app-sidebar";
import { AccountGreeting } from "../../app/components/ui";
import { SidebarProvider } from "../../app/components/ui/sidebar";
import { identityLabel } from "../../app/concepts/identity-label";

describe("the signed-in identity", () => {
  it.each([
    ["owner", "owner", true],
    ["admin", "member", true],
    ["member", "member", false],
  ] as const)(
    "uses the same %s account name in greeting and sign-out navigation",
    (kind, role, admin) => {
      const identity = {
        userId: kind === "owner" ? "local" : "usr_alice",
        displayName: "Alice <trusted account>",
        email: "alice@example.com",
        role,
        admin,
      };
      const router = createMemoryRouter(
        [
          {
            id: "root",
            path: "/",
            loader: () => ({ identity }),
            element: createElement(
              Fragment,
              null,
              createElement("p", null, createElement(AccountGreeting)),
              createElement(SidebarProvider, null, createElement(AppSidebar)),
            ),
          },
        ],
        { hydrationData: { loaderData: { root: { identity } } } },
      );
      const html = renderToString(createElement(RouterProvider, { router }));
      expect(html).toContain("Hello, <!-- -->Alice &lt;trusted account&gt;");
      expect(html).toMatch(
        /<a [^>]*title="alice@example.com"[^>]* href="\/account"[^>]*>[\s\S]*?<span>Alice &lt;trusted account&gt;<\/span><\/a>/,
      );
      expect(html).not.toContain("Signed in as");
      expect(html).not.toContain("usr_alice");
      expect(html.includes('href="/people"')).toBe(admin);
      if (admin)
        expect(html).toContain(kind === "owner" ? ">Owner<" : ">Admin<");
      router.dispose();
    },
  );

  it("uses stored email or role without fabricating a name from the local id", () => {
    expect(
      identityLabel({
        displayName: " ",
        email: "alice@example.com",
        role: "member",
      }),
    ).toBe("alice@example.com");
    expect(identityLabel({ displayName: "", email: null, role: "owner" })).toBe(
      "Owner",
    );
    expect(
      identityLabel({ displayName: "", email: null, role: "member" }),
    ).toBe("Member");
    expect(
      identityLabel({
        displayName: "",
        email: null,
        role: "member",
        admin: true,
      }),
    ).toBe("Admin");
  });
});

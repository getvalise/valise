import { useEffect, useState } from "react";
import { Form, NavLink, useLocation, useRouteLoaderData } from "react-router";
import { Icon, type IconName } from "~/components/icon";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "~/components/ui/sidebar";
import { identityLabel } from "~/concepts/identity-label";
import type { ConsoleIdentity } from "~/console/context.server";

type Page = { to: string; label: string; icon: IconName };

const WORKSPACE_PAGES: Page[] = [
  { to: "/todos", label: "To-dos", icon: "todos" },
  { to: "/memories", label: "Memories", icon: "memory" },
  { to: "/skills", label: "Skills", icon: "skills" },
  { to: "/library", label: "Library", icon: "library" },
  { to: "/activity", label: "Activity", icon: "activity" },
  { to: "/connections", label: "Connections", icon: "connections" },
  { to: "/hooks", label: "Hooks", icon: "hooks" },
];

/** The admin pages, after the shared ones. ADR-0016. */
const ADMIN_PAGES: Page[] = [
  { to: "/workbench", label: "Workbench", icon: "workbench" },
  { to: "/people", label: "People", icon: "people" },
];

/**
 * The icon for the page at `pathname`: its sidebar entry's, so a page's title
 * and its place in the sidebar carry the same mark. Sub-pages take their
 * section's (/library/authors is Library).
 */
export function pageIcon(pathname: string): IconName | null {
  const pages = [
    ...WORKSPACE_PAGES,
    ...ADMIN_PAGES,
    { to: "/account", label: "Account", icon: "account" as IconName },
  ];
  return (
    pages.find(
      (page) => pathname === page.to || pathname.startsWith(`${page.to}/`),
    )?.icon ?? null
  );
}

export const THEME_COOKIE = "valise_theme";

/**
 * Runs before first paint, so a dark page never flashes light. A saved choice
 * wins; without one the page follows the system.
 */
export const THEME_SCRIPT = `(function(){var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=(dark|light)/);var d=m?m[1]==="dark":matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.classList.toggle("dark",d)})()`;

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    document.cookie = `${THEME_COOKIE}=${next ? "dark" : "light"}; path=/; max-age=31536000; samesite=lax`;
    setDark(next);
  };
  return (
    <SidebarMenuButton onClick={toggle} type="button">
      <Icon name={dark ? "light" : "dark"} />
      <span>{dark ? "Light mode" : "Dark mode"}</span>
    </SidebarMenuButton>
  );
}

function PinToggle() {
  const { open, toggleSidebar, isMobile } = useSidebar();
  if (isMobile) return null;
  return (
    <SidebarMenuButton
      aria-pressed={open}
      onClick={toggleSidebar}
      title="Keep the sidebar open (⌘B)"
      type="button"
    >
      <Icon name="sidebar" />
      <span>{open ? "Collapse sidebar" : "Keep open"}</span>
    </SidebarMenuButton>
  );
}

function PageLinks({ pages }: { pages: Page[] }) {
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      {pages.map((page) => (
        <SidebarMenuItem key={page.to}>
          <SidebarMenuButton
            asChild
            isActive={
              pathname === page.to || pathname.startsWith(`${page.to}/`)
            }
          >
            <NavLink onClick={() => setOpenMobile(false)} to={page.to}>
              <Icon name={page.icon} />
              <span>{page.label}</span>
            </NavLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

/**
 * The console's first level: an icon rail that opens over the page on hover
 * or focus, and can be pinned open. Account and theme sit at its foot.
 */
export function AppSidebar() {
  const root = useRouteLoaderData("root") as
    | { identity: ConsoleIdentity | null }
    | undefined;
  const identity = root?.identity ?? null;
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* One geometry in the rail and open, so the mark never moves. */}
            <SidebarMenuButton
              asChild
              className="masthead p-0! group-data-[collapsible=icon]:p-0!"
            >
              <NavLink to="/todos">
                <span className="masthead-mark">
                  <Icon name="valise" size={18} />
                </span>
                <span className="masthead-word">Valise</span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      {/* One landmark for pages and account; `contents` keeps the sidebar's
          column layout. */}
      <nav aria-label="Workspace" className="contents">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarGroupContent>
              <PageLinks pages={WORKSPACE_PAGES} />
            </SidebarGroupContent>
          </SidebarGroup>
          {identity?.admin ? (
            <SidebarGroup>
              <SidebarGroupLabel>
                {identity.role === "owner" ? "Owner" : "Admin"}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <PageLinks pages={ADMIN_PAGES} />
              </SidebarGroupContent>
            </SidebarGroup>
          ) : null}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <ThemeToggle />
            </SidebarMenuItem>
            <SidebarMenuItem>
              <PinToggle />
            </SidebarMenuItem>
            {identity ? (
              <SidebarMenuItem>
                <SidebarMenuButton asChild>
                  <NavLink title={identity.email ?? undefined} to="/account">
                    <Icon name="account" />
                    <span>{identityLabel(identity)}</span>
                  </NavLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ) : null}
            <SidebarMenuItem>
              <Form action="/logout" method="post">
                <SidebarMenuButton type="submit">
                  <Icon name="signOut" />
                  <span>Sign out</span>
                </SidebarMenuButton>
              </Form>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </nav>
    </Sidebar>
  );
}

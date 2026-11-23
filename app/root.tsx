import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import { THEME_SCRIPT } from "~/components/app-sidebar";
import { PANE_WIDTH_SCRIPT } from "~/components/modal";
import { consoleIdentity } from "~/console/context.server";
import type { Route } from "./+types/root";

/**
 * Who is signed in, for every page's shell. One query per request, so the
 * strap can name the person and offer the owner's pages without each route
 * asking again. ADR-0016.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const cookie = request.headers.get("Cookie") ?? "";
  return {
    identity: await consoleIdentity(context, request),
    // Pinned open by the sidebar's own cookie; collapsed to icons otherwise.
    sidebarOpen: /(?:^|;\s*)sidebar_state=true/.test(cookie),
  };
}

/**
 * The stylesheet is a static asset at a fixed path rather than a bundled
 * import, because the OAuth consent page is plain HTML built in the Worker and
 * has to link the same tokens.
 */
export const links: Route.LinksFunction = () => [
  { rel: "stylesheet", href: "/valise.css" },
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  { rel: "manifest", href: "/manifest.webmanifest" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    // The theme and pane-width scripts set the root before hydration.
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* The pane's chosen width, before the first paint, so it never moves. */}
        <script dangerouslySetInnerHTML={{ __html: PANE_WIDTH_SCRIPT }} />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <meta name="theme-color" content="#482971" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Valise" />
        <Meta />
        <Links />
      </head>
      <body>
        <main className="shell">{children}</main>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message = isRouteErrorResponse(error)
    ? error.statusText || "Request failed"
    : "Unexpected error";

  return (
    <section className="card auth-card">
      <p className="eyebrow">Valise</p>
      <h1>{status}</h1>
      <p className="muted">{message}</p>
      <p>
        <a href="/todos">Back to the workspace</a>
      </p>
    </section>
  );
}

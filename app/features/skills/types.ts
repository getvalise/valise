import type { loader } from "~/console/skills.server";
export type Skill = NonNullable<Awaited<ReturnType<typeof loader>>["detail"]>;
export type Preview = NonNullable<
  Awaited<ReturnType<typeof loader>>["preview"]
>;
export type AddRoute = "search" | "write" | "url";
export type GithubPreview = NonNullable<
  Awaited<ReturnType<typeof loader>>["github"]
>;
export type Listing = NonNullable<
  Awaited<ReturnType<typeof loader>>["githubList"]
>;

/** A name from the signed-in account, never a request header or tenant id. */
export function identityLabel(identity: {
  displayName: string;
  email: string | null;
  role: "owner" | "member";
  admin?: boolean;
}): string {
  return (
    identity.displayName.trim() ||
    identity.email ||
    (identity.role === "owner" ? "Owner" : identity.admin ? "Admin" : "Member")
  );
}

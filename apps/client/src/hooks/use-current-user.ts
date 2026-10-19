import { useQuery } from "@tanstack/react-query";

export type Role = "admin" | "editor" | "viewer";

export interface CurrentUser {
  username: string;
  role: Role;
  builtin: boolean;
  authEnabled: boolean;
}

/** The signed-in account. Permissions are enforced by the server; this only hides unusable actions. */
export function useCurrentUser() {
  const { data } = useQuery<CurrentUser>({ queryKey: ["/api/auth/me"], staleTime: 60_000 });
  const role = data?.role;
  return {
    user: data,
    isAdmin: role === "admin",
    // Until the role is known, keep editing controls visible rather than flickering them away.
    canEdit: role === undefined || role === "admin" || role === "editor",
  };
}

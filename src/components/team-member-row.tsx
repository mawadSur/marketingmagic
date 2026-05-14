"use client";

import { useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  changeRoleAction,
  removeMemberAction,
} from "@/app/(app)/settings/team/actions";

type MemberRole = "owner" | "editor" | "viewer";

export interface TeamMemberRowData {
  userId: string;
  email: string;
  role: MemberRole;
  joinedAt: string;
  isMe: boolean;
}

/**
 * One row in the /settings/team member list. Owners see role-change select +
 * remove button on every non-owner row. Viewers and editors see a read-only
 * row (the page-level guard already routes non-owners away, but the rendered
 * permissions check keeps the component honest if re-used.)
 */
export function TeamMemberRow({
  member,
  canManage,
}: {
  member: TeamMemberRowData;
  canManage: boolean;
}) {
  const [pending, start] = useTransition();
  const isOwner = member.role === "owner";

  const handleRemove = (formData: FormData) => {
    start(async () => {
      await removeMemberAction(formData);
    });
  };
  const handleRoleChange = (role: "editor" | "viewer") => {
    const fd = new FormData();
    fd.set("user_id", member.userId);
    fd.set("role", role);
    start(async () => {
      await changeRoleAction(fd);
    });
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {member.email}
          {member.isMe ? (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              (you)
            </span>
          ) : null}
        </p>
        <p className="text-xs text-muted-foreground">
          Joined {new Date(member.joinedAt).toLocaleDateString()}
        </p>
      </div>
      <div className="flex items-center gap-3">
        {canManage && !isOwner ? (
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={member.role}
            onChange={(e) => handleRoleChange(e.target.value as "editor" | "viewer")}
            disabled={pending}
            aria-label={`Change role for ${member.email}`}
          >
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
        ) : (
          <Badge variant={isOwner ? "info" : "muted"}>{member.role}</Badge>
        )}
        {canManage && !isOwner ? (
          <form action={handleRemove}>
            <input type="hidden" name="user_id" value={member.userId} />
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              disabled={pending}
              className="text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              Remove
            </Button>
          </form>
        ) : null}
      </div>
    </li>
  );
}

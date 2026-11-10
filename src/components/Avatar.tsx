import type { User } from "../lib/account";

export function Avatar({ user, size = 32 }: { user: Pick<User, "name" | "avatarHue">; size?: number }) {
  const initials = user.name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38, ["--h" as any]: user.avatarHue }}>
      {initials}
    </span>
  );
}

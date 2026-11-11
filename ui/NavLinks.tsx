"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
  /** How many rows the screen has, when that helps (the PM queue). */
  count?: number;
}
export interface NavGroup {
  name: string;
  items: NavItem[];
}

const isCurrent = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

/** The rail's navigation, grouped by who uses each screen. The page you are on is marked with aria-current. */
export function NavLinks({ groups }: { groups: NavGroup[] }) {
  const path = usePathname() ?? "/";
  // A back-charge's detail page belongs to the Inbox.
  const at = path.startsWith("/backcharge/") ? "/inbox" : path;
  return (
    <nav className="navlist" aria-label="Screens">
      {groups.map((g) => (
        <div key={g.name} className="navgroup">
          <div className="navgroup-name">{g.name}</div>
          {g.items.map((it) => (
            <Link key={it.href} href={it.href} className="navlink" aria-current={isCurrent(at, it.href) ? "page" : undefined}>
              <span>{it.label}</span>
              {it.count ? <span className="navcount">{it.count}</span> : null}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}

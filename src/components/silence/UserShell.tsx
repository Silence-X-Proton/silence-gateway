import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { LayoutDashboard, Activity, Cpu, KeyRound, LogOut, Menu, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { BrandLogo } from "@/components/silence/BrandLogo";

const NAV = [
  { to: "/user/dashboard", label: "Overview", icon: LayoutDashboard },
  { to: "/user/dashboard", label: "API Keys", icon: KeyRound, tab: "keys" },
  { to: "/user/dashboard", label: "Usage", icon: Activity, tab: "usage" },
  { to: "/user/dashboard", label: "Models", icon: Cpu, tab: "models" },
] as const;

export function UserShell({ children, email }: { children: ReactNode; email?: string }) {
  const loc = useLocation();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function signOut() {
    await supabase.auth.signOut();
    router.navigate({ to: "/user", replace: true });
  }

  const SidebarInner = (
    <>
      <Link to="/user/dashboard" onClick={() => setOpen(false)} className="mb-5 flex items-center gap-2.5 px-2 py-1">
        <BrandLogo className="h-9 w-9" />
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold tracking-tight">Silence<span className="text-[color:var(--brand)]">API</span></span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">User Portal</span>
        </div>
      </Link>
      <nav className="flex flex-1 flex-col gap-0.5">
        {NAV.map((n) => {
          const active = loc.pathname === n.to; // In a real app we might handle tabs better, but for now this is fine
          return (
            <Link key={n.label} to={n.to} onClick={() => setOpen(false)}
              className={cn(
                "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition",
                active
                  ? "bg-[color:var(--brand-soft)] text-[color:var(--brand-strong)] shadow-sm ring-1 ring-[color:var(--brand)]/12"
                  : "text-muted-foreground hover:bg-[color:var(--brand-soft)]/60 hover:text-foreground",
              )}
            >
              <n.icon className={cn("h-4 w-4", active && "text-[color:var(--brand)]")} />
              {n.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-3 border-t border-[color:var(--hairline)] pt-3">
        {email && (
            <div className="mb-2 px-3 text-[10px] text-muted-foreground truncate">{email}</div>
        )}
        <button onClick={signOut} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive">
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </>
  );

  return (
    <div className="min-h-screen bg-background text-foreground transition-colors duration-300">
      <div aria-hidden className="pointer-events-none absolute inset-0 hero-grid opacity-30" />
      
      {/* Mobile top bar */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-[color:var(--hairline)] bg-background/85 px-4 py-3 backdrop-blur md:hidden">
        <Link to="/user/dashboard" className="flex items-center gap-2">
          <BrandLogo className="h-8 w-8" />
          <span className="font-semibold tracking-tight">Silence<span className="text-[color:var(--brand)]">API</span></span>
        </Link>
        <button aria-label="Toggle navigation" onClick={() => setOpen(true)} className="rounded-lg border border-[color:var(--hairline)] bg-card p-2 shadow-sm transition-colors hover:bg-accent">
          <Menu className="h-4 w-4" />
        </button>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
          <aside onClick={(e) => e.stopPropagation()} className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col border-r border-[color:var(--hairline)] bg-card p-4 shadow-2xl">
            <div className="mb-2 flex justify-end">
              <button onClick={() => setOpen(false)} className="rounded-lg border border-[color:var(--hairline)] p-2"><X className="h-4 w-4" /></button>
            </div>
            {SidebarInner}
          </aside>
        </div>
      )}

      <div className="mx-auto flex max-w-[1400px] gap-6 p-4 md:p-6">
        <aside className="sticky top-6 hidden h-[calc(100vh-3rem)] w-64 shrink-0 flex-col rounded-2xl border border-[color:var(--hairline)] bg-card/70 p-4 shadow-[var(--shadow-elegant)] backdrop-blur md:flex">
          {SidebarInner}
        </aside>
        <main className="relative min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2, ShieldCheck } from "lucide-react";
import { BrandLogo } from "@/components/silence/BrandLogo";

export const Route = createFileRoute("/user/")({
  head: () => ({
    meta: [
      { title: "User Sign In — Silence API" },
      { name: "description", content: "Sign in to manage your Silence API balance, usage, and keys." },
      { property: "og:title", content: "User Sign In — Silence API" },
      { property: "og:description", content: "Sign in to manage your Silence API balance, usage, and keys." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: UserLoginPage,
});

function UserLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const authResult = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      const authError = authResult?.error;
      if (authError) throw authError;

      const signedInUser = authResult?.data?.user;
      if (!signedInUser || !authResult?.data?.session) {
        throw new Error("Sign in succeeded but no session was returned. Please try again.");
      }

      const { data: profile, error: profileError } = await supabase.from("profiles")
        .select("suspended").eq("id", signedInUser.id).maybeSingle();

      if (profileError) {
        throw new Error(`Unable to verify your user account: ${profileError.message}`);
      }

      if (!profile) {
        await supabase.auth.signOut();
        throw new Error("Not a user account");
      }

      if (profile.suspended) {
        await supabase.auth.signOut();
        throw new Error("Your account is suspended.");
      }

      await router.navigate({ to: "/user/dashboard", replace: true });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Sign in failed";
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  if (!hydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="relative grid min-h-screen place-items-center px-4 py-10 bg-background text-foreground transition-colors duration-300">
      <div aria-hidden className="pointer-events-none absolute inset-0 hero-grid opacity-30" />
      <div className="relative w-full max-w-md z-10">
        <Link to="/" className="mb-6 flex items-center justify-center gap-2.5">
            <BrandLogo className="h-10 w-10" />
          <span className="text-xl font-semibold tracking-tight text-foreground">Silence<span className="text-[color:var(--brand)]">API</span></span>
        </Link>
        <div className="rounded-2xl border border-border bg-card/80 p-7 shadow-2xl backdrop-blur-xl transition-all">
          <div className="mb-5 text-center">
            <span className="brand-chip inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-medium text-[color:var(--brand-strong)]">User portal</span>
            <h1 className="mt-3 text-2xl font-bold tracking-tight text-foreground">Sign in to your account</h1>
            <p className="mt-1 text-sm text-muted-foreground">Track your balance, requests and API keys.</p>
          </div>
          <form onSubmit={onSubmit} className="space-y-4">
            <label className="block text-sm">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Email</span>
              <input type="email" autoComplete="username" required value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-primary/20" />
            </label>
            <label className="block text-sm">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Password</span>
              <input type="password" autoComplete="current-password" required value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary/50 focus:ring-2 focus:ring-primary/20" />
            </label>
            <button type="submit" disabled={busy}
              className="btn-primary inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 shadow-lg shadow-primary/20 transition-all hover:translate-y-[-1px] active:translate-y-[0px] relative z-30">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Sign in"}
            </button>
          </form>
        </div>
        <div className="mt-8 flex flex-col items-center gap-4">
          <Link
            to="/admin"
            className="text-xs font-medium text-muted-foreground transition-colors hover:text-primary underline underline-offset-4"
          >
            Switch to Admin Console
          </Link>
          <p className="text-center text-xs text-muted-foreground">Accounts are created by your admin.</p>
          <p className="flex items-center justify-center gap-1.5 text-center text-[11px] text-muted-foreground/60">
            <ShieldCheck className="h-3 w-3" /> Secure session protection
          </p>
        </div>
      </div>
    </div>
  );
}
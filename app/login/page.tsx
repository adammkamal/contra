import { redirect } from "next/navigation";
import { signedInAs } from "../../ui/api.ts";
import { Mark } from "../../ui/Bits.tsx";
import { safeNext } from "../../ui/session-cookie.ts";
import { SignInForm } from "../../ui/SignInForm.tsx";

export const dynamic = "force-dynamic";

/**
 * Sign in (FRONTEND_CONTRACT.md, "Signing in"). There is no sign-up: accounts are made on the server with
 * `npm run user:add`. `?ended=1` says the session ended; `?next=` is the screen to return to afterwards.
 */
export default async function Login({ searchParams }: { searchParams: Promise<{ ended?: string; next?: string }> }) {
  const q = await searchParams;
  const next = safeNext(q.next);
  // Already signed in (the API says so, not just a cookie being there): straight on.
  if (await signedInAs()) redirect(next);
  return (
    <div className="login">
      <main id="main" className="login-panel">
        <div className="brand">
          <Mark />
          <span className="brand-name">Contra</span>
        </div>
        <div className="page-head">
          <h1>Sign in</h1>
          <p className="sub">Back-charge credits for Ramp Bill Pay. Accounts are made by whoever runs Contra; there is no sign-up.</p>
        </div>
        {q.ended ? (
          <p className="card login-note" role="status" data-testid="session-ended">
            Your session has ended; sign in again.
          </p>
        ) : null}
        <SignInForm next={next} />
        <p className="disclosure">A hackathon concept built for Ramp. It is not a Ramp product, and every Ramp screen here is simulated.</p>
      </main>
    </div>
  );
}

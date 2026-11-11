"use client";
import { useActionState } from "react";
import { signIn, type SignInState } from "./actions.ts";

/**
 * Username and password, posted by the Next server to POST /api/login. The API's error words are shown as
 * they are; the username is kept and the password cleared (React resets the form after each answer, back to
 * these defaults). The button stays on "Signing in…" until the answer comes (the API slows repeated wrong
 * passwords down, up to 8 seconds), with no timeout of its own.
 */
export function SignInForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, { username: "" });
  return (
    <form action={action} className="card login-form" data-testid="sign-in-form">
      <input type="hidden" name="next" value={next} />
      <label className="field">
        Username
        <input name="username" defaultValue={state.username} autoComplete="username" autoCapitalize="none" spellCheck={false} required data-testid="sign-in-username" />
      </label>
      <label className="field">
        Password
        <input name="password" type="password" defaultValue="" autoComplete="current-password" required data-testid="sign-in-password" />
      </label>
      {state.error ? (
        <p className="err" role="alert" data-testid="sign-in-error">
          {state.error}
        </p>
      ) : null}
      <button type="submit" className="btn solid" disabled={pending} aria-busy={pending} data-testid="sign-in-submit">
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

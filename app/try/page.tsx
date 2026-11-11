import { TryPanel } from "../../ui/TryPanel.tsx";

export const dynamic = "force-dynamic";

export default function TryPage() {
  return (
    <>
      <div className="page-head">
        <h1>Try any email</h1>
        <p className="sub">Paste a back-charge email. Contra runs the real extraction and the same intake checks, and says what it would do. Nothing is saved.</p>
      </div>
      <TryPanel />
    </>
  );
}

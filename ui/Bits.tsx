import type { Status } from "../src/view.ts";

export const StatusWord = ({ s }: { s: Status }) => <span className={`status ${s.tone}`}>{s.label}</span>;
export const Badge = ({ children }: { children: React.ReactNode }) => <span className="badge">{children}</span>;
export const SimRamp = () => <Badge>Simulated Ramp</Badge>;

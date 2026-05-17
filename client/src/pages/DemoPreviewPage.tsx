import { useSearchParams } from "react-router-dom";
import { AnimatedDemo } from "../components/AnimatedDemo";

export default function DemoPreviewPage() {
  const [params] = useSearchParams();
  const phaseParam = params.get("phase");
  const revealedParam = params.get("revealed");

  const parseBounded = (raw: string | null, min: number, max: number): number | undefined => {
    if (raw === null) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    const i = Math.floor(n);
    if (i < min || i > max) return undefined;
    return i;
  };

  const forcePhase = parseBounded(phaseParam, 0, 5);
  const forceRevealedItems = parseBounded(revealedParam, 0, 6);

  return (
    <div className="w-screen h-screen bg-brand-bg p-6 flex items-center justify-center">
      <div className="w-full max-w-5xl aspect-video rounded-2xl overflow-hidden border border-brand-border shadow-2xl shadow-brand-green/10">
        <AnimatedDemo forcePhase={forcePhase} forceRevealedItems={forceRevealedItems} />
      </div>
    </div>
  );
}

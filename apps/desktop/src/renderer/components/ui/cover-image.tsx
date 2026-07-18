import { useEffect, useState, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { loadCoverDataUrl } from "../../lib/cover-cache";

export function CoverImage({ assetId, alt, className, fallback }: {
  assetId: string | null;
  alt: string;
  className?: string;
  fallback: ReactNode;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setDataUrl(null);
    if (!assetId) return;
    void loadCoverDataUrl(assetId).then((loaded) => {
      if (active) setDataUrl(loaded);
    });
    return () => {
      active = false;
    };
  }, [assetId]);

  if (!dataUrl) return <>{fallback}</>;
  return <img src={dataUrl} alt={alt} className={cn("h-full w-full object-cover", className)} />;
}

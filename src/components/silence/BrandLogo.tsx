// Brand logo is served LOCALLY from /public — no dependency on the Lovable
// asset CDN (its /__l5e/assets-v1 URLs 404 outside Lovable hosting, which is
// what used to leave dead/broken logo images everywhere).
import { cn } from "@/lib/utils";

const LOGO_SRC = "/branding/silence-gateway-logo.png";

type BrandLogoProps = {
  className?: string;
  alt?: string;
};

export function BrandLogo({ className, alt = "Silence Gateway logo" }: BrandLogoProps) {
  return (
    <img
      src={LOGO_SRC}
      alt={alt}
      className={cn("select-none object-contain", className)}
      draggable={false}
    />
  );
}

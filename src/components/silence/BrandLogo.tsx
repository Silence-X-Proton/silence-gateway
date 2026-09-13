import silenceGatewayLogo from "@/assets/branding/silence-gateway-logo.png.asset.json";
import { cn } from "@/lib/utils";

type BrandLogoProps = {
  className?: string;
  alt?: string;
};

export function BrandLogo({ className, alt = "Silence Gateway logo" }: BrandLogoProps) {
  return (
    <img
      src={silenceGatewayLogo.url}
      alt={alt}
      className={cn("select-none object-contain", className)}
      draggable={false}
    />
  );
}
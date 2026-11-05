/** The Onixus mark (from the brand logo, public/onixus-mark.png). */
export function OnixusLogo({ className = "logo" }: { className?: string }) {
  return <img className={className} src="/onixus-mark.png" alt="" width={30} height={30} decoding="async" />;
}

/** The Onixus TMS logo (mark, ONIXUS wordmark and TMS), for the sign-in screen. White wordmark: dark backgrounds only. */
export function OnixusWordmark() {
  return <h1 className="auth-logo-title"><img className="auth-logo" src="/onixus-tms-logo.png" alt="Onixus TMS" width={220} height={130} decoding="async" /></h1>;
}

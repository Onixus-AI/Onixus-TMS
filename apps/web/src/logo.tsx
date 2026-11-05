/** The Onixus mark (from the brand logo, public/onixus-mark.png). */
export function OnixusLogo({ className = "logo" }: { className?: string }) {
  return <img className={className} src="/onixus-mark.png" alt="" width={30} height={30} decoding="async" />;
}

/** The full Onixus logo with its wordmark, for the sign-in screen (white wordmark: dark backgrounds only). */
export function OnixusWordmark() {
  return <img className="auth-logo" src="/onixus-logo.png" alt="Onixus" width={160} height={123} decoding="async" />;
}

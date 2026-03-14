import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "CodeLive — AI Pair Programmer",
  description: "Real-time voice + vision coding assistant powered by Gemini Live",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { SessionProvider } from "@/components/providers/session-provider";
import { VisitorIdentity } from "@/components/providers/visitor-identity";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Leafwright",
    template: "%s · Leafwright",
  },
  description: "Houseplants, planters, and plant-care goods from independent nurseries.",
};

/**
 * Queues the analytics agent and starts an anonymous visit while the document is parsed, before
 * any app code runs. `VisitorIdentity` identifies the user once they are signed in.
 */
const ANALYTICS_AGENT_SNIPPET = `(function(apiKey){
    (function(p,e,n,d,o){var v,w,x,y,z;o=p[d]=p[d]||{};o._q=o._q||[];
    v=['initialize','identify','updateOptions','pageLoad','track', 'trackAgent'];for(w=0,x=v.length;w<x;++w)(function(m){
    o[m]=o[m]||function(){o._q[m===v[0]?'unshift':'push']([m].concat([].slice.call(arguments,0)));};})(v[w]);
    y=e.createElement(n);y.async=!0;y.src='https://cdn.pendo-dev.pendo-dev.com/agent/static/'+apiKey+'/pendo.js';
    z=e.getElementsByTagName(n)[0];z.parentNode.insertBefore(y,z);})(window,document,'script','pendo');
})('9d0f48b4-bcda-43a6-95c8-af3e93f2169a');
pendo.initialize({ visitor: { id: '' }, agentWorkflows: { manifestUrl: 'https://pendo-dev-static-5858750224400384.storage.googleapis.com/agent-workflows/-323232/manifest.json' } });
(function loadAgentWorkflows() {
  if (window.pendo && typeof window.pendo.addExtension === 'function') {
    var s = document.createElement('script');
    s.src = '/agent-workflows.js';
    document.head.appendChild(s);
  } else {
    setTimeout(loadAgentWorkflows, 50);
  }
})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: ANALYTICS_AGENT_SNIPPET }} />
      </head>
      <body className="flex min-h-full flex-col">
        <SessionProvider>{children}</SessionProvider>
        <Suspense>
          <VisitorIdentity />
        </Suspense>
      </body>
    </html>
  );
}

import { Outlet, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { SlidersVertical } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";

export function AppShell() {
  const { pathname } = useLocation();
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#mixer"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to mixer
      </a>
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-12 w-full max-w-[1400px] items-center gap-2 px-4">
          <SlidersVertical className="size-5 text-primary" aria-hidden="true" />
          <span className="font-semibold">Xone96 Mixer Emulator</span>
        </div>
      </header>
      <main className="flex flex-1 flex-col">
        <motion.div
          key={pathname}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="flex-1"
        >
          <Outlet />
        </motion.div>
      </main>
      <Toaster />
    </div>
  );
}

export default AppShell;
